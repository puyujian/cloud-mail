import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { dbInit } from '../src/init/init';
import settingService from '../src/service/setting-service';
import KvConst from '../src/const/kv-const';
import { makeCtx, patchSetting, readSettingKv, refreshSetting, runLegacySchema, settingColumnNames } from './helpers/db';

const SYNC_COLUMNS = [
	'sync_clipboard_status',
	'sync_clipboard_url',
	'sync_clipboard_username',
	'sync_clipboard_password',
	'sync_clipboard_mode',
	'sync_clipboard_emails',
	'sync_clipboard_retry',
	'sync_clipboard_timeout'
];

async function dropSyncColumns() {
	const existing = new Set(await settingColumnNames(env));

	for (const column of SYNC_COLUMNS) {
		if (existing.has(column)) {
			await env.db.prepare(`ALTER TABLE setting DROP COLUMN ${column}`).run();
		}
	}
}

async function columnInfo() {
	const { results } = await env.db.prepare(
		`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('setting') WHERE name LIKE 'sync_clipboard%'`
	).all();
	return results || [];
}

/** 伪造 env：pragma 首次返回空、之后返回指定列（模拟并发迁移刚补上同列） */
function fakeEnv({ alterError, recheckColumns }) {
	let pragmaCalls = 0;
	return {
		db: {
			prepare(sql) {
				if (sql.includes('pragma_table_info')) {
					return {
						all: async () => ({ results: pragmaCalls++ === 0 ? [] : recheckColumns })
					};
				}
				return {
					run: async () => {
						throw alterError;
					}
				};
			}
		}
	};
}

beforeAll(async () => {
	await runLegacySchema(env);
});

beforeEach(async () => {
	// 每例都从「缺列」状态开始，保证顺序无关
	await dbInit.v3_4DB(makeCtx(env));
	await dropSyncColumns();
});

describe('数据库升级：旧库 → v3.4（SyncClipboard 字段）', () => {

	it('旧库（无 sync_clipboard_* 列）确实缺列', async () => {
		const columns = await settingColumnNames(env);
		expect(columns).not.toContain('sync_clipboard_status');
		expect(columns).not.toContain('sync_clipboard_password');
	});

	it('迁移后补齐 8 列，默认关闭且默认值符合预期', async () => {
		await dbInit.v3_4DB(makeCtx(env));

		const columns = await settingColumnNames(env);
		for (const column of SYNC_COLUMNS) {
			expect(columns).toContain(column);
		}

		const info = await columnInfo();
		expect(info).toHaveLength(8);

		const byName = Object.fromEntries(info.map(row => [row.name, row]));
		expect(byName.sync_clipboard_status.dflt_value).toBe('1'); // 默认关闭
		expect(byName.sync_clipboard_mode.dflt_value).toBe('0');
		expect(byName.sync_clipboard_retry.dflt_value).toBe('2');
		expect(byName.sync_clipboard_timeout.dflt_value).toBe('5000');
		expect(byName.sync_clipboard_url.dflt_value).toBe("''");
		expect(byName.sync_clipboard_password.dflt_value).toBe("''");
		expect(info.every(row => row.notnull === 1)).toBe(true);
	});

	it('已有行在补列后取到默认值（功能默认关闭）', async () => {
		await dbInit.v3_4DB(makeCtx(env));

		const row = await env.db.prepare(
			`SELECT sync_clipboard_status, sync_clipboard_url, sync_clipboard_username, sync_clipboard_password,
			        sync_clipboard_mode, sync_clipboard_emails, sync_clipboard_retry, sync_clipboard_timeout
			 FROM setting LIMIT 1`
		).first();

		expect(row).toEqual({
			sync_clipboard_status: 1,
			sync_clipboard_url: '',
			sync_clipboard_username: '',
			sync_clipboard_password: '',
			sync_clipboard_mode: 0,
			sync_clipboard_emails: '',
			sync_clipboard_retry: 2,
			sync_clipboard_timeout: 5000
		});
	});

	it('半升级（部分列已存在）可恢复，且不覆盖已写入的值', async () => {
		// 手工补 2 列并写入配置，模拟上次迁移中途失败
		await env.db.prepare(`ALTER TABLE setting ADD COLUMN sync_clipboard_url TEXT NOT NULL DEFAULT ''`).run();
		await env.db.prepare(`ALTER TABLE setting ADD COLUMN sync_clipboard_username TEXT NOT NULL DEFAULT ''`).run();
		await patchSetting(env, { syncClipboardUrl: 'https://sync.example.com', syncClipboardUsername: 'admin' });

		await dbInit.v3_4DB(makeCtx(env));

		const columns = await settingColumnNames(env);
		for (const column of SYNC_COLUMNS) {
			expect(columns).toContain(column);
		}

		const row = await env.db.prepare('SELECT sync_clipboard_url, sync_clipboard_username, sync_clipboard_status FROM setting LIMIT 1').first();
		expect(row.sync_clipboard_url).toBe('https://sync.example.com');
		expect(row.sync_clipboard_username).toBe('admin');
		expect(row.sync_clipboard_status).toBe(1);
	});

	it('重复执行安全（幂等）', async () => {
		await dbInit.v3_4DB(makeCtx(env));
		await dbInit.v3_4DB(makeCtx(env));
		await dbInit.v3_4DB(makeCtx(env));

		const info = await columnInfo();
		expect(info).toHaveLength(8);
	});

	it('KV 刷新兼容：refresh 后新字段进入 KV', async () => {
		await dbInit.v3_4DB(makeCtx(env));
		await refreshSetting(env);

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardStatus).toBe(1);
		expect(kv.syncClipboardRetry).toBe(2);
		expect(kv.syncClipboardTimeout).toBe(5000);
		expect(kv.syncClipboardUrl).toBe('');
		expect(kv.syncClipboardPassword).toBe('');
	});

	it('KV 里缺新字段（未刷新）时按默认关闭处理，不会误开', async () => {
		await dbInit.v3_4DB(makeCtx(env));

		const legacyKv = { ...(await readSettingKv(env)) };
		delete legacyKv.syncClipboardStatus;
		delete legacyKv.syncClipboardUrl;
		await env.kv.put(KvConst.SETTING, JSON.stringify(legacyKv));

		const config = await settingService.getSyncClipboard(makeCtx(env));
		expect(config.status).toBe(1);
		expect(config.url).toBe('');
		expect(config.retry).toBe(2);
	});
});

describe('数据库升级：真实异常不被吞', () => {

	it('ALTER 失败且列仍缺失时上抛原始错误', async () => {
		const failing = fakeEnv({ alterError: new Error('D1_ERROR: disk I/O error'), recheckColumns: [] });

		await expect(dbInit.v3_4DB({ env: failing })).rejects.toThrowError('disk I/O error');
	});

	it('并发迁移已补同列（duplicate column）时容错继续', async () => {
		const racing = fakeEnv({
			alterError: new Error('D1_ERROR: duplicate column name: sync_clipboard_status'),
			recheckColumns: [{ name: 'sync_clipboard_status' }]
		});

		await expect(dbInit.addSettingColumns({ env: racing }, {
			sync_clipboard_status: 'INTEGER NOT NULL DEFAULT 1'
		})).resolves.toBeUndefined();
	});
});

describe('在线升级路径 /api/init/:secret', () => {

	it('密钥不匹配时拒绝执行迁移', async () => {
		await dropSyncColumns();

		const res = await SELF.fetch('http://example.com/api/init/wrong-secret');
		expect(await res.text()).toContain('JWT secret mismatch');

		expect(await settingColumnNames(env)).not.toContain('sync_clipboard_status');
	});

	it('密钥正确时完成迁移并刷新 KV，且默认关闭', async () => {
		await dropSyncColumns();

		const res = await SELF.fetch('http://example.com/api/init/local-test-jwt-secret');
		expect(await res.text()).toBe('success');

		const columns = await settingColumnNames(env);
		for (const column of SYNC_COLUMNS) {
			expect(columns).toContain(column);
		}

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardStatus).toBe(1);
		expect(kv.syncClipboardUrl).toBe('');
	});
});
