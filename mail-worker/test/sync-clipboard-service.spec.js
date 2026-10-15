import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, afterEach, describe, it, expect } from 'vitest';
import syncClipboardService from '../src/service/sync-clipboard-service';
import { settingConst } from '../src/const/entity-const';

const PROFILE_PATH = '/SyncClipboard.json';
const VERSION_PATH = '/api/version';

// 固定向量（独立于被测实现计算）
const SHA256_123456 = '8D969EEF6ECAD3C29A3A629280E686CF0C3F5D5A86AFF3CA12020C923ADC6C92';
const SHA256_007 = '629F4CF9337B0D0C76F305D860F98894CFA8C279516B425747514CA8710DEB97';
const BASIC_ADMIN_SECRET123 = 'Basic YWRtaW46c2VjcmV0MTIz';

// 每个用例使用独立 origin：拦截器互不串扰，且用例失败不会污染后续用例
let originSeq = 0;
function nextOrigin() {
	originSeq++;
	return `https://sync-${originSeq}.example.com`;
}

function config(origin, overrides = {}) {
	return {
		status: settingConst.syncClipboardStatus.OPEN,
		url: origin,
		username: 'admin',
		password: 'secret123',
		mode: settingConst.syncClipboardMode.ALL,
		emails: '',
		retry: 0,
		timeout: 5000,
		...overrides
	};
}

function emailData(origin, overrides = {}) {
	return {
		config: config(origin),
		toEmail: 'admin@example.com',
		code: '123456',
		messageId: uniqueMessageId('base'),
		emailId: 11,
		...overrides
	};
}

function uniqueMessageId(tag) {
	return `<${tag}-${Date.now()}-${Math.random()}@example.com>`;
}

/** 注册 PUT 拦截器序列（数量必须与实际请求数一致，afterEach 会校验全部被消费） */
function mockProfilePut(origin, statuses, extra = {}) {
	const bodies = [];
	let dispatched = 0;

	for (const status of statuses) {
		fetchMock.get(origin)
			.intercept({
				path: PROFILE_PATH,
				method: 'PUT',
				body: (body) => {
					bodies.push(body);
					return true;
				},
				...extra
			})
			// reply 回调每次实际派发只执行一次 → 可靠的请求计数
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

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	// 注册的拦截器必须全部被消费：既能发现“多打了请求”，也能发现“该发没发”
	fetchMock.assertNoPendingInterceptors();
});

describe('SyncClipboard profile 构造（协议契约）', () => {

	it('生成 Text profile：大写 SHA256、hasData=false、dataName=null、size=字符数', async () => {
		const profile = await syncClipboardService.buildTextProfile('123456');

		expect(profile).toEqual({
			type: 'Text',
			hash: SHA256_123456,
			text: '123456',
			hasData: false,
			dataName: null,
			size: 6
		});
	});

	it('保留前导零且 hash 按原文计算', async () => {
		const profile = await syncClipboardService.buildTextProfile('007');

		expect(profile.text).toBe('007');
		expect(profile.hash).toBe(SHA256_007);
		expect(profile.size).toBe(3);
	});

	it('空串的 hash 为 SHA256("")（与服务端空 profile 语义一致）', async () => {
		const profile = await syncClipboardService.buildTextProfile('');

		expect(profile.hash).toBe('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855');
		expect(profile.size).toBe(0);
	});
});

describe('PUT /SyncClipboard.json 请求形状', () => {

	it('PUT 当前剪贴板：JSON body 正确且保留前导零', async () => {
		const origin = nextOrigin();
		const { uniqueBodies } = mockProfilePut(origin, [200]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			code: '007',
			messageId: uniqueMessageId('shape')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: true, reason: 'ok', status: 200 });

		const sent = uniqueBodies();
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0])).toEqual({
			type: 'Text',
			hash: SHA256_007,
			text: '007',
			hasData: false,
			dataName: null,
			size: 3
		});
	});

	it('Basic 头按 UTF-8 编码（与 CfServer atob→UTF-8 解码一致）', async () => {
		const origin = nextOrigin();

		// 仅当 Authorization 头精确匹配时拦截器才会命中，否则请求会因禁网而失败
		fetchMock.get(origin)
			.intercept({
				path: PROFILE_PATH,
				method: 'PUT',
				headers: { authorization: BASIC_ADMIN_SECRET123 }
			})
			.reply(200, '');

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			messageId: uniqueMessageId('auth')
		}), { sleep: async () => {} });

		expect(result.synced).toBe(true);
	});

	it('绝不读取目标响应体（不落日志/不缓存内容）', async () => {
		const origin = nextOrigin();
		fetchMock.get(origin)
			.intercept({ path: PROFILE_PATH, method: 'PUT' })
			.reply(200, 'SECRET-RESPONSE-BODY');

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			messageId: uniqueMessageId('nobody')
		}), { sleep: async () => {} });

		expect(JSON.stringify(result)).not.toContain('SECRET-RESPONSE-BODY');
	});
});

describe('触发条件与收件箱过滤', () => {

	it('默认关闭（status=CLOSE）时不发任何请求', async () => {
		const origin = nextOrigin();

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { status: settingConst.syncClipboardStatus.CLOSE })
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'disabled' });
	});

	it('空验证码不发送（aiCode 关闭 / 未识别）', async () => {
		const origin = nextOrigin();

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { code: '' }), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'empty-code' });
	});

	it('mode=all 时全站收件箱都同步', async () => {
		const origin = nextOrigin();
		mockProfilePut(origin, [200]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			toEmail: 'someone@example.com',
			messageId: uniqueMessageId('all')
		}), { sleep: async () => {} });

		expect(result.synced).toBe(true);
	});

	it('mode=selected 只同步名单内收件箱（大小写不敏感）', async () => {
		const origin = nextOrigin();
		const selected = config(origin, {
			mode: settingConst.syncClipboardMode.SELECTED,
			emails: 'a@example.com, b@example.com'
		});

		const filtered = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: selected,
			toEmail: 'c@example.com'
		}), { sleep: async () => {} });

		expect(filtered).toEqual({ synced: false, reason: 'filtered' });

		mockProfilePut(origin, [200]);
		const allowed = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: selected,
			toEmail: 'A@Example.com',
			messageId: uniqueMessageId('selected')
		}), { sleep: async () => {} });

		expect(allowed.synced).toBe(true);
	});

	it('地址非法时直接返回原因，不发起请求', async () => {
		const cases = [
			['http://sync.example.com', 'url-not-https'],
			['https://user:pass@sync.example.com', 'url-has-credentials'],
			['https://127.0.0.1', 'url-ip-not-supported'],
			['https://localhost', 'url-local-not-supported'],
			['https://sync.example.com/webdav', 'url-has-path'],
			['', 'url-empty']
		];

		for (const [url, reason] of cases) {
			const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(nextOrigin(), {
				config: config(url)
			}), { sleep: async () => {} });

			expect(result).toEqual({ synced: false, reason });
		}
	});
});

describe('去重（best effort）', () => {

	it('同一邮件（messageId+收件箱）重复投递只写一次', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [200]);
		const messageId = uniqueMessageId('dedupe');

		const first = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { messageId }), { sleep: async () => {} });
		const second = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { messageId }), { sleep: async () => {} });

		expect(first.synced).toBe(true);
		expect(second).toEqual({ synced: false, reason: 'deduped' });
		expect(requests()).toBe(1);
	});

	it('同码不同邮件（不同 messageId）允许各写一次', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [200, 200]);

		const first = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			code: '424242',
			messageId: uniqueMessageId('same-code-a')
		}), { sleep: async () => {} });

		const second = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			code: '424242',
			messageId: uniqueMessageId('same-code-b')
		}), { sleep: async () => {} });

		expect(first.synced).toBe(true);
		expect(second.synced).toBe(true);
		expect(requests()).toBe(2);
	});

	it('不同收件箱同一 messageId 视为不同邮件', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [200, 200]);
		const messageId = uniqueMessageId('multi-to');

		await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { messageId, toEmail: 'a@example.com' }), { sleep: async () => {} });
		await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { messageId, toEmail: 'b@example.com' }), { sleep: async () => {} });

		expect(requests()).toBe(2);
	});

	it('去重键与 KV 值都不包含验证码', async () => {
		const origin = nextOrigin();
		mockProfilePut(origin, [200]);
		const code = '998877';
		const messageId = uniqueMessageId('nokvcode');

		await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { code, messageId }), { sleep: async () => {} });

		const key = await syncClipboardService.buildDedupeKey({ messageId, toEmail: 'admin@example.com' });
		expect(key).not.toContain(code);

		const value = await env.kv.get(key);
		expect(value).toBe('11');
		expect(value).not.toContain(code);
	});

	it('写入失败时不留下去重标记（可重试）', async () => {
		const origin = nextOrigin();
		mockProfilePut(origin, [500]);
		const messageId = uniqueMessageId('failmark');

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, { messageId }), { sleep: async () => {} });

		expect(result.synced).toBe(false);

		const key = await syncClipboardService.buildDedupeKey({ messageId, toEmail: 'admin@example.com' });
		expect(await env.kv.get(key)).toBeNull();
	});
});

describe('重试与错误分类（有限、有界）', () => {

	it('5xx 有限重试后成功（500,500,200 → 3 次）', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [500, 500, 200]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 2 }),
			messageId: uniqueMessageId('retry-ok')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: true, reason: 'ok', status: 200 });
		expect(requests()).toBe(3);
	});

	it('401 不重试（仅 1 次请求）', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [401]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 3 }),
			messageId: uniqueMessageId('401')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'unauthorized', status: 401 });
		expect(requests()).toBe(1);
	});

	it('403 不重试（仅 1 次请求）', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [403]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 3 }),
			messageId: uniqueMessageId('403')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'unauthorized', status: 403 });
		expect(requests()).toBe(1);
	});

	it('404 视为客户端错误，不重试', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [404]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 2 }),
			messageId: uniqueMessageId('404')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'client-error', status: 404 });
		expect(requests()).toBe(1);
	});

	it('429 有限重试（1+3 次封顶）', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [429, 429, 429, 429]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 3 }),
			messageId: uniqueMessageId('429')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'retryable', status: 429 });
		expect(requests()).toBe(4);
	});

	it('302 跳转被拒绝且不跟随（防 Basic 泄漏），仅 1 次请求', async () => {
		const origin = nextOrigin();
		const { requests } = mockProfilePut(origin, [302]);

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 2 }),
			messageId: uniqueMessageId('redirect')
		}), { sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'redirected', status: 302 });
		expect(requests()).toBe(1);
	});

	it('网络错误有限重试', async () => {
		const origin = nextOrigin();
		let calls = 0;
		const fetchImpl = async () => {
			calls++;
			throw new TypeError('network down');
		};

		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { retry: 2 }),
			messageId: uniqueMessageId('net')
		}), { fetchImpl, sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'network' });
		expect(calls).toBe(3);
	});

	it('超时通过 AbortController 触发', async () => {
		const origin = nextOrigin();
		let sawSignal = null;
		const fetchImpl = (url, init) => new Promise((resolve, reject) => {
			sawSignal = init.signal;
			init.signal.addEventListener('abort', () => {
				const err = new Error('aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});

		const started = Date.now();
		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { timeout: 60, retry: 0 }),
			messageId: uniqueMessageId('timeout')
		}), { fetchImpl, sleep: async () => {} });

		expect(result).toEqual({ synced: false, reason: 'timeout' });
		expect(sawSignal).toBeInstanceOf(AbortSignal);
		expect(sawSignal.aborted).toBe(true);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('总预算已耗尽时不产生任何请求', async () => {
		expect(syncClipboardService.MAX_TOTAL_BUDGET_MS).toBeLessThanOrEqual(25000);

		const origin = nextOrigin();
		let calls = 0;
		const fetchImpl = () => {
			calls++;
			return new Promise(() => {
			});
		};

		const started = Date.now();
		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { timeout: 15000, retry: 3 }),
			messageId: uniqueMessageId('budget')
		}), { fetchImpl, sleep: async () => {}, deadline: Date.now() - 1 });

		expect(result).toEqual({ synced: false, reason: 'timeout' });
		expect(calls).toBe(0);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('15s 超时 × 3 重试的最坏配置仍受总预算约束（不会跑到 60s）', async () => {
		const origin = nextOrigin();
		let calls = 0;
		const fetchImpl = (url, init) => new Promise((resolve, reject) => {
			calls++;
			init.signal.addEventListener('abort', () => {
				const err = new Error('aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});

		const started = Date.now();
		const result = await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
			config: config(origin, { timeout: 15000, retry: 3 }),
			messageId: uniqueMessageId('budget2')
		}), { fetchImpl, sleep: async () => {}, deadline: Date.now() + 400 });

		expect(result.synced).toBe(false);
		expect(result.reason).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(2500);
		expect(calls).toBeGreaterThanOrEqual(1);
	});
});

describe('日志与敏感信息', () => {

	it('失败日志不含验证码、密码、目标 URL 与响应体', async () => {
		const origin = nextOrigin();
		const logs = [];
		const original = console.error;
		console.error = (...args) => logs.push(args.map(String).join(' '));

		try {
			mockProfilePut(origin, [500]);
			await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
				code: '007007',
				config: config(origin, { retry: 0 }),
				messageId: uniqueMessageId('logs')
			}), { sleep: async () => {} });
		} finally {
			console.error = original;
		}

		expect(logs.length).toBeGreaterThan(0);
		const joined = logs.join('\n');
		expect(joined).not.toContain('007007');
		expect(joined).not.toContain('secret123');
		expect(joined).not.toContain(origin);
		expect(joined).toContain('reason=retryable');
		expect(joined).toContain('emailId=11');
	});

	it('异常对象里的敏感字段不会被打印（只打 name）', async () => {
		const origin = nextOrigin();
		const logs = [];
		const original = console.error;
		console.error = (...args) => logs.push(args.map(String).join(' '));

		try {
			const fetchImpl = () => {
				throw new Error('boom https://user:pw@evil.example.com/secret');
			};

			await syncClipboardService.syncReceivedEmail({ env }, emailData(origin, {
				config: config(origin, { retry: 0 }),
				messageId: uniqueMessageId('errlog')
			}), { fetchImpl, sleep: async () => {} });
		} finally {
			console.error = original;
		}

		const joined = logs.join('\n');
		expect(joined).not.toContain('evil.example.com');
		expect(joined).not.toContain('pw@');
		expect(joined).not.toContain('boom');
	});
});

describe('只读连通性测试', () => {

	it('GET /api/version，成功返回 ok（绝不 PUT）', async () => {
		const origin = nextOrigin();
		fetchMock.get(origin)
			.intercept({
				path: VERSION_PATH,
				method: 'GET',
				headers: { authorization: BASIC_ADMIN_SECRET123 }
			})
			.reply(200, '"1.2.3"');

		const result = await syncClipboardService.testConnection({ env }, config(origin), { sleep: async () => {} });

		expect(result).toEqual({ ok: true, status: 200, path: VERSION_PATH });
		expect(JSON.stringify(result)).not.toContain('1.2.3');
	});

	it('/api/version 不存在时回退只读 GET /SyncClipboard.json', async () => {
		const origin = nextOrigin();
		fetchMock.get(origin).intercept({ path: VERSION_PATH, method: 'GET' }).reply(404, '');
		fetchMock.get(origin).intercept({ path: PROFILE_PATH, method: 'GET' }).reply(200, '{}');

		const result = await syncClipboardService.testConnection({ env }, config(origin), { sleep: async () => {} });

		expect(result).toEqual({ ok: true, status: 200, path: PROFILE_PATH });
	});

	it('认证失败时返回 unauthorized（不重试）', async () => {
		const origin = nextOrigin();
		let calls = 0;
		fetchMock.get(origin)
			.intercept({ path: VERSION_PATH, method: 'GET' })
			.reply(() => {
				calls++;
				return { statusCode: 401, data: '' };
			});

		const result = await syncClipboardService.testConnection({ env }, config(origin), { sleep: async () => {} });

		expect(result).toEqual({ ok: false, reason: 'unauthorized', status: 401 });
		expect(calls).toBe(1);
	});

	it('地址非法时不做任何请求', async () => {
		const result = await syncClipboardService.testConnection({ env }, config('http://sync.example.com'), { sleep: async () => {} });

		expect(result).toEqual({ ok: false, reason: 'url-not-https' });
	});

	it('只读测试受同一 25s 预算约束（不会累积两次 15s 超时）', async () => {
		const origin = nextOrigin();
		let calls = 0;
		const fetchImpl = () => {
			calls++;
			return new Promise(() => {
			});
		};

		const started = Date.now();
		const result = await syncClipboardService.testConnection({ env }, config(origin, { timeout: 15000 }), {
			fetchImpl,
			sleep: async () => {},
			deadline: Date.now() - 1
		});

		expect(result.ok).toBe(false);
		expect(calls).toBe(0);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});

describe('配置归一化（旧库 / KV 缺字段）', () => {

	it('空对象按默认值：关闭、全站、retry=2、timeout=5000', () => {
		const resolved = syncClipboardService.resolveConfig({});

		expect(resolved).toEqual({
			status: settingConst.syncClipboardStatus.CLOSE,
			url: '',
			username: '',
			password: '',
			mode: settingConst.syncClipboardMode.ALL,
			emails: '',
			retry: 2,
			timeout: 5000
		});
	});

	it('null/空串不会被 Number() 误判为 0', () => {
		const resolved = syncClipboardService.resolveConfig({
			syncClipboardStatus: null,
			syncClipboardMode: '',
			syncClipboardRetry: null,
			syncClipboardTimeout: ''
		});

		expect(resolved.status).toBe(settingConst.syncClipboardStatus.CLOSE);
		expect(resolved.mode).toBe(settingConst.syncClipboardMode.ALL);
		expect(resolved.retry).toBe(2);
		expect(resolved.timeout).toBe(5000);
	});

	it('retry/timeout 被钳制在安全范围', () => {
		expect(syncClipboardService.resolveConfig({ syncClipboardRetry: 99 }).retry).toBe(3);
		expect(syncClipboardService.resolveConfig({ syncClipboardRetry: -5 }).retry).toBe(0);
		expect(syncClipboardService.resolveConfig({ syncClipboardTimeout: 60000 }).timeout).toBe(15000);
		expect(syncClipboardService.resolveConfig({ syncClipboardTimeout: 1 }).timeout).toBe(1000);
	});

	it('URL 校验覆盖协议/凭据/IP/内网/路径', () => {
		expect(syncClipboardService.validateTargetUrl('https://sync.pei.ee')).toEqual({
			ok: true,
			origin: 'https://sync.pei.ee',
			host: 'sync.pei.ee'
		});
		expect(syncClipboardService.validateTargetUrl('https://sync.pei.ee/').ok).toBe(true);
		expect(syncClipboardService.validateTargetUrl('https://sync.pei.ee:8443').origin).toBe('https://sync.pei.ee:8443');

		expect(syncClipboardService.validateTargetUrl('http://sync.pei.ee').reason).toBe('url-not-https');
		expect(syncClipboardService.validateTargetUrl('https://a:b@sync.pei.ee').reason).toBe('url-has-credentials');
		expect(syncClipboardService.validateTargetUrl('https://192.168.1.10').reason).toBe('url-ip-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://2130706433').reason).toBe('url-ip-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://[::1]').reason).toBe('url-ip-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://foo.localhost').reason).toBe('url-local-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://metadata.google.internal').reason).toBe('url-local-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://intranet').reason).toBe('url-local-not-supported');
		expect(syncClipboardService.validateTargetUrl('https://sync.pei.ee/x?y=1').reason).toBe('url-has-path');
		expect(syncClipboardService.validateTargetUrl('not a url').reason).toBe('url-invalid');
	});

	it('邮箱名单归一化去重（含中文逗号/空格）', () => {
		expect(syncClipboardService.normalizeEmails(' A@Example.com，b@example.com ,, a@example.com '))
			.toEqual(['a@example.com', 'b@example.com']);
		expect(syncClipboardService.normalizeEmails('')).toEqual([]);
		expect(syncClipboardService.normalizeEmails(null)).toEqual([]);
	});
});
