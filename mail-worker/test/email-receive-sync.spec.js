import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, beforeEach, describe, it, expect } from 'vitest';
import { email as handleEmail } from '../src/email/email';
import { emailConst, settingConst } from '../src/const/entity-const';
import { patchSetting, readSettingRow, refreshSetting, runLegacySchema, runSyncClipboardMigration } from './helpers/db';

const ORIGIN = 'https://sync.example.com';
const PROFILE_PATH = '/SyncClipboard.json';

// 本文件不调用 fetchMock.assertNoPendingInterceptors()：
// 需要“确定没有发起请求”的用例，用 console.error 捕获来证明（禁网后任何尝试都会产生失败日志）。
let logs = [];
let originalError = null;

const aiStub = {
	code: '012345',
	calls: 0,
	async run() {
		aiStub.calls++;
		return { response: JSON.stringify({ code: aiStub.code }) };
	}
};

function testEnv(overrides = {}) {
	return { ...env, ai: aiStub, ...overrides };
}

function buildRaw({ to, from = 'Service <service@example.com>', subject = 'Your code', messageId, body = 'Your verification code is 012345' }) {
	return new TextEncoder().encode([
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: ${messageId}`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8',
		'',
		body,
		''
	].join('\r\n'));
}

async function deliverEmail(options, envOverrides = {}) {
	const state = { rejected: null, forwarded: [] };
	const message = {
		to: options.to,
		raw: new Response(buildRaw(options)).body,
		setReject(reason) {
			state.rejected = reason;
		},
		async forward(address) {
			state.forwarded.push(address);
		}
	};

	const pending = [];
	const ctx = {
		waitUntil(promise) {
			pending.push(promise);
		},
		passThroughOnException() {
		}
	};

	await handleEmail(message, testEnv(envOverrides), ctx);
	await Promise.all(pending);

	return state;
}

/** 注册 PUT 拦截器序列；数量必须与实际请求数一致，afterEach 会校验全部被消费 */
function mockProfilePut(statuses = [200]) {
	const bodies = [];
	let dispatched = 0;

	for (const status of statuses) {
		fetchMock.get(ORIGIN)
			.intercept({
				path: PROFILE_PATH,
				method: 'PUT',
				body: (body) => {
					bodies.push(body);
					return true;
				}
			})
			.reply(() => {
				dispatched++;
				return { statusCode: status, data: '' };
			});
	}

	return {
		bodies,
		requests: () => dispatched,
		uniqueBodies: () => Array.from(new Set(bodies))
	};
}

async function latestEmailRow() {
	return await env.db.prepare('SELECT email_id, code, status, to_email, message_id FROM email ORDER BY email_id DESC LIMIT 1').first();
}

async function countEmailRows() {
	const row = await env.db.prepare('SELECT COUNT(*) AS total FROM email').first();
	return row.total;
}

function syncLogs() {
	return logs.filter(line => line.includes('SyncClipboard'));
}

async function resetMailSetting(patch = {}) {
	await patchSetting(env, {
		receive: settingConst.receive.OPEN,
		noRecipient: settingConst.noRecipient.OPEN,
		aiCode: settingConst.aiCode.OPEN,
		aiCodeFilter: '',
		blackSubject: '',
		blackContent: '',
		blackFrom: '',
		tgBotStatus: settingConst.tgBotStatus.CLOSE,
		forwardStatus: settingConst.forwardStatus.CLOSE,
		webhookStatus: settingConst.webhookStatus.CLOSE,
		ruleType: settingConst.ruleType.ALL,
		ruleEmail: '',
		syncClipboardStatus: settingConst.syncClipboardStatus.CLOSE,
		syncClipboardUrl: '',
		syncClipboardUsername: '',
		syncClipboardPassword: '',
		syncClipboardMode: settingConst.syncClipboardMode.ALL,
		syncClipboardEmails: '',
		syncClipboardRetry: 0,
		syncClipboardTimeout: 5000,
		...patch
	});
	await refreshSetting(env);
}

function enableSync(patch = {}) {
	return {
		syncClipboardStatus: settingConst.syncClipboardStatus.OPEN,
		syncClipboardUrl: ORIGIN,
		syncClipboardUsername: 'admin',
		syncClipboardPassword: 'secret123',
		...patch
	};
}

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	await runLegacySchema(env);
	await runSyncClipboardMigration(env);

	// 管理员用户 + 已注册收件箱
	await env.db.prepare(`INSERT INTO user (user_id, email, type, password, salt, status, is_del) VALUES (1, 'admin@example.com', 1, 'x', 'y', 0, 0)`).run();
	await env.db.prepare(`INSERT INTO account (email, status, user_id, is_del) VALUES ('admin@example.com', 0, 1, 0)`).run();

	// 非管理员用户：角色限定域名，用于权限拒收用例
	await env.db.prepare(`INSERT INTO role (role_id, name, avail_domain, ban_email, send_type, account_count) VALUES (2, 'limited', 'other.com', '', 'count', 10)`).run();
	await env.db.prepare(`INSERT INTO user (user_id, email, type, password, salt, status, is_del) VALUES (2, 'user@example.com', 2, 'x', 'y', 0, 0)`).run();
	await env.db.prepare(`INSERT INTO account (email, status, user_id, is_del) VALUES ('user@example.com', 0, 2, 0)`).run();
});

beforeEach(async () => {
	logs = [];
	originalError = console.error;
	console.error = (...args) => logs.push(args.map(String).join(' '));
	aiStub.calls = 0;
	await env.db.prepare('DELETE FROM email').run();
	await resetMailSetting();
});

afterEach(() => {
	if (originalError) {
		console.error = originalError;
	}
	// 注册的拦截器必须被消费：即“该发就必须发”
	fetchMock.assertNoPendingInterceptors();
});

describe('收信 → SyncClipboard 同步', () => {

	it('开启后：写入当前剪贴板并落库邮件', async () => {
		await resetMailSetting(enableSync());
		const { requests, uniqueBodies } = mockProfilePut([200]);

		const state = await deliverEmail({
			to: 'admin@example.com',
			messageId: '<m-basic@example.com>'
		});

		expect(state.rejected).toBeNull();
		expect(requests()).toBe(1);

		const body = JSON.parse(uniqueBodies()[0]);
		expect(body.type).toBe('Text');
		expect(body.text).toBe('012345');
		expect(body.size).toBe(6);
		expect(body.hasData).toBe(false);
		expect(body.dataName).toBeNull();
		expect(body.hash).toBe('2224512EF44A62E580BB1C0DCB33AFF688F4E7DA8A488AEB4E7CA402C5CACF45'); // SHA256("012345")

		const row = await latestEmailRow();
		expect(row.code).toBe('012345');
		expect(row.status).toBe(emailConst.status.RECEIVE);
	});

	it('保留前导零（AI 提取到 007）', async () => {
		await resetMailSetting(enableSync());
		const { uniqueBodies } = mockProfilePut([200]);
		aiStub.code = '007';

		try {
			await deliverEmail({ to: 'admin@example.com', messageId: '<m-zero@example.com>' });
		} finally {
			aiStub.code = '012345';
		}

		const body = JSON.parse(uniqueBodies()[0]);
		expect(body.text).toBe('007');
		expect(body.size).toBe(3);
	});

	it('未注册收件箱但允许接收（noRecipient=OPEN）同样同步', async () => {
		await resetMailSetting(enableSync({ syncClipboardMode: settingConst.syncClipboardMode.ALL }));
		const { requests } = mockProfilePut([200]);

		const state = await deliverEmail({
			to: 'ghost@example.com',
			messageId: '<m-ghost@example.com>'
		});

		expect(state.rejected).toBeNull();
		expect(requests()).toBe(1);

		const row = await latestEmailRow();
		expect(row.status).toBe(emailConst.status.NOONE);
		expect(row.to_email).toBe('ghost@example.com');
	});

	it('指定收件邮箱模式：名单外收件箱不触发', async () => {
		await resetMailSetting(enableSync({
			syncClipboardMode: settingConst.syncClipboardMode.SELECTED,
			syncClipboardEmails: 'admin@example.com'
		}));

		const state = await deliverEmail({ to: 'ghost@example.com', messageId: '<m-filtered@example.com>' });

		expect(state.rejected).toBeNull();
		expect(await countEmailRows()).toBe(1);
		expect(syncLogs()).toHaveLength(0);
	});

	it('关闭时完全不触发（默认关闭）', async () => {
		const state = await deliverEmail({ to: 'admin@example.com', messageId: '<m-off@example.com>' });

		expect(state.rejected).toBeNull();
		expect(await countEmailRows()).toBe(1);
		expect(syncLogs()).toHaveLength(0);
	});
});

describe('拒收路径完全不触发（原有检查保持生效）', () => {

	it('noRecipient=CLOSE 且未注册收件箱 → 拒收且无邮件、无请求', async () => {
		await resetMailSetting(enableSync({ noRecipient: settingConst.noRecipient.CLOSE }));

		const state = await deliverEmail({ to: 'ghost@example.com', messageId: '<m-reject@example.com>' });

		expect(state.rejected).toBeTruthy();
		expect(await countEmailRows()).toBe(0);
		expect(syncLogs()).toHaveLength(0);
	});

	it('黑名单发件人 → 拒收且无请求', async () => {
		await resetMailSetting(enableSync({ blackFrom: 'example.com' }));

		const state = await deliverEmail({ to: 'admin@example.com', messageId: '<m-black@example.com>' });

		expect(state.rejected).toBeTruthy();
		expect(await countEmailRows()).toBe(0);
		expect(syncLogs()).toHaveLength(0);
	});

	it('收件域名不在角色允许范围 → 拒收且无请求', async () => {
		await resetMailSetting(enableSync());

		const state = await deliverEmail({ to: 'user@example.com', messageId: '<m-domain@example.com>' });

		expect(state.rejected).toBeTruthy();
		expect(await countEmailRows()).toBe(0);
		expect(syncLogs()).toHaveLength(0);
	});

	it('receive 全局关闭 → 拒收且无请求', async () => {
		await resetMailSetting(enableSync({ receive: settingConst.receive.CLOSE }));

		const state = await deliverEmail({ to: 'admin@example.com', messageId: '<m-suspended@example.com>' });

		expect(state.rejected).toBeTruthy();
		expect(await countEmailRows()).toBe(0);
		expect(syncLogs()).toHaveLength(0);
	});
});

describe('与 AI 提取 / 旧转发规则的关系', () => {

	it('aiCode 关闭时验证码为空 → 不触发同步，但邮件正常落库', async () => {
		await resetMailSetting(enableSync({ aiCode: settingConst.aiCode.CLOSE }));

		await deliverEmail({ to: 'admin@example.com', messageId: '<m-noai@example.com>' });

		expect(aiStub.calls).toBe(0);
		expect(await countEmailRows()).toBe(1);
		expect(syncLogs()).toHaveLength(0);
	});

	it('aiCodeFilter 不匹配发件人时验证码为空 → 不触发同步', async () => {
		await resetMailSetting(enableSync({ aiCodeFilter: 'other.com' }));

		await deliverEmail({ to: 'admin@example.com', messageId: '<m-filter-ai@example.com>' });

		expect(aiStub.calls).toBe(0);
		expect(syncLogs()).toHaveLength(0);
	});

	it('ruleType=RULE 且收件箱不在转发名单内，仍会同步（与旧转发规则解耦）', async () => {
		await resetMailSetting(enableSync({
			ruleType: settingConst.ruleType.RULE,
			ruleEmail: 'someone-else@example.com'
		}));
		const { requests } = mockProfilePut([200]);

		await deliverEmail({ to: 'admin@example.com', messageId: '<m-rule@example.com>' });

		expect(requests()).toBe(1);
	});

	it('TG / webhook / 邮件转发全关时不产生额外请求', async () => {
		await resetMailSetting(enableSync());
		const { requests } = mockProfilePut([200]);

		const state = await deliverEmail({ to: 'admin@example.com', messageId: '<m-solo@example.com>' });

		expect(requests()).toBe(1);
		expect(state.forwarded).toHaveLength(0);
	});
});

describe('重复投递与失败隔离', () => {

	it('同一 messageId 重复投递只写一次剪贴板', async () => {
		await resetMailSetting(enableSync());
		const { requests } = mockProfilePut([200]);

		await deliverEmail({ to: 'admin@example.com', messageId: '<m-dup@example.com>' });
		await deliverEmail({ to: 'admin@example.com', messageId: '<m-dup@example.com>' });

		expect(requests()).toBe(1);
		expect(await countEmailRows()).toBe(2);
	});

	it('目标 5xx：收信不受影响、邮件仍落库、无去重标记', async () => {
		await resetMailSetting(enableSync());
		mockProfilePut([500]);

		await deliverEmail({ to: 'admin@example.com', messageId: '<m-500@example.com>' });

		const row = await latestEmailRow();
		expect(row.status).toBe(emailConst.status.RECEIVE);
		expect(row.code).toBe('012345');

		// 失败日志只含固定原因，不含验证码
		const failed = syncLogs();
		expect(failed.length).toBeGreaterThan(0);
		expect(failed.join('\n')).toContain('reason=retryable');
		expect(failed.join('\n')).not.toContain('012345');
	});
});
