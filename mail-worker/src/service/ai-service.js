import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';
import translationConst from '../const/translation-const';
import translationPrompt from '../utils/translation-prompt';
import BizError from '../error/biz-error';
import { t, getT } from '../i18n/i18n';

// Workers AI 有两套返回形状：老的 { response } 和 -fast / 新模型的 OpenAI 兼容
// { choices: [{ message: { content } }] }。线上就是栽在这里：模型 2.5 秒就翻了，
// 我们按老形状取值取到 undefined，再报一句“AI 翻译结果校验失败”。
function extractAiText(response) {
	if (typeof response === 'string') {
		return response;
	}
	if (!response || typeof response !== 'object') {
		return '';
	}

	const readContent = content => {
		if (typeof content === 'string') {
			return content;
		}
		if (Array.isArray(content)) {
			return content.map(part => readContent(typeof part === 'string' ? part : part?.text)).join('');
		}
		// json 模式下模型已经把契约解析成对象，序列化回去交给下游解析器
		if (content && typeof content === 'object') {
			try {
				return JSON.stringify(content);
			} catch (e) {
				return '';
			}
		}
		return '';
	};

	// OpenAI 兼容形状：-fast 系与新模型
	const choice = Array.isArray(response.choices) ? response.choices[0] : null;
	const fromChoice = readContent(choice?.message?.content)
		|| readContent(choice?.text)
		|| readContent(choice?.delta?.content);
	if (fromChoice) {
		return fromChoice;
	}

	// 老形状
	for (const key of ['response', 'text', 'output_text']) {
		const value = readContent(response[key]);
		if (value) {
			return value;
		}
	}

	// ai.run 可能连 result 信封一起给
	if (response.result && typeof response.result === 'object') {
		const nested = readContent(response.result.choices?.[0]?.message?.content)
			|| readContent(response.result.response);
		if (nested) {
			return nested;
		}
	}

	return '';
}

// Gemini 的返回是 candidates[0].content.parts[]；带思考的模型会把思考过程塞进
// thought=true 的 part，那一段不是译文，混进来会直接把 JSON 契约撑坏
function extractGeminiText(payload) {
	const parts = payload?.candidates?.[0]?.content?.parts;
	if (!Array.isArray(parts)) {
		return '';
	}
	return parts
		.filter(part => part && part.thought !== true && typeof part.text === 'string')
		.map(part => part.text)
		.join('');
}

const aiService = {
	async extractCode(c, email, options = {}) {
		if (!this.shouldExtractCode(options.aiCode, options.aiCodeFilter, email)) {
			return '';
		}

		const ai = c.env.ai;

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, 6000);

			if (!subject && !body) {
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct-fast', {
				messages: [
					{
						role: 'system',
						content: 'You extract verification codes from emails. Return only JSON like {"code":"12345678"} or {"code":""}. The code must be 8 characters or fewer and must not contain spaces. If the code is longer than 8 characters or contains spaces, return {"code":""}. Do not explain.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 32
			});

			const content = extractAiText(result);
			const json = typeof content === 'string' ? JSON.parse(content) : content;
			if (typeof json.code !== 'string') {
				return '';
			}

			if (json.code.length > 8 || /\s/.test(json.code)) {
				return '';
			}

			return json.code;
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	},

	shouldExtractCode(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	},

	// 批量 JSON 契约拿不到时不要整块报废：这里按 id 校验、逐条补译，
	// 保证「漏项」只影响单条文本，而不是让整封邮件显示“翻译失败”

	// 模型输出经常带上 ```json 围栏或前后说明，直接 JSON.parse 会把可用结果判成失败
	parseItems(content) {
		if (typeof content !== 'string' || !content.trim()) {
			return null;
		}
		const text = content.trim();
		const candidates = [text];
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fenced) {
			candidates.push(fenced[1].trim());
		}
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start > -1 && end > start) {
			candidates.push(text.slice(start, end + 1));
		}
		for (const candidate of candidates) {
			try {
				const json = JSON.parse(candidate);
				if (Array.isArray(json?.items)) {
					return json.items;
				}
			} catch (e) {
				// 换下一种候选继续解析
			}
		}
		// 模型撞上 max_tokens 时 JSON 会在半截被截断（线上就是这样：8 条只回了 6 条，
		// 后面开始循环重复直到 token 用尽），整段解析必然失败。这里把已经完整的
		// {"id":...,"text":...} 对象捞出来，剩下的缺口交给逐条补译，别把整块判死。
		return this.salvageItems(text);
	},

	// 从被截断的 JSON 里逐个捞出完整的 {"id":…,"text":…} 对。
	// 截断时外层的 {"items":[ 根本没闭合，所以不能依赖括号配对，
	// 只认「这一对本身是完整的」：最后那条半截的自然不会被捞到，交给补译。
	salvageItems(text) {
		const found = [];
		const pattern = /"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
		let match;
		while ((match = pattern.exec(String(text || ''))) !== null) {
			try {
				found.push({
					id: JSON.parse('"' + match[1] + '"'),
					text: JSON.parse('"' + match[2] + '"')
				});
			} catch (e) {
				// 单条还原失败就跳过，交给补译
			}
		}
		return found.length > 0 ? found : null;
	},

	// 源文有内容却回空白是漏译；长度暴涨说明模型在乱写，两者都不能写进译文

	// 8B 模型偶发原地打转（线上整整 2755 个字符全是“为一个为一个…”）：
	// 这种文本没有翻译价值，退回原文
	guardLoops(item, text) {
		if (/(.{2,12})\1{4,}/.test(String(text))) {
			return String(item.text);
		}
		return text;
	},

	// 模型偶尔会把 2026-10-21 写成 "2026年1١"：数字被改动的译文比不译更糟，
	// 这一条退回原文（宁可一个节点保持原样，也不要把时间、IP 写错）
	guardDigits(item, text) {
		const source = (String(item.text).match(/\d/g) || []).join('');
		const output = (String(text).match(/\d/g) || []).join('');
		if (source && source !== output) {
			return String(item.text);
		}
		return text;
	},

	// 模型偶尔原样返回整句（线上 GitHub 通知邮件的标题、按钮、地址行就是），
	// 用户看到的结果就是“翻了个寂寞”：这类条目值得再单独翻一次
	isUntranslated(item, text) {
		const source = String(item?.text || '').trim();
		const output = String(text || '').trim();
		if (!source || output !== source) {
			return false;
		}
		// 中文没有词边界，按长度判断
		if (/[\u3400-\u9fff]/.test(source)) {
			return source.length >= 8;
		}
		const words = source.split(/\s+/).filter(word => /\p{L}/u.test(word));
		if (words.length < 3 || source.length < 12) {
			return false;
		}
		// 全大写的品牌/缩写、纯标识符原样保留是正常的
		return /\p{Ll}/u.test(source);
	},

	// 源文本来就已经是目标语言时（界面语言是英文、去翻一封英文邮件），
	// 「原样返回」是正确结果，再补译一次只会白白多烧一倍神经元
	alreadyTargetLang(item, lang) {
		const text = String(item?.text || '');
		const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
		const letters = (text.match(/\p{L}/gu) || []).length || 1;
		const share = cjk / letters;
		return String(lang) === 'zh' ? share > 0.3 : share < 0.05;
	},

	findUntranslated(items, lang, map) {
		const ids = new Set();
		for (const item of items) {
			const text = map.get(item.id);
			if (text === undefined) {
				continue;
			}
			if (this.alreadyTargetLang(item, lang)) {
				continue;
			}
			if (this.isUntranslated(item, text)) {
				ids.add(item.id);
			}
		}
		return ids;
	},

	// 剩余预算内的实际超时：整轮共用一条预算，别让每块各自 30s 叠成分钟级
	budget(timeoutMs, deadline) {
		// 不给下限：有 1s 下限的话 60s 的预算实际会跑到 60.x s，
		// 边界上正好越过前端超时；剩余多少就用多少，<=0 由调用方判超时
		const left = deadline - Date.now();
		if (left <= 0) {
			return 0;
		}
		return Math.min(timeoutMs, left);
	},

	// 写进译文的最后一道兜底：打转的文本、被改动的数字一律退回原文
	cleanUnit(item, text) {
		return this.guardDigits(item, this.guardLoops(item, text));
	},

	acceptUnit(item, text) {
		if (typeof text !== 'string') {
			return false;
		}
		if (item.text.trim() && !text.trim()) {
			return false;
		}
		return text.length <= item.text.length * 6 + 64;
	},

	// 允许模型改变返回顺序（集合对得上就够），未知 id、重复 id、异常条目一律丢弃等待补译
	collectItems(list, items, map) {
		const expected = new Map(items.map(item => [item.id, item]));
		for (const row of Array.isArray(list) ? list : []) {
			if (!row || typeof row.id !== 'string' || typeof row.text !== 'string') {
				continue;
			}
			const item = expected.get(row.id);
			if (!item || map.has(row.id)) {
				continue;
			}
			if (!this.acceptUnit(item, row.text)) {
				continue;
			}
			map.set(row.id, this.cleanUnit(item, row.text));
		}
		return map;
	},

	// 已经配好凭据、可以用的通道，按优先级排列
	// wrangler secret 注入的是大写变量名，wrangler.toml 的 var 是小写：
	// 两个都认，否则「配了 secret 却没生效」会静默退回 Workers AI（线上踩过）
	openaiKey(c) {
		return String(c.env?.AI_TRANSLATE_OPENAI_API_KEY || c.env?.ai_translate_openai_api_key || '').trim();
	},

	availableProviders(c) {
		const list = [];
		if (String(c.env?.ai_translate_openai_base_url || '').trim()
			&& this.openaiKey(c)
			&& String(c.env?.ai_translate_openai_model || '').trim()) {
			// OpenAI 兼容端点：硅基流动 / 魔搭 / DeepSeek / Groq / OpenRouter / 自建 one-api 都吃这套
			list.push('openai');
		}
		if (String(c.env?.GEMINI_API_KEY || '').trim()) {
			list.push('gemini');
		}
		if (c.env?.ai) {
			list.push('workers-ai');
		}
		return list;
	},

	// 通道选择：显式配置 > 按优先级挑第一个可用的 > Workers AI
	resolveProvider(c, override) {
		const raw = String(override || c.env?.ai_translate_provider || 'auto').trim().toLowerCase();
		if (raw === 'workers-ai' || raw === 'workers') {
			return 'workers-ai';
		}
		if (raw === 'gemini' || raw === 'openai') {
			return raw;
		}
		return this.availableProviders(c)[0] || 'workers-ai';
	},

	// 主用挂了换成谁：最多补一个备用通道，避免「回退 × 分块重试 × 补译」叠成重试风暴
	providerChain(c, primary) {
		const chain = [primary];
		if (String(c.env?.ai_translate_fallback || '').toLowerCase() === 'off') {
			return chain;
		}
		const backup = this.availableProviders(c).find(id => id !== primary);
		if (backup) {
			chain.push(backup);
		}
		return chain;
	},

	// 任务里存的是「通道:模型」。缓存键跟着换：不同通道产出的译文不同，
	// 缓存必须分开，否则换通道后用户拿到的还是上一套译文
	parseModelRef(ref) {
		const raw = String(ref || '').trim();
		if (!raw) {
			return null;
		}
		const known = ['gemini', 'workers-ai', 'openai'];
		const sep = raw.indexOf(':');
		const head = sep > 0 ? raw.slice(0, sep) : '';
		if (known.includes(head)) {
			const model = raw.slice(sep + 1);
			return model ? { provider: head, model } : null;
		}
		// 历史任务里存的是裸模型名（那时还没有通道概念）：一律按 Workers AI 解释。
		// 否则在途任务会被悄悄换成新主力通道，把别人的译文写进旧缓存键
		return { provider: 'workers-ai', model: raw };
	},

	workersModel(c) {
		return c.env?.ai_translate_model || c.env?.ai_model || translationConst.MODEL;
	},

	geminiModel(c) {
		return c.env?.ai_translate_gemini_model || translationConst.GEMINI_MODEL;
	},

	openaiModel(c) {
		return String(c.env?.ai_translate_openai_model || '').trim();
	},

	// 每条通道各自用的模型名：任务里存的是「通道:模型」，所以回退时也能还原对方的模型
	modelOfProvider(c, provider, ref) {
		if (ref?.provider === provider) {
			return ref.model;
		}
		if (provider === 'gemini') {
			return this.geminiModel(c);
		}
		if (provider === 'openai') {
			return this.openaiModel(c);
		}
		return this.workersModel(c);
	},

	modelRefOf(c, provider) {
		const id = provider || this.resolveProvider(c);
		const model = this.modelOfProvider(c, id, null);
		return `${id}:${model || 'unset'}`;
	},

	modelPlan(c, options = {}) {
		const ref = this.parseModelRef(options.model);
		const provider = ref?.provider || this.resolveProvider(c);
		return {
			provider,
			// 计划里三条通道的模型名都带上，回退时直接取用，不用重新推断
			openaiModel: this.modelOfProvider(c, 'openai', ref),
			geminiModel: this.modelOfProvider(c, 'gemini', ref),
			workersModel: this.modelOfProvider(c, 'workers-ai', ref)
		};
	},

	// 超时/网络中断 = 结果未知：这种失败不能换通道重发，否则同一段文本被翻两遍、计费两遍
	uncertainError(c, errorKey, code) {
		const error = new BizError(getT(c)(errorKey), code, errorKey);
		error.uncertain = true;
		return error;
	},

	// HTTP 通道的错误分类：只有“明确的拒绝”才允许换通道重发。
	// 5xx / 408 / 504 说明上游可能已经执行过，换通道等于同一段文本再翻一遍、再计费一遍
	httpError(c, response, payload, label) {
		const detail = String(payload?.error?.message || '').replace(/\s+/g, ' ').slice(0, 160);
		if (response.status === 429) {
			const error = new BizError(getT(c)('translationRateLimited'), 429, 'translationRateLimited');
			error.fallbackable = true;
			return error;
		}
		if (response.status >= 500 || response.status === 408) {
			const error = this.uncertainError(c, 'translationTimeout', 504);
			error.message = `${getT(c)('translationTimeout')}（${label} ${response.status}${detail ? `：${detail}` : ''}）`;
			return error;
		}
		const error = new BizError(
			`${getT(c)('translationModelFailed')}（${label} ${response.status}${detail ? `：${detail}` : ''}）`,
			502,
			'translationModelFailed'
		);
		error.fallbackable = true;
		return error;
	},

	transportError(c, e) {
		if (e?.name === 'BizError') {
			return e;
		}
		const detail = String(e?.message || e || '').replace(/\s+/g, ' ').slice(0, 160);
		const error = this.uncertainError(c, 'translationModelFailed', 502);
		if (detail) {
			error.message = `${error.message}（${detail}）`;
		}
		return error;
	},

	// 2.5-flash 默认先“思考”再回答：思考 token 也算在 maxOutputTokens 里，
	// 长邮件很容易被思考吃光输出预算。翻译是机械任务，默认关掉
	geminiThinkingBudget(c) {
		const raw = Number(c.env?.ai_translate_gemini_thinking_budget ?? 0);
		return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
	},

	async runWorkersAi(c, model, messages, timeoutMs, maxTokens, deadline) {
		// 每次真正发起调用前都重算剩余预算，别让重试各自再拿一份完整时长
		const slice = this.budget(timeoutMs, deadline);
		if (slice <= 0) {
			throw this.uncertainError(c, 'translationTimeout', 504);
		}
		const runPromise = c.env.ai.run(model, { messages, temperature: 0, max_tokens: maxTokens });
		// 超时先返回时，模型 promise 仍可能稍后 reject，这里挂一个兜底避免未处理拒绝
		runPromise.catch(() => {});

		let timer = null;
		const timeoutPromise = new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(this.uncertainError(c, 'translationTimeout', 504)), slice);
		});

		let response;
		try {
			response = await Promise.race([runPromise, timeoutPromise]);
		} catch (e) {
			if (e?.name === 'BizError') {
				throw e;
			}
			const mapped = this.transportError(c, e);
			// 限流/配额这类“明确拒绝”可以换通道顶上；真正的传输未知不行
			if (/429|rate.?limit|neurons|quota|capacity/i.test(String(e?.message || ''))) {
				mapped.uncertain = false;
				mapped.fallbackable = true;
			}
			throw mapped;
		} finally {
			if (timer) clearTimeout(timer);
		}

		return {
			text: extractAiText(response),
			usage: response?.usage || null,
			finish: response?.finish_reason || response?.finishReason || response?.finish || null,
			truncated: Number(response?.usage?.completion_tokens || 0) >= maxTokens,
			shape: response === null ? 'null' : typeof response,
			keys: response && typeof response === 'object' ? Object.keys(response) : []
		};
	},

	async runGemini(c, model, messages, timeoutMs, maxTokens, deadline) {
		const key = String(c.env?.GEMINI_API_KEY || '').trim();
		if (!key) {
			const error = new BizError(getT(c)('translationAiUnavailable'), 503, 'translationAiUnavailable');
			error.detail = 'GEMINI_API_KEY 未配置';
			error.fallbackable = true;
			throw error;
		}

		// 测试里注入假 fetch；生产就是全局 fetch
		const doFetch = typeof c.env?.translateFetch === 'function' ? c.env.translateFetch : fetch;
		const system = messages.filter(row => row.role === 'system').map(row => String(row.content || '')).join('\n');
		const contents = messages
			.filter(row => row.role !== 'system')
			.map(row => ({ role: 'user', parts: [{ text: String(row.content || '') }] }));
		const url = `${translationConst.GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

		// 批量契约要求纯 JSON：交给 Gemini 的 responseMimeType 强制住，
		// 省掉「围栏 + 前后解释文字」这一类解析事故；补译是纯文本契约，不能加
		const wantsJson = /"items"/.test(system);
		const buildBody = thinking => ({
			contents,
			...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
			generationConfig: {
				temperature: 0,
				maxOutputTokens: maxTokens,
				...(wantsJson ? { responseMimeType: 'application/json' } : {}),
				...(thinking ? { thinkingConfig: { thinkingBudget: this.geminiThinkingBudget(c) } } : {})
			}
		});

		let response = null;
		let bodyText = '';
		for (let attempt = 0; attempt < 2; attempt++) {
			const slice = this.budget(timeoutMs, deadline);
			if (slice <= 0) {
				throw this.uncertainError(c, 'translationTimeout', 504);
			}
			({ response, bodyText } = await this.postJson(c, doFetch, url, { 'x-goog-api-key': key }, buildBody(attempt === 0), slice));
			// 这个模型版本不认 thinkingConfig 时去掉它重发一次，别把 400 当成翻译失败
			if (!response.ok && attempt === 0 && response.status === 400 && /thinking/i.test(bodyText)) {
				continue;
			}
			break;
		}

		let payload = null;
		try {
			payload = bodyText ? JSON.parse(bodyText) : null;
		} catch (e) {
			payload = null;
		}

		if (!response.ok) {
			throw this.httpError(c, response, payload, 'Gemini');
		}
		// 200 但信封坏掉：模型很可能已经跑完并计费了，属于结果未知，不许换通道重发
		if (!payload) {
			throw this.uncertainError(c, 'translationModelFailed', 504);
		}

		const candidate = payload?.candidates?.[0] || null;
		const finish = candidate?.finishReason || payload?.promptFeedback?.blockReason || null;
		return {
			text: extractGeminiText(payload),
			usage: payload?.usageMetadata || null,
			finish,
			truncated: finish === 'MAX_TOKENS' || Number(payload?.usageMetadata?.candidatesTokenCount || 0) >= maxTokens,
			shape: 'gemini',
			keys: payload && typeof payload === 'object' ? Object.keys(payload) : []
		};
	},

	// 两个 HTTP 通道共用的 POST：统一超时 + 超时语义
	async postJson(c, doFetch, url, headers, body, timeoutMs) {
		const controller = typeof AbortController === 'function' ? new AbortController() : null;
		let timer = null;
		if (controller) {
			timer = setTimeout(() => controller.abort(), timeoutMs);
		}
		try {
			const response = await doFetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify(body),
				signal: controller ? controller.signal : undefined
			});
			// 响应头比正文先到是常态：正文读取也必须留在同一个超时窗口里，
			// 否则“收到头就撤计时器”等于让请求无限等下去
			let bodyText = '';
			try {
				bodyText = typeof response.text === 'function' ? await response.text() : '';
			} catch (e) {
				// 正文读不出来 = 不知道模型到底执没执行，属于结果未知，不许换通道重发
				throw this.uncertainError(c, 'translationModelFailed', 504);
			}
			return { response, bodyText };
		} catch (e) {
			if (e?.name === 'BizError') {
				throw e;
			}
			// AbortError 是我们自己超时；其它网络错误同样属于“结果未知”
			throw this.uncertainError(c, e?.name === 'AbortError' ? 'translationTimeout' : 'translationModelFailed', 504);
		} finally {
			if (timer) clearTimeout(timer);
		}
	},

	// OpenAI 兼容端点（硅基流动 / 魔搭 ModelScope / DeepSeek / Groq / OpenRouter / 自建 one-api）
	async runOpenAi(c, model, messages, timeoutMs, maxTokens, deadline) {
		const baseUrl = String(c.env?.ai_translate_openai_base_url || '').trim().replace(/\/+$/, '');
		const key = this.openaiKey(c);
		if (!baseUrl || !key || !model) {
			const error = new BizError(getT(c)('translationAiUnavailable'), 503, 'translationAiUnavailable');
			error.detail = 'ai_translate_openai_base_url / api_key / model 未配全';
			error.fallbackable = true;
			throw error;
		}

		const doFetch = typeof c.env?.translateFetch === 'function' ? c.env.translateFetch : fetch;
		const system = messages.filter(row => row.role === 'system').map(row => String(row.content || '')).join('\n');
		const wantsJson = /"items"/.test(system) && String(c.env?.ai_translate_openai_json_mode || '').toLowerCase() === 'on';
		const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
		const buildBody = jsonMode => ({
			model,
			messages: messages.map(row => ({ role: row.role, content: String(row.content || '') })),
			temperature: 0,
			max_tokens: maxTokens,
			stream: false,
			...(jsonMode ? { response_format: { type: 'json_object' } } : {})
		});

		let response = null;
		let bodyText = '';
		for (let attempt = 0; attempt < 2; attempt++) {
			const slice = this.budget(timeoutMs, deadline);
			if (slice <= 0) {
				throw this.uncertainError(c, 'translationTimeout', 504);
			}
			({ response, bodyText } = await this.postJson(c, doFetch, url, { Authorization: `Bearer ${key}` }, buildBody(wantsJson && attempt === 0), slice));
			// 有的兼容端点不认 response_format，去掉它重发一次，别把 400 当成翻译失败
			if (!response.ok && attempt === 0 && response.status === 400 && /response_format|json_object|max_tokens/i.test(bodyText)) {
				continue;
			}
			break;
		}

		let payload = null;
		try {
			payload = bodyText ? JSON.parse(bodyText) : null;
		} catch (e) {
			payload = null;
		}

		if (!response.ok) {
			throw this.httpError(c, response, payload, 'HTTP');
		}
		if (!payload) {
			throw this.uncertainError(c, 'translationModelFailed', 504);
		}

		const usage = payload?.usage || null;
		const finish = payload?.choices?.[0]?.finish_reason || payload?.finish_reason || null;
		return {
			text: extractAiText(payload),
			usage,
			finish,
			truncated: finish === 'length' || Number(usage?.completion_tokens || 0) >= maxTokens,
			shape: 'openai',
			keys: payload && typeof payload === 'object' ? Object.keys(payload) : []
		};
	},

	modelResult(c, provider, model, result, startedAt, maxTokens) {
		const content = String(result?.text || '');
		if (!content.trim()) {
			// 空返回也要把响应形状带出来，否则线上只看到一句“结果校验失败”
			console.error('模型空返回', JSON.stringify({
				provider,
				model,
				ms: Date.now() - startedAt,
				shape: result?.shape || null,
				keys: result?.keys || []
			}));
			const error = new BizError(getT(c)('translationInvalidOutput'), 502, 'translationInvalidOutput');
			// 空返回换另一个通道还有机会
			error.fallbackable = true;
			throw error;
		}
		return {
			content,
			// 线上只发 errorKey 无法定位问题：把模型到底回了什么留在日志里，tail 一次就能看
			meta: {
				provider,
				model,
				ms: Date.now() - startedAt,
				usage: result?.usage || null,
				// 输出被截断时模型往往在原地打转，日志里要能一眼看出来
				maxTokens,
				truncated: !!result?.truncated,
				finish: result?.finish || null,
				len: content.length,
				head: content.slice(0, 320),
				tail: content.length > 480 ? content.slice(-160) : ''
			}
		};
	},

	// 返回结果时带上“这块到底是谁翻的”：主力通道之外还混进了兜底通道时，
	// 上游调用方不能把它当成主力通道的成果写进可复用缓存
	batchResult(plan, modelRef, state) {
		const used = Array.from(state.providers || []);
		const provider = used.length === 1 ? used[0] : plan.provider;
		return {
			map: state.map,
			model: modelRef,
			provider,
			// 一块里既用了主力又用了兜底（例如批量走主力、补译走了兜底）也算混入：
			// 只看 provider 会漏掉这种「半块是别家译文」的情况
			mixed: used.some(id => id !== plan.provider)
		};
	},

	callProvider(c, provider, model, messages, timeoutMs, maxTokens, deadline) {
		if (provider === 'gemini') {
			return this.runGemini(c, model, messages, timeoutMs, maxTokens, deadline);
		}
		if (provider === 'openai') {
			return this.runOpenAi(c, model, messages, timeoutMs, maxTokens, deadline);
		}
		return this.runWorkersAi(c, model, messages, timeoutMs, maxTokens, deadline);
	},

	async runModel(c, messages, timeoutMs, plan, deadline) {
		const startedAt = Date.now();
		const maxTokens = translationConst.AI_MAX_TOKENS;
		// 回退链路共用同一个绝对截止时间：换通道不能重新拿一份完整时长
		const absolute = Number.isFinite(deadline) ? deadline : startedAt + timeoutMs;
		// 主用通道被限流/5xx/密钥失效时用另一个顶上，
		// 用户不该因为“主力通道今天被限流”就看到翻译失败
		const order = this.providerChain(c, plan.provider);

		let lastError = null;
		for (let i = 0; i < order.length; i++) {
			if (absolute - Date.now() <= 0) {
				throw lastError || this.uncertainError(c, 'translationTimeout', 504);
			}
			const provider = order[i];
			const model = provider === 'gemini'
				? plan.geminiModel
				: provider === 'openai' ? plan.openaiModel : plan.workersModel;
			try {
				const result = await this.callProvider(c, provider, model, messages, timeoutMs, maxTokens, absolute);
				return this.modelResult(c, provider, model, result, startedAt, maxTokens);
			} catch (e) {
				lastError = e;
				// 超时/未知结果不换通道；明确的失败（限流、5xx、密钥问题、空返回）才换
				if (e?.uncertain === true || e?.fallbackable !== true) {
					throw e;
				}
				if (i < order.length - 1) {
					console.warn('翻译通道切换', provider, '→', order[i + 1], e?.message);
				}
			}
		}
		throw lastError || new BizError(getT(c)('translationAiUnavailable'), 503, 'translationAiUnavailable');
	},

	cleanUnitOutput(content) {
		return String(content || '')
			.trim()
			// 模型偶尔把整段译文放进引号里，或加一行「译文：」前缀
			.replace(/^["'“”『「]+/, '')
			.replace(/["'“”』」]+$/, '')
			.replace(/^(translation|译文|翻译)\s*[:：]\s*/i, '')
			.trim();
	},

	// 逐条补译：并行发起，单条失败不影响其它条目，总覆盖面由调用方判定
	async repairUnits(c, lang, items, plan, state, redo = null, deadline = Number.MAX_SAFE_INTEGER) {
		// 只补缺口：已经拿到的条目不再重发，避免同一条文本被模型计费两次；
		// redo 里的条目是「模型原样返回了原文」，需要覆盖重译
		const targets = items
			.filter(item => !state.map.has(item.id) || redo?.has(item.id))
			.slice(0, translationConst.REPAIR_MAX_UNITS);
		const slice = this.budget(translationConst.REPAIR_TIMEOUT_MS, deadline);
		if (!targets.length || slice <= 0) {
			return state;
		}
		const settled = await Promise.allSettled(targets.map(async item => {
			const { content, meta } = await this.runModel(
				c,
				[
					{ role: 'system', content: translationPrompt.unitSystem(lang) },
					{ role: 'user', content: item.text }
				],
				translationConst.REPAIR_TIMEOUT_MS,
				plan,
				deadline
			);
			state.providers.add(meta.provider);
			return [item.id, this.cleanUnitOutput(content)];
		}));

		for (let i = 0; i < settled.length; i++) {
			const item = targets[i];
			const row = settled[i];
			if (row.status === 'rejected') {
				if (row.reason?.uncertain === true) {
					state.uncertain = true;
				}
				console.warn('翻译补译失败', row.reason?.message);
				continue;
			}
			const [id, text] = row.value;
			// 纯文本契约下模型仍可能回一段 JSON：那不是译文，宁可判失败
			if (/^\s*[[{]/.test(text) && /"(items|id|text)"\s*:/.test(text)) {
				continue;
			}
			if (this.acceptUnit(item, text)) {
				state.map.set(id, this.cleanUnit(item, text));
			}
		}
		return state;
	},

	async translateBatch(c, lang, items, options = {}) {
		const plan = this.modelPlan(c, options);
		const modelRef = this.modelRefOf(c, plan.provider);
		const timeoutMs = options.timeoutMs || translationConst.AI_TIMEOUT_MS;
		// 整轮预算：批量 + 补译共享，避免「每块每次都限时」叠起来超过前端超时
		const deadline = Date.now() + translationConst.AI_BATCH_BUDGET_MS;

		// 一条通道都没配才算真的不可用；单条通道缺凭据由它自己抛 fallbackable 错误交给回退
		if (this.availableProviders(c).length === 0) {
			throw new BizError(getT(c)('translationAiUnavailable'), 503, 'translationAiUnavailable');
		}
		if (!Array.isArray(items) || items.length === 0) {
			return { map: new Map(), model: modelRef, provider: plan.provider };
		}
		// providers 记录这一块实际用到的通道：兜底产物不能当成主力通道的结果缓存
		const state = { map: new Map(), uncertain: false, providers: new Set() };
		let batchError = null;
		// 只有「模型按 JSON 契约回了东西、但漏了几条」才值得补译
		let canRepair = false;
		let redo = new Set();

		try {
			const run = await this.runModel(c, [
				{ role: 'system', content: translationPrompt.system(lang) },
				{ role: 'user', content: translationPrompt.user(lang, items) }
			], timeoutMs, plan, deadline);
			state.providers.add(run.meta.provider);
			const list = this.parseItems(run.content);
			if (list) {
				canRepair = true;
				this.collectItems(list, items, state.map);
			}
			// 全齐了但仍有整句原样返回：补一次单条翻译，别让用户看到半中半英
			redo = canRepair ? this.findUntranslated(items, lang, state.map) : new Set();
			if (state.map.size === items.length && redo.size === 0) {
				return this.batchResult(plan, modelRef, state);
			}
			if (state.map.size !== items.length) {
				console.error('翻译输出异常', JSON.stringify({
					...run.meta,
					want: items.length,
					got: state.map.size,
					parsed: !!list
				}));
			}
			batchError = new BizError(getT(c)('translationInvalidOutput'), 502, 'translationInvalidOutput');
		} catch (e) {
			// 超时与网关异常属于“结果未知”：不补译，避免同一个模型被重复计费
			if (e?.uncertain === true) {
				throw e;
			}
			batchError = e;
		}

		// 整段不是 JSON 说明模型根本没在工作：这时补译只会把垃圾文本当译文存下来，
		// 直接把失败抛给调用方，由分块重试或用户重试处理
		if (canRepair) {
			await this.repairUnits(c, lang, items, plan, state, redo, deadline);
			if (state.map.size === items.length) {
				return this.batchResult(plan, modelRef, state);
			}
		}

		if (batchError && state.uncertain) {
			batchError.uncertain = true;
		}
		throw batchError || new BizError(getT(c)('translationInvalidOutput'), 502, 'translationInvalidOutput');
	}
};

aiService.extractText = extractAiText;
aiService.extractGeminiText = extractGeminiText;

export default aiService;