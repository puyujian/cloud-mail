import { env } from 'cloudflare:test';
import { dbInit } from '../../src/init/init';
import settingService from '../../src/service/setting-service';
import KvConst from '../../src/const/kv-const';

/**
 * 测试用 D1/KV 辅助：
 * - 复用产品自身的迁移代码（init.js）建库，避免手写 DDL 与实体定义漂移
 * - 全部指向 miniflare 本地 D1/KV（wrangler-test-local.toml），不接触远端
 */

// init.js 里 v3_4DB 之前的历史迁移顺序（模拟一个已存在的旧库）
const LEGACY_MIGRATIONS = [
	'v1_1DB',
	'v1_2DB',
	'v1_3DB',
	'v1_3_1DB',
	'v1_4DB',
	'v1_5DB',
	'v1_6DB',
	'v1_7DB',
	'v2DB',
	'v2_3DB',
	'v2_4DB',
	'v2_5DB',
	'v2_6DB',
	'v2_7DB',
	'v2_8DB',
	'v2_9DB',
	'v3_0DB',
	'v3_1DB',
	'v3_2DB',
	'v3_3DB'
];

const SCHEMA_FLAG = 'test:schema:legacy-v3.3';

/** 最小 c 上下文：只有 settingService / dbInit 需要的 get/set/req */
export function makeCtx(targetEnv, extra = {}) {
	return {
		env: targetEnv,
		store: {},
		set(key, value) {
			this.store[key] = value;
		},
		get(key) {
			return this.store[key];
		},
		req: {
			header: (name) => (String(name).toLowerCase() === 'authorization' ? 'test.token.sig' : undefined)
		},
		...extra
	};
}

/** 建出「v3.3 旧库」结构（不含 SyncClipboard 列） */
export async function runLegacySchema(targetEnv = env) {
	if (await targetEnv.kv.get(SCHEMA_FLAG)) {
		return makeCtx(targetEnv);
	}

	const c = makeCtx(targetEnv);
	await dbInit.intDB(c);
	for (const name of LEGACY_MIGRATIONS) {
		await dbInit[name](c);
	}

	await targetEnv.kv.put(SCHEMA_FLAG, '1');
	return c;
}

/** 在旧库上执行本次新增迁移 */
export async function runSyncClipboardMigration(targetEnv = env) {
	await dbInit.v3_4DB(makeCtx(targetEnv));
}

export async function settingColumnNames(targetEnv = env) {
	const { results } = await targetEnv.db.prepare(`SELECT name FROM pragma_table_info('setting')`).all();
	return (results || []).map(row => row.name);
}

const toSnake = (key) => key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());

/** 按 camelCase 键更新 setting 表（测试内部常量，无外部输入） */
export async function patchSetting(targetEnv, patch) {
	const entries = Object.entries(patch);
	if (!entries.length) return;

	const assignments = entries.map(([key]) => `${toSnake(key)} = ?`).join(', ');
	const values = entries.map(([, value]) => value);

	await targetEnv.db.prepare(`UPDATE setting SET ${assignments}`).bind(...values).run();
}

/** 把 D1 的 setting 行刷进 KV（与 /init 收尾一致），并返回原始行 */
export async function refreshSetting(targetEnv = env) {
	await settingService.refresh(makeCtx(targetEnv));
	return await readSettingRow(targetEnv);
}

export async function readSettingRow(targetEnv = env) {
	return await targetEnv.db.prepare('SELECT * FROM setting LIMIT 1').first();
}

export async function readSettingKv(targetEnv = env) {
	return await targetEnv.kv.get(KvConst.SETTING, { type: 'json' });
}

/** 迁移 + 写入指定设置 + 刷新 KV，返回可直接用于 service 的 c */
export async function seedSetting(targetEnv = env, patch = {}) {
	await runLegacySchema(targetEnv);
	await runSyncClipboardMigration(targetEnv);
	await patchSetting(targetEnv, patch);
	const row = await refreshSetting(targetEnv);
	return { c: makeCtx(targetEnv), row };
}

/** 收信集成测试：插入管理员用户 + 收件箱，避免走 role 权限分支 */
export async function seedAdminAccount(targetEnv = env, { email = 'admin@example.com', userId = 1 } = {}) {
	await targetEnv.db.prepare(
		`INSERT INTO user (user_id, email, type, password, salt, status, is_del) VALUES (?, ?, 1, 'x', 'y', 0, 0)`
	).bind(userId, email).run();

	await targetEnv.db.prepare(
		`INSERT INTO account (email, status, user_id, is_del) VALUES (?, 0, ?, 0)`
	).bind(email, userId).run();

	return { userId, email };
}
