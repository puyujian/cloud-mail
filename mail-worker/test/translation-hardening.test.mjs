import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import translationSchema from '../src/const/translation-schema';


// 配额按站点时区（Asia/Shanghai）切日，测试必须用同一天的字符串，
// 否则在 UTC 16:00–24:00 这段（北京时间 0–8 点）预置的额度行对不上，配额检查被绕过
function serviceDay(at = Date.now()) {
	return new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
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
			for (const stmt of stmts) out.push(await stmt.run());
			return out;
		}
	};
}

function createKv() {
	const store = new Map();
	return {
		store,
		async get(key, options) {
			const value = store.get(key);
			if (value === undefined) return null;
			return options?.type === 'json' ? JSON.parse(value) : value;
		},
		async put(key, value) {
			store.set(key, value);
		}
	};
}

function createAi(behavior) {
	const calls = [];
	return {
		calls,
		async run(model, payload) {
			calls.push({ model, payload });
			const input = JSON.parse(payload.messages[1].content);
			if (behavior === 'timeout') {
				await new Promise(resolve => setTimeout(resolve, 60));
				throw new Error('model exploded');
			}
			if (behavior === 'invalid') {
				return { response: '{"items":[]}' };
			}
			return {
				response: JSON.stringify({ items: input.items.map(item => ({ id: item.id, text: '[译]' + item.text })) })
			};
		}
	};
}

const HTML = '<div><p>Hello <b>world</b></p><p>Second</p></div>';

async function build(aiBehavior) {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('CREATE TABLE email (email_id INTEGER PRIMARY KEY, account_id INTEGER, user_id INTEGER, content TEXT, text TEXT, is_del INTEGER DEFAULT 0)');
	sqlite.exec('CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER DEFAULT 0)');
	for (const sql of translationSchema) sqlite.exec(sql);
	sqlite.exec('INSERT INTO account (account_id, user_id, is_del) VALUES (3, 1, 0)');
	sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (7, 3, 1, ?, ?, 0)')
		.run(HTML, 'Hello world');
	const env = { db: createD1(sqlite), kv: createKv(), ai: createAi(aiBehavior) };
	return { c: { env }, sqlite, env };
}

describe('translation service hardening', () => {

	it('任务过期后拒绝访问', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		sqlite.prepare('UPDATE email_translation SET expire_time = ? WHERE job_id = ?').run(Date.now() - 1000, payload.jobId);

		await expect(service.status(c, { jobId: payload.jobId }, 1)).rejects.toThrow('翻译任务不存在或已过期');
	});

	it('邮件删除后不再返回缓存译文', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		let payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		while (payload.state !== 'done') {
			payload = await service.step(c, { jobId: payload.jobId }, 1);
		}
		sqlite.prepare('UPDATE email SET is_del = 1 WHERE email_id = 7').run();

		await expect(service.status(c, { jobId: payload.jobId }, 1)).rejects.toThrow('邮件不存在或不可访问');
	});

	it('他人无法通过 jobId 读取译文', async () => {
		const { c } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.status(c, { jobId: payload.jobId }, 2)).rejects.toThrow('翻译任务不存在或已过期');
	});

	it('模型返回结构非法时任务失败且不落库结果', async () => {
		const { c, sqlite } = await build('invalid');
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toThrow('AI 翻译结果校验失败');

		const job = sqlite.prepare('SELECT state FROM email_translation WHERE job_id = ?').get(payload.jobId);
		expect(job.state).not.toBe('done');
		const chunk = sqlite.prepare('SELECT status, attempts FROM email_translation_chunk WHERE job_id = ?').get(payload.jobId);
		expect(chunk.status).toBe(3);
	});

	it('超时属于结果未知，不自动重试（attempts 直接耗尽）', async () => {
		const { c, sqlite, env } = await build('timeout');
		const { default: service } = await import('../src/service/email-translation-service.js');
		// 复现真实的超时路径：ai-service 抛出的 BizError 带 uncertain 标记
		env.ai.run = async () => {
			const error = new Error('simulated timeout');
			error.name = 'BizError';
			error.code = 504;
			error.uncertain = true;
			throw error;
		};

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toBeTruthy();

		const chunk = sqlite.prepare('SELECT status, attempts FROM email_translation_chunk WHERE job_id = ?').get(payload.jobId);
		expect(chunk.status).toBe(3);
		expect(chunk.attempts).toBe(3);
	});

	it('每分钟新建任务数超限被拒绝', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		// 必须每封不同邮件：同一封邮件同语言会命中缓存，不应计入限流
		for (let i = 0; i < 5; i++) {
			const emailId = 100 + i;
			sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (?, 3, 1, ?, ?, 0)')
				.run(emailId, HTML, 'Hello world');
			await service.start(c, { emailId, targetLang: 'zh' }, 1);
		}

		sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (200, 3, 1, ?, ?, 0)')
			.run(HTML, 'Hello world');
		await expect(service.start(c, { emailId: 200, targetLang: 'zh' }, 1)).rejects.toThrow('翻译请求过于频繁');
	});

	it('busy 标记必须真正出现在返回载荷里', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		// 模拟另一次请求正持有该分块租约
		const owner = 'other-owner';
		sqlite.prepare(
			'UPDATE email_translation_chunk SET status = 1, lease_owner = ?, lease_until = ? WHERE job_id = ?'
		).run(owner, Date.now() + 60000, payload.jobId);

		const busy = await service.step(c, { jobId: payload.jobId }, 1);
		expect(busy.busy).toBe(true);
		expect(busy.state).toBe('running');
	});

	it('并发抢到同一 cache_key 时不删除他人任务并退还配额', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const first = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		const quotaBefore = sqlite.prepare('SELECT jobs FROM translation_quota WHERE user_id = 1').get();

		// 模拟另一个请求同时命中同一 cache_key：复用既有任务，不新增额度
		const second = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(second.jobId).toBe(first.jobId);

		const quotaAfter = sqlite.prepare('SELECT jobs FROM translation_quota WHERE user_id = 1').get();
		expect(quotaAfter.jobs).toBe(quotaBefore.jobs);

		const chunks = sqlite.prepare('SELECT COUNT(*) AS total FROM email_translation_chunk WHERE job_id = ?').get(first.jobId);
		expect(chunks.total).toBeGreaterThan(0);
	});

	it('过期任务不再被复用，重新开始会建新任务', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		const first = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		sqlite.prepare('UPDATE email_translation SET expire_time = ? WHERE job_id = ?')
			.run(Date.now() - 1000, first.jobId);

		const second = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(second.jobId).not.toBe(first.jobId);

		const remaining = sqlite.prepare('SELECT COUNT(*) AS total FROM email_translation WHERE job_id = ?').get(first.jobId);
		expect(remaining.total).toBe(0);
	});

	it('每日字符配额按累计后判定，不允许超发', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');
		const { default: consts } = await import('../src/const/translation-const.js');

		// 预置额度只剩 1 个字符，本次任务必然超发
		sqlite.prepare('INSERT INTO translation_quota (user_id, day, jobs, codepoints) VALUES (1, ?, 0, ?)')
			.run(serviceDay(), consts.DAILY_CODEPOINT_BUDGET - 1);

		await expect(service.start(c, { emailId: 7, targetLang: 'zh' }, 1))
			.rejects.toThrow('翻译额度已用尽');

		const quota = sqlite.prepare('SELECT jobs, codepoints FROM translation_quota WHERE user_id = 1').get();
		expect(quota.codepoints).toBe(consts.DAILY_CODEPOINT_BUDGET - 1);
		expect(quota.jobs).toBe(0);
	});

	it('已完成任务不会被并发 step 改回 running', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		let payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		while (payload.state !== 'done') {
			payload = await service.step(c, { jobId: payload.jobId }, 1);
		}

		// 直接调用状态更新，模拟另一个请求的迟到写入
		const { default: repository } = await import('../src/repository/translation-repository.js');
		await repository.updateJobState(c, payload.jobId, 'running');

		const job = sqlite.prepare('SELECT state FROM email_translation WHERE job_id = ?').get(payload.jobId);
		expect(job.state).toBe('done');
	});

	it('已完结任务再次 start 命中缓存', async () => {
		const { c, env } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');

		let payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		while (payload.state !== 'done') {
			payload = await service.step(c, { jobId: payload.jobId }, 1);
		}
		const calls = env.ai.calls.length;
		const again = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(again.state).toBe('done');
		expect(env.ai.calls.length).toBe(calls);
	});
});

describe('translation chunk splitting', () => {

	it('无标点长文本按字节硬切，单片不超限', async () => {
		const { default: utils } = await import('../src/utils/translation-html-utils.js');
		const { default: consts } = await import('../src/const/translation-const.js');
		const long = 'あ'.repeat(1500);
		const doc = utils.parse('<p>' + long + '</p>');
		const units = utils.extractUnits(doc);

		expect(units[0].parts).toBeTruthy();
		const encoder = new TextEncoder();
		for (const part of units[0].parts) {
			expect(encoder.encode(part.text).length).toBeLessThanOrEqual(consts.UNIT_MAX_BYTES);
		}
		const rebuilt = units[0].parts.map(p => p.text + p.sep).join('');
		expect(rebuilt).toBe(long);

		const chunks = utils.buildChunks(units);
		for (const chunk of chunks) {
			const bytes = chunk.reduce((sum, item) => sum + encoder.encode(item.text).length, 0);
			expect(bytes).toBeLessThanOrEqual(consts.CHUNK_MAX_BYTES);
		}
	});

	it('纯文本超长单行同样按字节硬切', async () => {
		const { default: utils } = await import('../src/utils/translation-html-utils.js');
		const { default: consts } = await import('../src/const/translation-const.js');
		const encoder = new TextEncoder();
		const long = 'x'.repeat(20000);
		const units = utils.extractPlainUnits(long);

		expect(units.length).toBe(1);
		expect(units[0].parts).toBeTruthy();
		for (const part of units[0].parts) {
			expect(encoder.encode(part.text).length).toBeLessThanOrEqual(consts.UNIT_MAX_BYTES);
		}

		const chunks = utils.buildPlainChunks(units);
		for (const chunk of chunks) {
			const bytes = chunk.reduce((sum, item) => sum + encoder.encode(item.text).length, 0);
			expect(bytes).toBeLessThanOrEqual(consts.CHUNK_MAX_BYTES);
		}

		const map = new Map();
		for (const part of units[0].parts) map.set(part.id, part.text.toUpperCase());
		expect(utils.applyPlainTranslations(long, units, map)).toBe('X'.repeat(20000));
	});

	it('超过最大 DOM 深度时抛错', async () => {
		const { default: utils } = await import('../src/utils/translation-html-utils.js');
		const deep = '<div>'.repeat(80) + 'x' + '</div>'.repeat(80);
		const doc = utils.parse(deep);
		expect(() => utils.extractUnits(doc)).toThrow('TRANSLATION_TOO_LARGE');
	});
	it('极深嵌套不会栈溢出，按大小限制拒绝', async () => {
		const htmlUtils = (await import('../src/utils/translation-html-utils.js')).default;
		const deep = '<div>'.repeat(4000) + 'hello' + '</div>'.repeat(4000);
		expect(() => htmlUtils.extractUnits(htmlUtils.sanitize(htmlUtils.parse(deep))))
			.toThrow('TRANSLATION_TOO_LARGE');
	});

	it('无标点长文本被硬切成不超过分块字节上限', async () => {
		const htmlUtils = (await import('../src/utils/translation-html-utils.js')).default;
		const units = htmlUtils.extractUnits(htmlUtils.sanitize(htmlUtils.parse('<p>' + 'A'.repeat(20000) + '</p>')));
		const chunks = htmlUtils.buildChunks(units);
		const maxItem = Math.max(...chunks.flat().map(item => new TextEncoder().encode(item.text).length));
		expect(maxItem).toBeLessThanOrEqual(600);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('隐藏内容不进入翻译单元', async () => {
		const htmlUtils = (await import('../src/utils/translation-html-utils.js')).default;
		const html = '<div><p>Visible</p><p style="display:none">Secret</p><p hidden>Hidden</p><p aria-hidden="true">Aria</p></div>';
		const units = htmlUtils.extractUnits(htmlUtils.sanitize(htmlUtils.parse(html)));
		expect(units.map(u => u.text)).toEqual(['Visible']);
	});

	it('pre/code 内容保留且不被翻译', async () => {
		const htmlUtils = (await import('../src/utils/translation-html-utils.js')).default;
		const html = '<div><p>Text</p><pre><code>const a = 1;\n  return a;</code></pre></div>';
		const doc = htmlUtils.sanitize(htmlUtils.parse(html));
		const units = htmlUtils.extractUnits(doc);
		expect(units.map(u => u.text)).toEqual(['Text']);
		const out = htmlUtils.serialize(doc);
		expect(out).toContain('<pre>');
		expect(out).toContain('<code>');
	});

	it('模型返回空白译文视为失败', async () => {
		const { c } = await build();
		c.env.ai = {
			async run(model, payload) {
				const input = JSON.parse(payload.messages[1].content);
				return { response: JSON.stringify({ items: input.items.map(item => ({ id: item.id, text: '   ' })) }) };
			}
		};
		const { default: aiService } = await import('../src/service/ai-service.js');
		await expect(aiService.translateBatch(c, 'zh', [{ id: 'n0001', text: 'Hello' }]))
			.rejects.toThrow();
	});

	it('每分钟限流是原子计数，超限直接拒绝', async () => {
		const { c } = await build();
		const { default: repository } = await import('../src/repository/translation-repository.js');
		const { default: consts } = await import('../src/const/translation-const.js');
		const window = Math.floor(Date.now() / 60000);
		for (let i = 0; i < consts.RATE_NEW_PER_MINUTE; i++) {
			expect(await repository.addRate(c, 1, window, consts.RATE_NEW_PER_MINUTE)).toBeTruthy();
		}
		expect(await repository.addRate(c, 1, window, consts.RATE_NEW_PER_MINUTE)).toBeNull();
	});

	it('失败任务不会被复用，重试会新建任务', async () => {
		const { c, sqlite } = await build('invalid');
		const { default: service } = await import('../src/service/email-translation-service.js');

		let payload = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(service.step(c, { jobId: payload.jobId }, 1)).rejects.toThrow();

		sqlite.prepare("UPDATE email_translation SET state = 'error' WHERE job_id = ?").run(payload.jobId);
		const again = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(again.jobId).not.toBe(payload.jobId);
	});
	it('过期清理先删分块再删任务，不会被外键挡住', async () => {
		const { c, sqlite } = await build();
		const { default: service } = await import('../src/service/email-translation-service.js');
		const { default: repository } = await import('../src/repository/translation-repository.js');

		const job = await service.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		sqlite.exec('PRAGMA foreign_keys = ON');
		sqlite.prepare('UPDATE email_translation SET expire_time = ? WHERE job_id = ?').run(Date.now() - 1000, job.jobId);

		const removed = await repository.cleanExpired(c, Date.now());
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM email_translation WHERE job_id = ?').get(job.jobId).n).toBe(0);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM email_translation_chunk WHERE job_id = ?').get(job.jobId).n).toBe(0);
	});
});