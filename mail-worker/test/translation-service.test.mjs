import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import translationSchema from '../src/const/translation-schema';

// 用 node:sqlite 模拟 D1，验证任务状态机、分块租约与结果回填
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

function createAi() {
	const calls = [];
	return {
		calls,
		async run(model, payload) {
			calls.push({ model, payload });
			const input = JSON.parse(payload.messages[1].content);
			const items = input.items.map(item => ({ id: item.id, text: '[译]' + item.text }));
			return { response: JSON.stringify({ items }) };
		}
	};
}

const EMAIL = {
	email_id: 7,
	account_id: 3,
	subject: 'Hello',
	content: '<div><p>Hello <b>world</b></p><p>Second line</p><img src="{{domain}}/a.png"></div>',
	text: 'Hello world\nSecond line'
};

async function buildContext() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec('CREATE TABLE email (email_id INTEGER PRIMARY KEY, account_id INTEGER, user_id INTEGER, content TEXT, text TEXT, is_del INTEGER DEFAULT 0)');
	sqlite.exec('CREATE TABLE account (account_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER DEFAULT 0)');
	for (const sql of translationSchema) sqlite.exec(sql);
	sqlite.exec('INSERT INTO account (account_id, user_id, is_del) VALUES (3, 1, 0)');
	sqlite.prepare('INSERT INTO email (email_id, account_id, user_id, content, text, is_del) VALUES (?, ?, ?, ?, ?, 0)')
		.run(EMAIL.email_id, EMAIL.account_id, 1, EMAIL.content, EMAIL.text);

	const env = { db: createD1(sqlite), kv: createKv(), ai: createAi() };
	return { c: { env }, sqlite, env };
}

describe('email-translation-service', () => {

	it('分块翻译并保留 HTML 结构', async () => {
		const { c, env } = await buildContext();
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		let payload = await translationService.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(payload.state).toBe('pending');
		expect(payload.progress.total).toBeGreaterThan(0);

		let guard = 0;
		while (payload.state !== 'done') {
			payload = await translationService.step(c, { jobId: payload.jobId }, 1);
			guard += 1;
			expect(guard).toBeLessThan(20);
		}

		expect(payload.format).toBe('html');
		expect(payload.fallback).toBe(false);
		expect(payload.content).toContain('<b>[译]world</b>');
		expect(payload.content).toContain('[译]Hello');
		expect(payload.content).toContain('{{domain}}/a.png');
		expect(env.ai.calls.length).toBe(payload.progress.total);
		expect(env.ai.calls[0].payload.temperature).toBe(0);
	});

	it('重复请求命中缓存且不再调用模型', async () => {
		const { c, env } = await buildContext();
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		let payload = await translationService.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		while (payload.state !== 'done') {
			payload = await translationService.step(c, { jobId: payload.jobId }, 1);
		}
		const callsAfterFirst = env.ai.calls.length;

		const again = await translationService.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		expect(again.state).toBe('done');
		expect(again.cached).toBe(true);
		expect(again.content).toBe(payload.content);
		expect(env.ai.calls.length).toBe(callsAfterFirst);
	});

	it('他人邮件不可翻译', async () => {
		const { c } = await buildContext();
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		await expect(translationService.start(c, { emailId: 7, targetLang: 'zh' }, 2))
			.rejects.toThrow('邮件不存在或不可访问');
	});

	it('拒绝不支持的语言', async () => {
		const { c } = await buildContext();
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		await expect(translationService.start(c, { emailId: 7, targetLang: 'fr' }, 1))
			.rejects.toThrow('目标语言不受支持');
	});

	it('模型返回非法结构时任务标记失败', async () => {
		const { c, env } = await buildContext();
		env.ai.run = async () => ({ response: 'not json' });
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		const payload = await translationService.start(c, { emailId: 7, targetLang: 'zh' }, 1);
		await expect(translationService.step(c, { jobId: payload.jobId }, 1))
			.rejects.toThrow('AI 翻译结果校验失败');
	});

	it('纯文本邮件走 text 模式', async () => {
		const { c, sqlite } = await buildContext();
		sqlite.prepare('UPDATE email SET content = ? WHERE email_id = 7').run('');
		const { default: translationService } = await import('../src/service/email-translation-service.js');

		let payload = await translationService.start(c, { emailId: 7, targetLang: 'en' }, 1);
		while (payload.state !== 'done') {
			payload = await translationService.step(c, { jobId: payload.jobId }, 1);
		}
		expect(payload.format).toBe('text');
		expect(payload.text).toContain('[译]Hello world');
	});
});
