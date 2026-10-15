import { env, SELF, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';
import { settingConst } from '../src/const/entity-const';
import { patchSetting, readSettingKv, refreshSetting, runLegacySchema, runSyncClipboardMigration } from './helpers/db';

const ADMIN_EMAIL = 'admin@example.com';
const LIMITED_EMAIL = 'user@example.com';
const LIMITED_USER_ID = 2;
const ADMIN_USER_ID = 1;

const ADMIN_TOKEN = 'admin-token-1';
const LIMITED_TOKEN = 'limited-token-1';
const STALE_TOKEN = 'stale-token-1';

const BASIC = 'Basic ' + btoa('admin:secret123');

let adminJwt = '';
let limitedJwt = '';
let staleJwt = '';

async function authed(path, token, options = {}) {
	const res = await SELF.fetch(`http://example.com/api${path}`, {
		...options,
		headers: {
			...(token ? { Authorization: token } : {}),
			'content-type': 'application/json',
			...(options.headers || {})
		}
	});

	return await res.json();
}

async function putAuthInfo(userId, email, tokens) {
	await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({
		user: { userId, email },
		tokens,
		refreshTime: new Date().toISOString()
	}));
}

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();

	await runLegacySchema(env);
	await runSyncClipboardMigration(env);

	// 用户：1=管理员，2=普通用户（type=2 对应 role_id=2）
	await env.db.prepare(`INSERT OR REPLACE INTO user (user_id, email, type, password, salt, status, is_del) VALUES (?, ?, 1, 'x', 'y', 0, 0)`)
		.bind(ADMIN_USER_ID, ADMIN_EMAIL).run();
	await env.db.prepare(`INSERT OR REPLACE INTO user (user_id, email, type, password, salt, status, is_del) VALUES (?, ?, 2, 'x', 'y', 0, 0)`)
		.bind(LIMITED_USER_ID, LIMITED_EMAIL).run();
	await env.db.prepare(`INSERT OR REPLACE INTO role (role_id, name, avail_domain, ban_email, send_type, account_count) VALUES (2, 'limited', '', '', 'count', 10)`).run();

	// 权限点（init 已插入同名数据，这里显式确保存在）
	await env.db.prepare(`INSERT OR REPLACE INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES (18, '设置查看', 'setting:query', 17, 2, 0)`).run();
	await env.db.prepare(`INSERT OR REPLACE INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES (19, '设置修改', 'setting:set', 17, 2, 1)`).run();

	adminJwt = await jwtUtils.generateToken({ env }, { userId: ADMIN_USER_ID, token: ADMIN_TOKEN });
	limitedJwt = await jwtUtils.generateToken({ env }, { userId: LIMITED_USER_ID, token: LIMITED_TOKEN });
	staleJwt = await jwtUtils.generateToken({ env }, { userId: LIMITED_USER_ID, token: STALE_TOKEN });
});

beforeEach(async () => {
	await putAuthInfo(ADMIN_USER_ID, ADMIN_EMAIL, [ADMIN_TOKEN]);
	await putAuthInfo(LIMITED_USER_ID, LIMITED_EMAIL, [LIMITED_TOKEN]);

	await patchSetting(env, {
		syncClipboardStatus: settingConst.syncClipboardStatus.CLOSE,
		syncClipboardUrl: '',
		syncClipboardUsername: '',
		syncClipboardPassword: '',
		syncClipboardMode: settingConst.syncClipboardMode.ALL,
		syncClipboardEmails: '',
		syncClipboardRetry: 2,
		syncClipboardTimeout: 5000
	});
	await refreshSetting(env);
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('权限路由（HTTP 层）', () => {

	it('无 token → 401', async () => {
		for (const [path, method] of [
			['/setting/querySyncClipboard', 'GET'],
			['/setting/setSyncClipboard', 'PUT'],
			['/setting/testSyncClipboard', 'PUT']
		]) {
			const body = await authed(path, '', { method, body: method === 'PUT' ? '{}' : undefined });
			expect(body.code).toBe(401);
		}
	});

	it('伪造签名 / 已被登出的 token → 401', async () => {
		const forged = await authed('/setting/querySyncClipboard', 'a.b.c');
		expect(forged.code).toBe(401);

		// 签名有效但不在 KV tokens 列表中（登出/失效）
		const stale = await authed('/setting/querySyncClipboard', staleJwt);
		expect(stale.code).toBe(401);
	});

	it('管理员（无 role_perm）可读写', async () => {
		const query = await authed('/setting/querySyncClipboard', adminJwt);
		expect(query.code).toBe(200);

		const set = await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({ retry: 3 })
		});
		expect(set.code).toBe(200);
		expect(set.data.retry).toBe(3);
	});

	it('普通用户无权限 → 403', async () => {
		await env.db.prepare(`DELETE FROM role_perm WHERE role_id = 2`).run();

		for (const [path, method] of [
			['/setting/querySyncClipboard', 'GET'],
			['/setting/setSyncClipboard', 'PUT'],
			['/setting/testSyncClipboard', 'PUT']
		]) {
			const body = await authed(path, limitedJwt, { method, body: method === 'PUT' ? '{}' : undefined });
			expect(body.code).toBe(403);
		}
	});

	it('普通用户仅有 setting:query → 只读路由 200，写路由 403', async () => {
		await env.db.prepare(`DELETE FROM role_perm WHERE role_id = 2`).run();
		await env.db.prepare(`INSERT INTO role_perm (role_id, perm_id) VALUES (2, 18)`).run();

		const query = await authed('/setting/querySyncClipboard', limitedJwt);
		expect(query.code).toBe(200);

		const set = await authed('/setting/setSyncClipboard', limitedJwt, {
			method: 'PUT',
			body: JSON.stringify({ retry: 1 })
		});
		expect(set.code).toBe(403);

		const test = await authed('/setting/testSyncClipboard', limitedJwt, {
			method: 'PUT',
			body: JSON.stringify({})
		});
		expect(test.code).toBe(403);
	});

	it('普通用户有 setting:query + setting:set → 三条路由均放行', async () => {
		await env.db.prepare(`DELETE FROM role_perm WHERE role_id = 2`).run();
		await env.db.prepare(`INSERT INTO role_perm (role_id, perm_id) VALUES (2, 18)`).run();
		await env.db.prepare(`INSERT INTO role_perm (role_id, perm_id) VALUES (2, 19)`).run();

		expect((await authed('/setting/querySyncClipboard', limitedJwt)).code).toBe(200);
		expect((await authed('/setting/setSyncClipboard', limitedJwt, {
			method: 'PUT',
			body: JSON.stringify({ retry: 2 })
		})).code).toBe(200);

		const test = await authed('/setting/testSyncClipboard', limitedJwt, {
			method: 'PUT',
			body: JSON.stringify({ url: 'http://sync.example.com' })
		});
		expect(test.code).toBe(200);
		expect(test.data.ok).toBe(false);
		expect(test.data.reason).toBe('url-not-https');
	});
});

describe('接口不泄露与公开配置', () => {

	it('querySyncClipboard 永不回传密码（已配置密码时）', async () => {
		await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				status: 0,
				url: 'https://sync.example.com',
				username: 'admin',
				password: 'top-secret-pw',
				mode: 0
			})
		});

		const query = await authed('/setting/querySyncClipboard', adminJwt);
		const json = JSON.stringify(query);

		expect(query.data.hasPassword).toBe(true);
		expect(query.data.password).toBeUndefined();
		expect(json).not.toContain('top-secret-pw');
	});

	it('/setting/query 只回传 hasSyncClipboardPassword，不含密码', async () => {
		await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				status: 0,
				url: 'https://sync.example.com',
				username: 'admin',
				password: 'top-secret-pw',
				mode: 0
			})
		});

		const body = await authed('/setting/query', adminJwt);
		const json = JSON.stringify(body);

		expect(body.data.hasSyncClipboardPassword).toBe(true);
		expect(body.data.syncClipboardPassword).toBeUndefined();
		expect(json).not.toContain('top-secret-pw');

		// 掩码不能破坏真实凭据
		expect((await readSettingKv(env)).syncClipboardPassword).toBe('top-secret-pw');
	});

	it('公开接口 /setting/websiteConfig 不含任何 SyncClipboard 字段', async () => {
		await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				status: 0,
				url: 'https://sync.example.com',
				username: 'sync-user',
				password: 'top-secret-pw',
				mode: 0
			})
		});

		const body = await authed('/setting/websiteConfig', '');
		const json = JSON.stringify(body);

		expect(body.code).toBe(200);
		expect(json).not.toContain('SyncClipboard');
		expect(json).not.toContain('sync.example.com');
		expect(json).not.toContain('top-secret-pw');
		expect(json).not.toContain('sync-user');
	});
});

describe('只读测试连接：不写剪贴板、不改设置', () => {

	it('testSyncClipboard 只 GET，且不改动已保存配置', async () => {
		await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				status: 0,
				url: 'https://sync.example.com',
				username: 'admin',
				password: 'stored-pw',
				mode: 0,
				retry: 1
			})
		});

		const beforeKv = await readSettingKv(env);

		// 只注册 GET /api/version：任何 PUT 都会因禁网失败，导致 ok=false
		fetchMock.get('https://sync.example.com')
			.intercept({ path: '/api/version', method: 'GET', headers: { authorization: BASIC } })
			.reply(200, '"1.0.0"');

		const body = await authed('/setting/testSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				url: 'https://sync.example.com',
				username: 'admin',
				password: 'secret123'
			})
		});

		expect(body.code).toBe(200);
		expect(body.data.ok).toBe(true);
		expect(body.data.status).toBe(200);
		expect(JSON.stringify(body)).not.toContain('1.0.0');

		const afterKv = await readSettingKv(env);
		expect(afterKv.syncClipboardUrl).toBe(beforeKv.syncClipboardUrl);
		expect(afterKv.syncClipboardUsername).toBe(beforeKv.syncClipboardUsername);
		expect(afterKv.syncClipboardPassword).toBe('stored-pw');
		expect(afterKv.syncClipboardStatus).toBe(beforeKv.syncClipboardStatus);
	});

	it('测试失败不影响已保存配置', async () => {
		await authed('/setting/setSyncClipboard', adminJwt, {
			method: 'PUT',
			body: JSON.stringify({
				status: 0,
				url: 'https://sync.example.com',
				username: 'admin',
				password: 'stored-pw',
				mode: 0
			})
		});

		fetchMock.get('https://sync.example.com')
			.intercept({ path: '/api/version', method: 'GET' })
			.reply(401, 'SECRET-BODY');

		const body = await authed('/setting/testSyncClipboard', adminJwt, { method: 'PUT', body: JSON.stringify({}) });

		expect(body.data.ok).toBe(false);
		expect(body.data.reason).toBe('unauthorized');
		expect(JSON.stringify(body)).not.toContain('SECRET-BODY');

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardPassword).toBe('stored-pw');
		expect(kv.syncClipboardUrl).toBe('https://sync.example.com');
		expect(kv.syncClipboardStatus).toBe(settingConst.syncClipboardStatus.OPEN);
	});
});
