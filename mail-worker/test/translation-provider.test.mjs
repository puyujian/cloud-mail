import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import translationSchema from '../src/const/translation-schema';

// 主力通道是 Gemini 免费档，Workers AI 作为兜底。
// 这里钉住四件事：
// 1. 配了 key 就走 Gemini，请求形状与官方 REST 一致（systemInstruction / generationConfig）
// 2. Gemini 限流（429）或空返回时自动退回 Workers AI，用户不该看到“翻译失败”
// 3. 超时/网络中断属于“结果未知”，绝不换通道重发（否则同一段文本被翻两遍、计费两遍）
// 4. 思考模型的 thought 片段不是译文，混进来会把 JSON 契约撑坏

function createD1(sqlite) {
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

// Workers AI 兜底通道的假实现：译文前缀用 [护]，一眼能看出是谁翻的
// bad=true 模拟模型完全不按 JSON 契约返回；boom=true 模拟上游明确拒绝（限流）
function createAi({ bad = false, boom = null } = {}) {
	const calls = [];
	return {
		calls,
		async run(model, payload) {
			calls.push({ model, payload });
			if (boom) {
				throw new Error(boom);
			}
			if (bad) {
				return { response: '你好，我是翻译助手。' };
			}
			let batch = null;
			try {
				batch = JSON.parse(payload.messages[1].content || '{}');
			} catch (e) {
				batch = null;
			}
			const items = itemsOf(batch);
			if (!items.length) {
				// 纯文本补译契约
				return { response: '[护]' + payload.messages[1].content };
			}
			return {
				response: JSON.stringify({ items: items.map(item => ({ id: item.id, text: '[护]' + item.text })) })
			};
		}
	};
}

// 假的 OpenAI 兼容端点：/chat/completions 的形状
function createOpenAi(handler) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		const call = { url, headers: init.headers, body };
		calls.push(call);
		const out = await handler({ body, call, calls });
		const status = out.status === undefined ? 200 : out.status;
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(out.payload ?? {})
		};
	};
	return { calls, fetchImpl };
}

function openAiOk(text) {
	return {
		payload: {
			choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }
		}
	};
}

// 假 Gemini 端点：返回形状与 generativelanguage.googleapis.com 完全一致
function createGemini(handler) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		const call = { url, headers: init.headers, body };
		calls.push(call);
		const out = await handler({ body, call, calls });
		const status = out.status === undefined ? 200 : out.status;
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(out.payload ?? {})
		};
	};
	return { calls, fetchImpl };
}

function geminiOk(text) {
	return {
		payload: {
			candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
			usageMetadata: { candidatesTokenCount: 12, promptTokenCount: 40 }
		}
	};
}

function itemsOf(batch) {
	return Array.isArray(batch?.items) ? batch.items : [];
}

function userTextOf(body) {
	return (body.contents || [])
		.map(part => (part.parts || []).map(piece => piece.text || '').join(''))
		.join('\n');
}

const HTML = '<div><p>Hello <b>world</b></p><p>Second</p></div>';

function build({ content = HTML, vars = {} } = {}) {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('CREATE TABLE email (email_id INTEGER PRIMARY KEY, account_id INTEGER, user_id INTEGER, content TEXT, text TEXT, is_del INTEGER DEFAULT 0)');
	sqlite.exec('CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER DEFAULT 0)');
	for (const sql of translationSchema) {
		sqlite.exec(sql);
	}
	sqlite.exec('INSERT INTO account (account_id, user_id, is_del) VALUES (3, 1, 0)');
	sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (7, 3, 1, ?, ?, 0)')
		.run(content, 'Hello world');
	const env = { db: createD1(sqlite), kv: createKv(), ...vars };
	return { c: { env }, sqlite, env };
}

async function runToEnd(c, service, payload) {
	let current = payload;
	while (current.state !== 'done') {
		current = await service.step(c, { jobId: current.jobId }, 1);
	}
	return current;
}

describe('translation provider chain', () => {

	it('配了 Gemini key 就走 Gemini，请求形状与官方 REST 一致', async () => {
		const gemini = createGemini(({ body }) => geminiOk(JSON.stringify({
			items: itemsOf(JSON.parse(userTextOf(body) || '{}')).map(item => ({ id: item.id, text: '[G]' + item.text }))
		})));
		const { c, sqlite } = build({
			vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai: createAi() }
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[G]Hello');
		// 走的是 Gemini，不是 Workers AI
		expect(done.content).not.toContain('[护]');

		const call = gemini.calls[0];
		expect(call.url).toContain('/models/gemini-2.5-flash:generateContent');
		expect(call.headers['x-goog-api-key']).toBe('test-key');
		expect(call.body.systemInstruction.parts[0].text.length).toBeGreaterThan(20);
		expect(call.body.generationConfig.temperature).toBe(0);
		expect(call.body.generationConfig.maxOutputTokens).toBeGreaterThan(1024);
		// 批量契约交给 Gemini 强制成 JSON
		expect(call.body.generationConfig.responseMimeType).toBe('application/json');
		// 翻译是机械任务，默认关掉思考，别让思考 token 吃掉输出预算
		expect(call.body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });

		// 缓存键要带通道前缀，换通道就等于换译文
		const row = sqlite.prepare('SELECT model FROM email_translation WHERE email_id = 7').get();
		expect(row.model).toBe('gemini:gemini-2.5-flash');
	});

	it('Gemini 被限流时自动退回 Workers AI', async () => {
		const gemini = createGemini(() => ({
			status: 429,
			payload: { error: { code: 429, message: 'Resource has been exhausted' } }
		}));
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		// 主用今天被限流，不代表用户今天翻不了邮件
		expect(done.state).toBe('done');
		expect(done.content).toContain('[护]Hello');
		expect(gemini.calls.length).toBeGreaterThan(0);
		expect(ai.calls.length).toBeGreaterThan(0);
	});

	it('Gemini 返回空内容时退回 Workers AI', async () => {
		const gemini = createGemini(() => ({ payload: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } }));
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[护]Hello');
	});

	it('Gemini 网络异常属于结果未知，不换通道重发', async () => {
		const gemini = createGemini(() => {
			throw new Error('network down');
		});
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationModelFailed',
			code: 504
		});
		// 结果未知时换通道 = 同一段文本被翻两遍、计费两遍
		expect(ai.calls.length).toBe(0);
	});

	it('思考片段不会被当成译文塞进 JSON 契约', async () => {
		const gemini = createGemini(({ body }) => ({
			payload: {
				candidates: [{
					content: {
						parts: [
							{ text: '{"items":[{"id":"u1","text":"思考中的半截 JSON', thought: true },
							{ text: JSON.stringify({ items: itemsOf(JSON.parse(userTextOf(body) || '{}')).map(item => ({ id: item.id, text: '[G]' + item.text })) }) }
						]
					},
					finishReason: 'STOP'
				}]
			}
		}));
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai: createAi() } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[G]Hello');
		expect(done.content).not.toContain('思考中的半截');
	});

	it('模型不认 thinkingConfig 时去掉它重发一次', async () => {
		const gemini = createGemini(({ body, calls }) => {
			if (calls.length === 1) {
				return { status: 400, payload: { error: { code: 400, message: 'Unknown name "thinkingConfig"' } } };
			}
			return geminiOk(JSON.stringify({
				items: itemsOf(JSON.parse(userTextOf(body) || '{}')).map(item => ({ id: item.id, text: '[G]' + item.text }))
			}));
		});
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai: createAi() } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[G]Hello');
		expect(gemini.calls[0].body.generationConfig.thinkingConfig).toBeTruthy();
		expect(gemini.calls[1].body.generationConfig.thinkingConfig).toBeUndefined();
	});

	it('显式指定 workers-ai 时即使配了 key 也不走 Gemini', async () => {
		const gemini = createGemini(() => geminiOk('{"items":[]}'));
		const ai = createAi();
		const { c, sqlite } = build({
			vars: {
				GEMINI_API_KEY: 'test-key',
				translateFetch: gemini.fetchImpl,
				ai,
				ai_translate_provider: 'workers-ai'
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[护]Hello');
		expect(gemini.calls.length).toBe(0);
		expect(sqlite.prepare('SELECT model FROM email_translation WHERE email_id = 7').get().model)
			.toBe('workers-ai:@cf/meta/llama-3.1-8b-instruct-fast');
	});

	it('配了 OpenAI 兼容端点就走它，优先于 Workers AI', async () => {
		const openai = createOpenAi(({ body }) => openAiOk(JSON.stringify({
			items: itemsOf(JSON.parse(body.messages[1].content || '{}')).map(item => ({ id: item.id, text: '[Q]' + item.text }))
		})));
		const { c, sqlite } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				ai_translate_openai_json_mode: 'on',
				translateFetch: openai.fetchImpl,
				ai: createAi()
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[Q]Hello');
		expect(done.content).not.toContain('[护]');

		const call = openai.calls[0];
		expect(call.url).toBe('https://api.example.com/v1/chat/completions');
		expect(call.headers.Authorization).toBe('Bearer sk-test');
		expect(call.body.model).toBe('qwen-test');
		expect(call.body.temperature).toBe(0);
		// json_mode 默认关：实测 OpenAI 兼容中继端点对 response_format 会直接 400 或明显变慢
		expect(call.body.response_format).toEqual({ type: 'json_object' });
		expect(sqlite.prepare('SELECT model FROM email_translation WHERE email_id = 7').get().model).toBe('openai:qwen-test');
	});

	it('兼容端点不认 response_format 时去掉它重发一次', async () => {
		const openai = createOpenAi(({ body, calls }) => {
			if (calls.length === 1) {
				return { status: 400, payload: { error: { message: 'response_format is not supported' } } };
			}
			return openAiOk(JSON.stringify({
				items: itemsOf(JSON.parse(body.messages[1].content || '{}')).map(item => ({ id: item.id, text: '[Q]' + item.text }))
			}));
		});
		const { c } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				ai_translate_openai_json_mode: 'on',
				translateFetch: openai.fetchImpl,
				ai: createAi()
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[Q]Hello');
		expect(openai.calls[0].body.response_format).toBeTruthy();
		expect(openai.calls[1].body.response_format).toBeUndefined();
	});

	it('兼容端点 429 时退回 Workers AI', async () => {
		const openai = createOpenAi(() => ({ status: 429, payload: { error: { message: 'rate limited' } } }));
		const ai = createAi();
		const { c } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[护]Hello');
		expect(ai.calls.length).toBeGreaterThan(0);
	});

	it('一条通道都没配时报“AI 翻译服务暂不可用”', async () => {
		const { c } = build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationAiUnavailable',
			code: 503
		});
	});

	it('响应体读不出来属于结果未知，不换通道重发', async () => {
		// 只拿到响应头、正文断流：不知道模型到底执行没执行，换通道等于再翻一遍、再计费一遍
		const calls = [];
		const brokenFetch = async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) });
			return {
				ok: true,
				status: 200,
				text: async () => {
					throw new Error('socket hang up');
				}
			};
		};
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: brokenFetch, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationModelFailed'
		});
		expect(calls.length).toBe(1);
		expect(ai.calls.length).toBe(0);
	});

	it('历史任务里的裸模型名按 Workers AI 解释，不会被换成新主力通道', async () => {
		const openai = createOpenAi(() => openAiOk('{"items":[]}'));
		const ai = createAi();
		const { c } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: aiService } = await import('../src/service/ai-service.js');

		// 部署时还没有通道概念的老任务，存的就是裸模型名
		const result = await aiService.translateBatch(c, 'zh', [{ id: 'u1', text: 'Hello' }], {
			model: '@cf/meta/llama-3.1-8b-instruct-fast'
		});

		expect(ai.calls.length).toBeGreaterThan(0);
		expect(ai.calls[0].model).toBe('@cf/meta/llama-3.1-8b-instruct-fast');
		expect(openai.calls.length).toBe(0);
		expect(result.model).toBe('workers-ai:@cf/meta/llama-3.1-8b-instruct-fast');
	});

	it('分块重试用尽时当次就判死并退回额度，不等下一次 step', async () => {
		const ai = createAi({ bad: true });
		const { c, sqlite } = build({ vars: { ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(sqlite.prepare('SELECT jobs FROM translation_quota WHERE user_id = 1').get().jobs).toBe(1);

		// 前端报错就停手，只会走到第 3 次失败
		for (let i = 0; i < 3; i++) {
			try {
				await service.step(c, { jobId: payload.jobId }, 1);
			} catch (e) {
				// 前两次是分块失败，第三次用完重试次数
			}
		}

		expect(sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE user_id = 1').get())
			.toMatchObject({ jobs: 0, codepoints: 0 });
		const job = sqlite.prepare('SELECT state FROM email_translation WHERE email_id = 7').get();
		expect(job.state).toBe('error');
	});

	it('Workers AI 明确限流时反向回退到已配置的 HTTP 通道', async () => {
		const ai = createAi({ boom: '429 rate limit exceeded for this account' });
		const openai = createOpenAi(({ body }) => openAiOk(JSON.stringify({
			items: itemsOf(JSON.parse(body.messages[1].content || '{}')).map(item => ({ id: item.id, text: '[Q]' + item.text }))
		})));
		const { c } = build({
			vars: {
				ai_translate_provider: 'workers-ai',
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[Q]Hello');
		expect(ai.calls.length).toBeGreaterThan(0);
		expect(openai.calls.length).toBeGreaterThan(0);
	});

	it('兜底通道产出的译文不会写进可复用的 KV 缓存', async () => {
		const openai = createOpenAi(() => ({ status: 429, payload: { error: { message: 'rate limited' } } }));
		const ai = createAi();
		const { c, env, sqlite } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[护]Hello');
		// 主力是 Qwen，译文却来自 Workers AI：不能留在主力通道的缓存键下
		expect(env.kv.store.size).toBe(0);
		expect(sqlite.prepare('SELECT cache_key FROM email_translation WHERE email_id = 7').get().cache_key)
			.toContain(':fallback:');

		// 再点一次翻译：不能被这条兜底结果“缓存命中”，要重新翻
		const again = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(env.kv.store.size).toBe(0);
		expect(again.cached).not.toBe(true);
	});

	it('跨日退款不会扣掉今天的用量', async () => {
		const ai = createAi({ bad: true });
		const { c, sqlite } = build({ vars: { ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		// 造一个“昨天建的、今天才判死”的任务：额度记账在昨天
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
		const day = yesterday.toLocaleDateString('en-CA');
		sqlite.prepare('INSERT INTO translation_quota (user_id, day, jobs, codepoints) VALUES (1, ?, 1, 500)').run(day);
		sqlite.prepare('UPDATE email_translation SET created_time = ? WHERE email_id = 7').run(yesterday.getTime());

		for (let i = 0; i < 3; i++) {
			try {
				await service.step(c, { jobId: payload.jobId }, 1);
			} catch (e) {
				// 重试逐次耗尽
			}
		}

		// 昨天那笔退回，今天的用量不受影响
		const past = sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE day = ?').get(day);
		const todayRow = sqlite.prepare('SELECT jobs FROM translation_quota WHERE day = ?')
			.get(new Date().toLocaleDateString('en-CA'));
		// 退回的是这一封实际占用的字符数（Hello world + Second = 16），只动昨天那一行
		expect(past).toMatchObject({ jobs: 0, codepoints: 500 - 16 });
		expect(todayRow.jobs).toBe(1);
	});

	it('任务判死后不会因为迟到的 step 二次退款', async () => {
		const ai = createAi({ bad: true });
		const { c, sqlite } = build({ vars: { ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		for (let i = 0; i < 3; i++) {
			try {
				await service.step(c, { jobId: payload.jobId }, 1);
			} catch (e) {
				// 重试逐次耗尽
			}
		}
		// 迟到的并发请求：error 是终态，直接把存下来的错误码抛回去，不能再跑一遍分块
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationInvalidOutput',
			code: 502
		});

		const quota = sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE user_id = 1').get();
		expect(quota).toMatchObject({ jobs: 0, codepoints: 0 });
	});

	it('上游 5xx 属于结果未知，不换通道重发', async () => {
		const gemini = createGemini(() => ({ status: 503, payload: { error: { message: 'upstream unavailable' } } }));
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: gemini.fetchImpl, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationTimeout',
			code: 504
		});
		// 上游可能已经跑完并计费了：换通道 = 同一段文本再翻一遍
		expect(ai.calls.length).toBe(0);
	});

	it('200 但响应信封坏掉时按结果未知处理，不换通道重发', async () => {
		const calls = [];
		const broken = async (url, init) => {
			calls.push({ url });
			return { ok: true, status: 200, text: async () => 'oops, not json' };
		};
		const ai = createAi();
		const { c } = build({ vars: { GEMINI_API_KEY: 'test-key', translateFetch: broken, ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toMatchObject({
			errorKey: 'translationModelFailed',
			code: 504
		});
		expect(ai.calls.length).toBe(0);
	});

	it('预算耗尽后不再发起新的模型调用', async () => {
		const { default: aiService } = await import('../src/service/ai-service.js');
		expect(aiService.budget(30000, Date.now() - 1)).toBe(0);
		expect(aiService.budget(30000, Date.now() + 5000)).toBeLessThanOrEqual(5000);
	});

	it('判死后的任务不会被迟到的 updateJobState 拉回 running', async () => {
		const ai = createAi({ bad: true });
		const { c, sqlite } = build({ vars: { ai } });
		const { default: service } = await import('../src/service/email-translation-service.js');
		const { default: repo } = await import('../src/repository/translation-repository.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		for (let i = 0; i < 3; i++) {
			try {
				await service.step(c, { jobId: payload.jobId }, 1);
			} catch (e) {
				// 逐次耗尽
			}
		}
		expect(sqlite.prepare('SELECT state FROM email_translation WHERE email_id = 7').get().state).toBe('error');

		// 迟到请求手里的旧状态是 running，它还会照常写回 running
		await repo.updateJobState(c, payload.jobId, 'running');
		expect(sqlite.prepare('SELECT state FROM email_translation WHERE email_id = 7').get().state).toBe('error');
	});

	it('同一封邮件连续两次走兜底也不会撞 UNIQUE 缓存键', async () => {
		const openai = createOpenAi(() => ({ status: 429, payload: { error: { message: 'rate limited' } } }));
		const ai = createAi();
		const { c, sqlite } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		for (let round = 0; round < 2; round++) {
			const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
			const done = await runToEnd(c, service, payload);
			expect(done.state).toBe('done');
		}

		const keys = sqlite.prepare("SELECT cache_key FROM email_translation WHERE cache_key LIKE '%:fallback:%'").all().map(row => row.cache_key);
		expect(keys.length).toBe(2);
		expect(new Set(keys).size).toBe(2);
	});

	it('批量走主力、补译走兜底时也算混入，不写主力缓存', async () => {
		let call = 0;
		const openai = createOpenAi(({ body }) => {
			call += 1;
			if (call === 1) {
				// 批量：故意少回一条，逼出补译
				const items = itemsOf(JSON.parse(body.messages[1].content || '{}'));
				return openAiOk(JSON.stringify({ items: items.slice(0, -1).map(item => ({ id: item.id, text: '[Q]' + item.text })) }));
			}
			// 补译时主力通道挂了，被兜底通道接手
			return { status: 429, payload: { error: { message: 'rate limited' } } };
		});
		const ai = createAi();
		const { c, env, sqlite } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				ai_translate_openai_api_key: 'sk-test',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.state).toBe('done');
		expect(done.content).toContain('[Q]Hello');
		expect(env.kv.store.size).toBe(0);
		expect(sqlite.prepare('SELECT cache_key FROM email_translation WHERE email_id = 7').get().cache_key)
			.toContain(':fallback:');
	});

	it('预算不设下限，剩余多少就等多少', async () => {
		const { default: aiService } = await import('../src/service/ai-service.js');
		expect(aiService.budget(30000, Date.now() + 50)).toBeLessThanOrEqual(50);
	});

	it('secret 注入的大写变量名也能被识别（配了 key 却退回 Workers AI 的老坑）', async () => {
		const openai = createOpenAi(({ body }) => openAiOk(JSON.stringify({
			items: itemsOf(JSON.parse(body.messages[1].content || '{}')).map(item => ({ id: item.id, text: '[Q]' + item.text }))
		})));
		const { c, sqlite } = build({
			vars: {
				ai_translate_openai_base_url: 'https://api.example.com/v1',
				// wrangler secret 注入的是大写变量名
				AI_TRANSLATE_OPENAI_API_KEY: 'sk-upper',
				ai_translate_openai_model: 'qwen-test',
				translateFetch: openai.fetchImpl,
				ai: createAi()
			}
		});
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const done = await runToEnd(c, service, payload);

		expect(done.content).toContain('[Q]Hello');
		expect(openai.calls[0].headers.Authorization).toBe('Bearer sk-upper');
		expect(sqlite.prepare('SELECT model FROM email_translation WHERE email_id = 7').get().model).toBe('openai:qwen-test');
	});
});
