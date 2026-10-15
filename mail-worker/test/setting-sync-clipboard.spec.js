import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import settingService from '../src/service/setting-service';
import syncClipboardService from '../src/service/sync-clipboard-service';
import { settingConst } from '../src/const/entity-const';
import {
	makeCtx,
	patchSetting,
	readSettingKv,
	readSettingRow,
	refreshSetting,
	runLegacySchema,
	runSyncClipboardMigration
} from './helpers/db';

const URL_OK = 'https://sync.example.com';
const BASIC_SAVED = 'Basic ' + btoa('admin:stored-pw-123');

// 每例复位：默认关闭、空配置（避免用例间互相污染共享的本地 D1/KV）
async function resetSyncSetting() {
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
}

async function seedEnabled(overrides = {}) {
	await resetSyncSetting();
	await settingService.setSyncClipboard(makeCtx(env), {
		status: settingConst.syncClipboardStatus.OPEN,
		url: URL_OK,
		username: 'admin',
		password: 'stored-pw-123',
		mode: settingConst.syncClipboardMode.ALL,
		...overrides
	});
}

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await runLegacySchema(env);
	await runSyncClipboardMigration(env);
});

beforeEach(async () => {
	await resetSyncSetting();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('读取配置（脱敏）', () => {

	it('默认：关闭 + 不泄露密码（只回传 hasPassword）', async () => {
		const data = await settingService.getSyncClipboard(makeCtx(env));

		expect(data).toEqual({
			status: settingConst.syncClipboardStatus.CLOSE,
			url: '',
			username: '',
			hasPassword: false,
			mode: settingConst.syncClipboardMode.ALL,
			emails: '',
			retry: 2,
			timeout: 5000
		});
		expect(Object.keys(data)).not.toContain('password');
	});

	it('保存后 hasPassword=true 且仍不回传密码', async () => {
		await seedEnabled();

		const data = await settingService.getSyncClipboard(makeCtx(env));

		expect(data.status).toBe(settingConst.syncClipboardStatus.OPEN);
		expect(data.url).toBe(URL_OK);
		expect(data.username).toBe('admin');
		expect(data.hasPassword).toBe(true);
		expect(JSON.stringify(data)).not.toContain('stored-pw-123');
	});
});

describe('保存配置（write-only 密码语义）', () => {

	it('首次保存写入全部字段并刷新 KV', async () => {
		await settingService.setSyncClipboard(makeCtx(env), {
			status: 0,
			url: URL_OK,
			username: 'admin',
			password: 'stored-pw-123',
			mode: 0,
			emails: '',
			retry: 1,
			timeout: 8000
		});

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardStatus).toBe(0);
		expect(kv.syncClipboardUrl).toBe(URL_OK);
		expect(kv.syncClipboardUsername).toBe('admin');
		expect(kv.syncClipboardPassword).toBe('stored-pw-123');
		expect(kv.syncClipboardRetry).toBe(1);
		expect(kv.syncClipboardTimeout).toBe(8000);
	});

	it('密码留空 = 保留旧值（不回显也不清空）', async () => {
		await seedEnabled();

		await settingService.setSyncClipboard(makeCtx(env), { url: 'https://sync2.example.com', password: '' });
		await settingService.setSyncClipboard(makeCtx(env), { username: 'admin2' });

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardPassword).toBe('stored-pw-123');
		expect(kv.syncClipboardUrl).toBe('https://sync2.example.com');
		expect(kv.syncClipboardUsername).toBe('admin2');
	});

	it('clearPassword=true 明确清除（先关闭同步）', async () => {
		await seedEnabled();

		await settingService.setSyncClipboard(makeCtx(env), {
			status: settingConst.syncClipboardStatus.CLOSE,
			clearPassword: true
		});

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardPassword).toBe('');
		expect(kv.syncClipboardStatus).toBe(settingConst.syncClipboardStatus.CLOSE);
	});

	it('password=null 等价于清除', async () => {
		await seedEnabled();

		await settingService.setSyncClipboard(makeCtx(env), {
			status: settingConst.syncClipboardStatus.CLOSE,
			password: null
		});

		expect((await readSettingKv(env)).syncClipboardPassword).toBe('');
	});

	it('仍处于开启状态时清除密码 → 拒绝且不落库', async () => {
		await seedEnabled();

		await expect(settingService.setSyncClipboard(makeCtx(env), { clearPassword: true }))
			.rejects.toThrowError();

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardPassword).toBe('stored-pw-123');
		expect(kv.syncClipboardStatus).toBe(settingConst.syncClipboardStatus.OPEN);
	});

	it('密码可包含冒号（协议取首个冒号之后全部），但不允许换行', async () => {
		await settingService.setSyncClipboard(makeCtx(env), {
			status: 0,
			url: URL_OK,
			username: 'admin',
			password: 'a:b:c',
			mode: 0
		});

		expect((await readSettingKv(env)).syncClipboardPassword).toBe('a:b:c');

		await expect(settingService.setSyncClipboard(makeCtx(env), { password: 'bad\r\nX-Injected: 1' }))
			.rejects.toThrowError();
		expect((await readSettingKv(env)).syncClipboardPassword).toBe('a:b:c');
	});
});

describe('严格取值校验（禁止静默回退/范围扩大）', () => {

	it('status 非法值一律拒绝且不落库', async () => {
		for (const bad of ['bad', 2, -1, 1.5, true, {}]) {
			await expect(settingService.setSyncClipboard(makeCtx(env), { status: bad }))
				.rejects.toThrowError();
		}

		expect((await readSettingKv(env)).syncClipboardStatus).toBe(settingConst.syncClipboardStatus.CLOSE);
	});

	it('mode 非法值不会把 selected 静默扩大为 all', async () => {
		await settingService.setSyncClipboard(makeCtx(env), {
			mode: settingConst.syncClipboardMode.SELECTED,
			emails: 'a@example.com'
		});
		expect((await readSettingKv(env)).syncClipboardMode).toBe(settingConst.syncClipboardMode.SELECTED);

		for (const bad of ['bad', 2, -1, true]) {
			await expect(settingService.setSyncClipboard(makeCtx(env), { mode: bad }))
				.rejects.toThrowError();
		}

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardMode).toBe(settingConst.syncClipboardMode.SELECTED);
		expect(kv.syncClipboardEmails).toBe('a@example.com');
	});

	it('数字字符串 "0"/"1" 视为合法', async () => {
		await settingService.setSyncClipboard(makeCtx(env), { status: '0', url: URL_OK, username: 'u', password: 'p' });
		expect((await readSettingKv(env)).syncClipboardStatus).toBe(0);
	});
});

describe('开启状态的前置条件', () => {

	it('开启但缺 URL / 用户名 / 密码 → 拒绝', async () => {
		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, username: 'u', password: 'p'
		})).rejects.toThrowError();

		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, url: URL_OK, password: 'p'
		})).rejects.toThrowError();

		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, url: URL_OK, username: 'u'
		})).rejects.toThrowError();

		expect((await readSettingKv(env)).syncClipboardStatus).toBe(settingConst.syncClipboardStatus.CLOSE);
	});

	it('用户名不能包含冒号或换行', async () => {
		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, url: URL_OK, username: 'a:b', password: 'p'
		})).rejects.toThrowError();

		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, url: URL_OK, username: 'a\nb', password: 'p'
		})).rejects.toThrowError();

		expect((await readSettingKv(env)).syncClipboardStatus).toBe(settingConst.syncClipboardStatus.CLOSE);
	});

	it('selected 模式开启时必须至少一个收件邮箱；关闭时允许空名单', async () => {
		await expect(settingService.setSyncClipboard(makeCtx(env), {
			status: 0, url: URL_OK, username: 'u', password: 'p',
			mode: settingConst.syncClipboardMode.SELECTED, emails: ''
		})).rejects.toThrowError();

		await settingService.setSyncClipboard(makeCtx(env), {
			status: settingConst.syncClipboardStatus.CLOSE,
			mode: settingConst.syncClipboardMode.SELECTED,
			emails: ''
		});

		expect((await readSettingKv(env)).syncClipboardMode).toBe(settingConst.syncClipboardMode.SELECTED);
	});

	it('URL 非法时拒绝保存', async () => {
		const badUrls = [
			'http://sync.example.com',
			'https://user:pass@sync.example.com',
			'https://127.0.0.1',
			'https://localhost',
			'https://sync.example.com/webdav'
		];

		for (const url of badUrls) {
			await expect(settingService.setSyncClipboard(makeCtx(env), { url })).rejects.toThrowError();
		}

		expect((await readSettingKv(env)).syncClipboardUrl).toBe('');
	});
});

describe('邮箱名单', () => {

	it('归一化：去空格、小写、去重（含中文逗号）', async () => {
		await settingService.setSyncClipboard(makeCtx(env), {
			mode: 1,
			emails: ' A@Example.com，b@example.com ,, a@example.com '
		});

		expect((await readSettingKv(env)).syncClipboardEmails).toBe('a@example.com,b@example.com');
	});

	it('非法邮箱拒绝保存', async () => {
		await expect(settingService.setSyncClipboard(makeCtx(env), { emails: 'not-an-email' }))
			.rejects.toThrowError();

		expect((await readSettingKv(env)).syncClipboardEmails).toBe('');
	});

	it('接受数组形式', async () => {
		await settingService.setSyncClipboard(makeCtx(env), { emails: ['a@example.com', 'b@example.com'] });
		expect((await readSettingKv(env)).syncClipboardEmails).toBe('a@example.com,b@example.com');
	});
});

describe('retry / timeout 钳制', () => {

	it('retry 0..3，timeout 1000..15000', async () => {
		await settingService.setSyncClipboard(makeCtx(env), { retry: 99, timeout: 999999 });
		let kv = await readSettingKv(env);
		expect(kv.syncClipboardRetry).toBe(3);
		expect(kv.syncClipboardTimeout).toBe(15000);

		await settingService.setSyncClipboard(makeCtx(env), { retry: -1, timeout: 1 });
		kv = await readSettingKv(env);
		expect(kv.syncClipboardRetry).toBe(0);
		expect(kv.syncClipboardTimeout).toBe(1000);
	});

	it('retry/timeout 非数字一律拒绝，不静默回退', async () => {
		await settingService.setSyncClipboard(makeCtx(env), { retry: 2, timeout: 5000 });

		await expect(settingService.setSyncClipboard(makeCtx(env), { retry: 'abc' })).rejects.toThrowError();
		await expect(settingService.setSyncClipboard(makeCtx(env), { timeout: 'abc' })).rejects.toThrowError();
		await expect(settingService.setSyncClipboard(makeCtx(env), { retry: {} })).rejects.toThrowError();

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardRetry).toBe(2);
		expect(kv.syncClipboardTimeout).toBe(5000);
	});
});

describe('脱敏不破坏原凭据 / 公开信息不泄露', () => {

	it('get() 返回脱敏副本，query() 仍拿到真实密码', async () => {
		await seedEnabled();

		const c = makeCtx(env);
		const masked = await settingService.get(c);

		expect(masked.hasSyncClipboardPassword).toBe(true);
		expect(masked.syncClipboardPassword).toBeUndefined();

		// 同一请求上下文里再 query（走缓存对象）也不能被掩码污染
		const raw = await settingService.query(makeCtx(env));
		expect(raw.syncClipboardPassword).toBe('stored-pw-123');
		expect((await readSettingKv(env)).syncClipboardPassword).toBe('stored-pw-123');
	});

	it('get() 不修改缓存里的 resendTokens 原值', async () => {
		await patchSetting(env, { resendTokens: JSON.stringify({ 'example.com': 're_abcdefghijklmnop' }) });
		await refreshSetting(env);

		const c = makeCtx(env);
		const masked = await settingService.get(c);
		expect(masked.resendTokens['example.com']).toContain('******');

		const raw = await settingService.query(makeCtx(env));
		expect(raw.resendTokens['example.com']).toBe('re_abcdefghijklmnop');
	});

	it('websiteConfig 不包含任何 SyncClipboard 字段', async () => {
		await seedEnabled();

		const config = await settingService.websiteConfig(makeCtx(env));
		const json = JSON.stringify(config);

		expect(json).not.toContain('syncClipboard');
		expect(json).not.toContain('SyncClipboard');
		expect(json).not.toContain(URL_OK);
		expect(json).not.toContain('stored-pw-123');
		expect(json).not.toContain('admin');
	});

	it('通用 /setting/set 无法修改 SyncClipboard 字段', async () => {
		await settingService.set(makeCtx(env), {
			syncClipboardStatus: 0,
			syncClipboardUrl: 'https://evil.example.com',
			syncClipboardPassword: 'evil',
			title: 'ok-title'
		});

		const kv = await readSettingKv(env);
		expect(kv.syncClipboardStatus).toBe(settingConst.syncClipboardStatus.CLOSE);
		expect(kv.syncClipboardUrl).toBe('');
		expect(kv.syncClipboardPassword).toBe('');
		expect(kv.title).toBe('ok-title');
	});
});

describe('只读测试连接', () => {

	it('使用已保存凭据 GET，绝不 PUT', async () => {
		await seedEnabled();

		fetchMock.get(URL_OK)
			.intercept({
				path: '/api/version',
				method: 'GET',
				headers: { authorization: BASIC_SAVED }
			})
			.reply(200, '"1.0.0"');

		const result = await settingService.testSyncClipboard(makeCtx(env), {});

		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
		expect(result.message).toBeTruthy();
	});

	it('可用请求内的临时凭据测试，但不落库', async () => {
		await seedEnabled();

		fetchMock.get('https://other.example.com')
			.intercept({
				path: '/api/version',
				method: 'GET',
				headers: { authorization: 'Basic ' + btoa('u2:p2') }
			})
			.reply(200, '');

		const result = await settingService.testSyncClipboard(makeCtx(env), {
			url: 'https://other.example.com',
			username: 'u2',
			password: 'p2'
		});

		expect(result.ok).toBe(true);
		expect((await readSettingKv(env)).syncClipboardUrl).toBe(URL_OK);
		expect((await readSettingKv(env)).syncClipboardPassword).toBe('stored-pw-123');
	});

	it('失败时返回可读消息与原因，且不含响应体', async () => {
		await seedEnabled();

		fetchMock.get(URL_OK)
			.intercept({ path: '/api/version', method: 'GET' })
			.reply(401, 'SECRET-BODY');

		const result = await settingService.testSyncClipboard(makeCtx(env), {});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('unauthorized');
		expect(JSON.stringify(result)).not.toContain('SECRET-BODY');
		expect(result.message).toBeTruthy();
	});

	it('URL 非法时不发请求', async () => {
		const result = await settingService.testSyncClipboard(makeCtx(env), { url: 'http://sync.example.com' });

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('url-not-https');
	});
});

describe('与同步服务的配置贯通', () => {

	it('保存后的配置能被 syncReceivedEmail 直接使用', async () => {
		await seedEnabled({ mode: settingConst.syncClipboardMode.SELECTED, emails: 'admin@example.com' });

		// KV 里的行是 camelCase（与运行时 query() 一致）
		const resolved = syncClipboardService.resolveConfig(await readSettingKv(env));

		expect(resolved.status).toBe(0);
		expect(resolved.url).toBe(URL_OK);
		expect(syncClipboardService.matchRecipient(resolved, 'admin@example.com')).toBe(true);
		expect(syncClipboardService.matchRecipient(resolved, 'other@example.com')).toBe(false);
	});
});
