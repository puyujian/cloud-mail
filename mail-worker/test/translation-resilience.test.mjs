import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import translationSchema from '../src/const/translation-schema';

// 线上“翻译失败，请重试”的三条真实成因，各用一条测试钉住：
// 1. 模型把 JSON 包在 ```json 围栏/解释文字里 → 解析器必须仍然认得
// 2. 模型漏了条目 → 逐条补译补齐，不能让整块作废
// 3. 翻译表缺失（部署不会跑 /api/init）→ 首次请求自愈建表
// brokenIndex 用来模拟“某条索引建不出来”，验证自愈不会因为一条 DDL 失败而整体回滚
function createD1(sqlite, { brokenIndex = false } = {}) {
	function statement(sql, args) {
		if (brokenIndex && /CREATE\s+(UNIQUE\s+)?INDEX[\s\S]*idx_translation_job_expire/i.test(sql)) {
			return {
				async first() { throw new Error('D1_ERROR: broken index'); },
				async all() { throw new Error('D1_ERROR: broken index'); },
				async run() { throw new Error('D1_ERROR: broken index'); }
			};
		}
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
			return Object.assign(statement(sql, []), {
				bind(...args) {
					return statement(sql, args);
				}
			});
		},
		async batch(stmts) {
			const out = [];
			for (const stmt of stmts) {
				out.push(await stmt.run());
			}
			return out;
		}
	};
}

function createKv() {
	const store = new Map();
	return {
		async get(key, options) {
			const value = store.get(key);
			if (value === undefined) return null;
			return options?.type === 'json' ? JSON.parse(value) : value;
		},
		async put(key, value) {
			store.set(key, value);
		},
		store
	};
}

// 模型的两种调用契约：批量走 JSON，补译走纯文本
function createAi(behavior) {
	const calls = [];
	return {
		calls,
		async run(model, payload) {
			calls.push({ model, payload });
			let batch = null;
			try {
				batch = JSON.parse(payload.messages[1].content);
			} catch (e) {
				batch = null;
			}
			const isBatch = !!batch && Array.isArray(batch.items);
			const items = isBatch ? batch.items : [];

			if (behavior === 'fence') {
				return {
					response: '这里是要的 JSON：\n```json\n'
						+ JSON.stringify({ items: items.map(item => ({ id: item.id, text: '[译]' + item.text })) })
						+ '\n```\n以上。'
				};
			}
			if (behavior === 'drop-last') {
				if (isBatch) {
					// 故意少回一条，模拟 llama 漏项
					return {
						response: JSON.stringify({
							items: items.slice(0, -1).map(item => ({ id: item.id, text: '[译]' + item.text }))
						})
					};
				}
				return { response: '[补译]' + payload.messages[1].content };
			}
			if (behavior === 'object-response') {
				// 新模型会把 JSON 契约解析好直接塞进 response
				return { response: { items: items.map(item => ({ id: item.id, text: '[译]' + item.text })) } };
			}
			if (behavior === 'choices-response') {
				return {
					choices: [{
						message: {
							content: JSON.stringify({ items: items.map(item => ({ id: item.id, text: '[译]' + item.text })) })
						}
					}]
				};
			}
			if (behavior === 'mangled-digits') {
				// llama 偶尔把 2026-10-21 写成 "2026年1١"（阿拉伯数字混进来）
				return {
					response: JSON.stringify({
						items: items.map(item => ({
							id: item.id,
							text: '[译]' + item.text.replace(/2026-10-21/g, '2026年1١')
						}))
					})
				};
			}
			if (behavior === 'keep-first') {
				// 线上 GitHub 通知邮件：标题整句被原样返回，用户看到的就是没翻译
				if (isBatch) {
					return {
						response: JSON.stringify({
							items: items.map((item, index) => ({
								id: item.id,
								text: index === 0 ? item.text : '[译]' + item.text
							}))
						})
					};
				}
				return { response: '[重译]' + payload.messages[1].content };
			}
			if (behavior === 'truncated') {
				// 撞上 max_tokens：JSON 半截断掉，后面开始原地打转
				if (isBatch) {
					const built = items.slice(0, -1)
						.map(item => JSON.stringify({ id: item.id, text: '[译]' + item.text }))
						.join(',');
					return { response: '{"items":[' + built + ',{"id":"' + items[items.length - 1].id + '","text":"\u4e07\u4e07' };
				}
				return { response: '[补译]' + payload.messages[1].content };
			}
			if (behavior === 'not-json') {
				return { response: '你好，我是翻译助手。' };
			}
			if (behavior === 'repair-echo-json') {
				if (isBatch) {
					return { response: JSON.stringify({ items: [] }) };
				}
				return { response: '{"items":[{"id":"x","text":"y"}]}' };
			}
			return {
				response: JSON.stringify({ items: items.map(item => ({ id: item.id, text: '[译]' + item.text })) })
			};
		}
	};
}

const HTML = '<div><p>Hello <b>world</b></p><p>Second</p></div>';

// withTranslationTables=false 用来复现“生产库没建过翻译表”的状态
function build({ behavior, withTranslationTables = true, brokenIndex = false, content = HTML, vars = {} } = {}) {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('CREATE TABLE email (email_id INTEGER PRIMARY KEY, account_id INTEGER, user_id INTEGER, content TEXT, text TEXT, is_del INTEGER DEFAULT 0)');
	sqlite.exec('CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER DEFAULT 0)');
	if (withTranslationTables) {
		for (const sql of translationSchema) {
			sqlite.exec(sql);
		}
	}
	sqlite.exec('INSERT INTO account (account_id, user_id, is_del) VALUES (3, 1, 0)');
	sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (7, 3, 1, ?, ?, 0)')
		.run(content, 'Hello world');
	const env = { db: createD1(sqlite, { brokenIndex }), kv: createKv(), ai: createAi(behavior), ...vars };
	return { c: { env }, sqlite, env };
}

async function runToEnd(c, service, payload) {
	let current = payload;
	while (current.state !== 'done') {
		current = await service.step(c, { jobId: current.jobId }, 1);
	}
	return current;
}

describe('translation resilience', () => {

	// 必须放在最前面：自愈只在模块生命周期内做一次，先跑才能复现“刚部署没建表”
	it('翻译表缺失时首次请求自愈建表', async () => {
		const { c, sqlite } = build({ withTranslationTables: false });
		// schemaReady 是模块级状态，重置后才是“刚部署”的样子
		vi.resetModules();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[译]Hello');
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'email_translation'").get().n).toBe(1);
	});

	it('单条 DDL 失败不会连累建表与翻译', async () => {
		// 旧实现把整批 DDL 放一个 batch：一条索引失败会把建表一起回滚，
		// 线上因此留下“权限行在、表不在”的半初始化状态
		const { c, sqlite } = build({ withTranslationTables: false, brokenIndex: true });
		vi.resetModules();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'translation%' OR name = 'email_translation'").all().map(row => row.name);
		expect(tables).toContain('email_translation');
		expect(tables).toContain('translation_quota');
	});

	it('模型把 JSON 解析成对象直接放进 response 时也能翻译', async () => {
		// Workers AI 的 llama-3.1-8b-fast-v2 会把 JSON 契约直接解析成对象塞进 response，
		// 老代码只认字符串，导致线上每一封邮件都报“翻译失败”
		const { c } = build({ behavior: 'object-response' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[译]Hello');
	});

	it('数字被模型改动的条目退回原文，不会写错时间', async () => {
		const { c } = build({
			behavior: 'mangled-digits',
			content: '<div><p>Login at 2026-10-21 16:33:14</p><p>Hello world</p></div>'
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		// 整封不因为一个节点错乱而失败，但那个节点必须是原文，不能带阿拉伯数码
		expect(done.content).not.toContain('1١');
		expect(done.content).toContain('2026-10-21');
		// 其他节点照常翻译
		expect(done.content).toContain('[译]Hello');
	});

	it('模型只给 OpenAI 风格 choices[0].message.content 时也能翻译', async () => {
		const { c } = build({ behavior: 'choices-response' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[译]Hello');
	});

	it('模型把 JSON 包在围栏和说明文字里也能解析', async () => {
		const { c, env } = build({ behavior: 'fence' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[译]Hello');
		// 解析成功就不该再走补译，模型调用次数等于分块数
		expect(env.ai.calls.length).toBe(Number(done.progress.total));
	});

	it('模型漏掉条目时用纯文本契约补译，不再整块作废', async () => {
		const { c, env } = build({ behavior: 'drop-last' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		// 漏掉的那条要由补译补上，且译文确实进了正文
		expect(done.content).toContain('[补译]Second');
		expect(done.content).toContain('[译]Hello');
		// 补译只发生在缺口上：调用数严格大于分块数
		expect(env.ai.calls.length).toBeGreaterThan(Number(done.progress.total));
	});

	it('整句被原样返回时单独重译，不留下半中半英', async () => {
		const content = '<div><p>Cloud check in action: No jobs were run</p><p>Second paragraph here</p></div>';
		const { c, env } = build({ behavior: 'keep-first', content });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[重译]Cloud check in action: No jobs were run');
		expect(done.content).toContain('[译]Second paragraph here');
		// 批量 1 次 + 针对那一句的重译 1 次，已经翻好的不再重发
		expect(env.ai.calls.length).toBe(2);
	});

	it('输出被 max_tokens 截断时，完整的条目照收，缺口交给补译', async () => {
		const { c, env } = build({ behavior: 'truncated' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		// 半截的那条不能被当译文写进去
		expect(done.content).not.toContain('万万');
		expect(done.content).toContain('[译]Hello');
		expect(done.content).toContain('[补译]Second');
		// 批量 1 次 + 只补缺口（1 条）
		expect(env.ai.calls.length).toBe(2);
	});

	it('翻译失败的任务会把当天额度退回去', async () => {
		const { c, sqlite } = build({ behavior: 'not-json' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const charged = sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE user_id = 1').get();
		expect(charged.jobs).toBe(1);

		// 分块有 3 次重试机会，用尽后任务才判死
		for (let i = 0; i < 5; i++) {
			try {
				await service.step(c, { jobId: payload.jobId }, 1);
			} catch (e) {
				// 前几次是分块失败，最后一次是任务判死
			}
		}

		// 一封模型啃不动的邮件不该把用户当天的额度吃光
		const refunded = sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE user_id = 1').get();
		expect(refunded.jobs).toBe(0);
		expect(refunded.codepoints).toBe(0);
	});

	it('额度上限可以用 Worker 变量覆盖', async () => {
		const { c, env } = build({ behavior: 'default', vars: { ai_translate_max_jobs_per_day: '1' } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);
		expect(done.state).toBe('done');

		// 第二封（不同语言 → 不同缓存键）就会撞上自定义的 1 次上限
		await expect(service.start(c, { emailId: 7, targetLang: 'en' }, 1))
			.rejects.toThrow('今日 AI 翻译额度已用尽');
		expect(env.ai.calls.length).toBeGreaterThan(0);
	});

	it('源文已经是目标语言时不会为「原样返回」再烧一遍模型', async () => {
		const content = '<div><p>Cloud check in action: No jobs were run</p><p>Second paragraph here</p></div>';
		const { c, env } = build({ behavior: 'keep-first', content });
		const { default: service } = await import('../src/service/email-translation-service.js');

		// 界面语言是英文、目标语言也是英文：原样返回就是正确结果
		const payload = await service.start(c, { emailId: 7, targetLang: 'en' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('Cloud check in action: No jobs were run');
		// 只有那一次批量调用
		expect(env.ai.calls.length).toBe(1);
	});

	it('模型完全没按 JSON 契约返回时直接失败，不做补译', async () => {
		const { c, env } = build({ behavior: 'not-json' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);

		await expect(service.step(c, { jobId: payload.jobId }, 1))
			.rejects.toThrow('AI 翻译结果校验失败');
		// 只有第一次批量调用：非 JSON 说明模型没在工作，补译只会存下垃圾文本
		expect(env.ai.calls.length).toBe(1);
	});

	it('补译回来的仍然是 JSON 时不当作译文', async () => {
		const { c } = build({ behavior: 'repair-echo-json' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);

		await expect(service.step(c, { jobId: payload.jobId }, 1))
			.rejects.toThrow('AI 翻译结果校验失败');
	});

	it('失败响应带上稳定的 errorKey，前端才能显示具体原因', async () => {
		const { c } = build({ behavior: 'not-json' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);

		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationInvalidOutput',
			code: 502
		});
	});

	it('任务里的 errorKey 会随 payload 返回给前端', async () => {
		const { c } = build({ behavior: 'not-json' });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toThrow();

		const status = await service.status(c, { jobId: payload.jobId }, 1);
		expect(status.errorKey).toBe('translationInvalidOutput');
	});
});
