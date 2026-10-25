import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// 合并回归：上游的 v3_4DB（sender_email）与翻译表初始化必须共存、可重复执行，
// 且翻译 DDL 失败时 /api/init 必须如实返回 500（历史上静默吞错导致线上表缺失）
vi.mock('../src/service/setting-service.js', () => ({
	default: { refresh: async () => {} }
}));

const opened = [];

function open() {
	const sqlite = new DatabaseSync(':memory:');
	opened.push(sqlite);
	return sqlite;
}

afterEach(() => {
	for (const sqlite of opened.splice(0)) {
		try {
			sqlite.close();
		} catch (e) {
			// 已关闭就忽略
		}
	}
});

// D1 的 batch 是事务性的：任一条失败整批回滚。仿真必须保持这个语义，
// 否则测试会给出比线上更宽松的结论
function createD1(sqlite, hooks = {}) {
	function statement(sql, args) {
		return {
			async first() {
				const row = sqlite.prepare(sql).get(...args);
				return row ? Object.assign({}, row) : null;
			},
			async all() {
				const rows = sqlite.prepare(sql).all(...args);
				return { results: rows.map(row => Object.assign({}, row)) };
			},
			async run() {
				const info = sqlite.prepare(sql).run(...args);
				return { success: true, meta: info };
			}
		};
	}
	return {
		prepare(sql) {
			if (hooks.beforePrepare) hooks.beforePrepare(sql);
			return Object.assign(statement(sql, []), {
				bind(...args) {
					return statement(sql, args);
				}
			});
		},
		async batch(stmts) {
			const out = [];
			sqlite.exec('BEGIN');
			try {
				for (const stmt of stmts) out.push(await stmt.run());
				sqlite.exec('COMMIT');
				return out;
			} catch (e) {
				sqlite.exec('ROLLBACK');
				throw e;
			}
		}
	};
}

// 升级前的现状：1.0 时期的 email 表（没有 sender_email，翻译表和翻译权限也都没有）
// 后续每次版本升级都在这张表上 ALTER，只有这样才覆盖真实升级路径
function buildLegacy(hooks) {
	const sqlite = open();
	sqlite.exec(`CREATE TABLE email (
		email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
		send_email TEXT,
		name TEXT,
		account_id INTEGER NOT NULL DEFAULT 0,
		user_id INTEGER NOT NULL DEFAULT 0,
		subject TEXT,
		content TEXT,
		text TEXT,
		create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
		is_del INTEGER DEFAULT 0 NOT NULL,
		recipient TEXT NOT NULL DEFAULT '[]'
	)`);
	sqlite.exec(`CREATE TABLE perm (
		perm_id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		perm_key TEXT,
		pid INTEGER NOT NULL DEFAULT 0,
		type INTEGER NOT NULL DEFAULT 2,
		sort INTEGER
	)`);
	sqlite.exec(`INSERT INTO perm (name, perm_key, pid, type, sort) VALUES ('邮件删除', 'email:delete', 1, 2, 1)`);
	sqlite.exec(`INSERT INTO email (user_id, account_id, content, recipient)
		VALUES (1, 2, 'old-mail-body', '[{"address":"someone@example.com","name":"Someone"}]')`);
	return { sqlite, env: { db: createD1(sqlite, hooks) } };
}

const translationTables = [
	'email_translation',
	'email_translation_chunk',
	'translation_quota',
	'translation_rate'
];

function columns(sqlite, table) {
	return sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(row => row.name);
}

function tables(sqlite) {
	return sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
		.all().map(row => row.name);
}

// c.text(body) / c.text(body, status)，保留 status 才能断言 500
function context(env, secret = 'secret') {
	return {
		req: { param: () => secret },
		env: { ...env, jwt_secret: 'secret' },
		text: (body, status = 200) => ({ body, status })
	};
}

describe('init migration merge', () => {
	it('上游 v3_4DB 的 sender_email 与翻译表初始化并存', async () => {
		const { dbInit } = await import('../src/init/init.js');
		const { sqlite, env } = buildLegacy();
		const c = { env };

		await dbInit.v3_4DB(c);
		expect(columns(sqlite, 'email')).toContain('sender_email');

		const errors = await dbInit.initTranslationSchema(c);
		expect(errors).toEqual([]);

		const names = tables(sqlite);
		for (const table of translationTables) {
			expect(names).toContain(table);
		}

		const perm = sqlite.prepare(`SELECT COUNT(*) AS total FROM perm WHERE perm_key = 'email:translate'`).get();
		expect(perm.total).toBe(1);
	});

	it('两个新增步骤各自重复执行不报错、不重复插权限、不动已有数据', async () => {
		const { dbInit } = await import('../src/init/init.js');
		const { sqlite, env } = buildLegacy();
		const c = { env };

		await dbInit.v3_4DB(c);
		expect(await dbInit.initTranslationSchema(c)).toEqual([]);
		// 第二次跑：ALTER 会撞 duplicate column，但必须被吞掉，翻译表/权限也不重复
		await expect(dbInit.v3_4DB(c)).resolves.toBeUndefined();
		expect(await dbInit.initTranslationSchema(c)).toEqual([]);

		const perm = sqlite.prepare(`SELECT COUNT(*) AS total FROM perm WHERE perm_key = 'email:translate'`).get();
		expect(perm.total).toBe(1);

		const old = sqlite.prepare(`SELECT content, sender_email FROM email WHERE email_id = 1`).get();
		expect(old.content).toBe('old-mail-body');
		expect(old.sender_email).toBe('');
	});

	it('翻译 DDL 失败时返回失败原因而不是静默吞掉', async () => {
		const { dbInit } = await import('../src/init/init.js');
		const { env } = buildLegacy({
			beforePrepare(sql) {
				if (sql.includes('email_translation_chunk')) {
					throw new Error('D1_ERROR: near "(": syntax error');
				}
			}
		});

		const errors = await dbInit.initTranslationSchema({ env });
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some(message => message.startsWith('翻译表：'))).toBe(true);
	});

	it('/api/init 成功返回 200 success，迁移失败返回 500 并带出原因', async () => {
		const { dbInit } = await import('../src/init/init.js');

		// 成功路径走完整的 init()：两条迁移都必须落地
		const ok = buildLegacy();
		const okResponse = await dbInit.init(context(ok.env));
		expect(okResponse).toEqual({ body: 'success', status: 200 });
		expect(columns(ok.sqlite, 'email')).toContain('sender_email');
		const names = tables(ok.sqlite);
		for (const table of translationTables) {
			expect(names).toContain(table);
		}
		const perm = ok.sqlite.prepare(`SELECT COUNT(*) AS total FROM perm WHERE perm_key = 'email:translate'`).get();
		expect(perm.total).toBe(1);

		const bad = buildLegacy({
			beforePrepare(sql) {
				if (sql.includes('translation_quota')) {
					throw new Error('D1_ERROR: disk I/O error');
				}
			}
		});
		const badResponse = await dbInit.init(context(bad.env));
		expect(badResponse.status).toBe(500);
		expect(badResponse.body.startsWith('❌')).toBe(true);
		expect(badResponse.body).toContain('翻译表：');
	});

	it('jwt_secret 不匹配时不执行任何迁移', async () => {
		const { dbInit } = await import('../src/init/init.js');
		const { sqlite, env } = buildLegacy();

		const response = await dbInit.init(context(env, 'wrong'));
		expect(response.body).toContain('JWT secret mismatch');
		expect(tables(sqlite)).not.toContain('email_translation');
		expect(columns(sqlite, 'email')).not.toContain('sender_email');
	});
});
