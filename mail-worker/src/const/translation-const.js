const translationConst = {
	LANG: {
		ZH: 'zh',
		EN: 'en'
	},
	SUPPORT_LANG: ['zh', 'en'],
	STATE: {
		PENDING: 'pending',
		RUNNING: 'running',
		DONE: 'done',
		ERROR: 'error'
	},
	CHUNK_STATUS: {
		WAIT: 0,
		RUNNING: 1,
		DONE: 2,
		FAILED: 3
	},
	FORMAT: {
		HTML: 'html',
		TEXT: 'text'
	},
	// Workers AI 通道（兜底通道）用的模型
	MODEL: '@cf/meta/llama-3.1-8b-instruct-fast',
	// 主力通道：Gemini 免费档（免信用卡，按项目限 RPM/RPD，比 Workers AI 免费神经元宽松得多）
	// 注意：切换通道会改变缓存键，同一封邮件换通道要重新翻译一次
	GEMINI_MODEL: 'gemini-2.5-flash',
	GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',
	PROMPT_VERSION: 'email-translate-v4',
	PARSER_VERSION: 'dom-v1',
	SANITIZER_VERSION: 'safe-dom-v1',
	// 单块最多承载的文本单元数量；条目越多模型越容易漏项/重复，8 是实测稳定点
	CHUNK_MAX_ITEMS: 8,
	// 单块源文本 UTF-8 字节上限（保守值，实际模型窗口以部署配置为准）
	CHUNK_MAX_BYTES: 1600,
	// 单个文本单元超过该字节数时按句/空白拆分
	UNIT_MAX_BYTES: 600,
	// 邮件自带 <style> 的保留上限（保留 class 版式，但不放大体积）
	MAX_EMAIL_CSS_BYTES: 100 * 1024,
	// 全文限制
	MAX_HTML_BYTES: 256 * 1024,
	MAX_TEXT_CODEPOINTS: 32 * 1024,
	MAX_DOM_NODES: 10000,
	MAX_DOM_DEPTH: 64,
	// 分块数上限：单块条目数下调后要相应放宽，避免长邮件被判超限
	// 8 × 48 个单元仍能覆盖长邮件；分块多不等于慢，前端每轮只推进一块
	MAX_CHUNKS: 48,
	// 单次模型调用等待上限（毫秒）；超时属于结果未知，不自动重发
	// 4096 token 的输出在长邮件上要 20s 以上；外部通道（中继/免费档）在大块上
	// 偶发 20~30s，30s 会被判成超时。45s 仍在 60s 单轮预算与前端 70s 之内
	AI_TIMEOUT_MS: 45 * 1000,
	// llama 把中文写成 \uXXXX 转义时一个汉字要烧 2~3 个 token，2048 很容易被一封长邮件打满
	AI_MAX_TOKENS: 4096,
	// 单次 step 的总预算：批量 + 补译共享它。前端 70s 超时、分块租约 120s，
	// 不设总预算的话「每块每次限时 30s」叠起来能拖到分钟级，用户先看到前端超时
	AI_BATCH_BUDGET_MS: 60 * 1000,
	// 批量 JSON 契约失败时，逐条用纯文本契约补译的上限与单条超时：
	// 漏项比整块作废便宜得多，但不允许无限重发
	REPAIR_MAX_UNITS: 8,
	REPAIR_TIMEOUT_MS: 12 * 1000,
	// 分块租约（毫秒）
	LEASE_MS: 120 * 1000,
	// 任务保留天数
	JOB_EXPIRE_DAYS: 7,
	// 每轮清理的最大任务数：D1 单查询绑定参数上限是 100，IN (...) 不能超
	CLEAN_BATCH_SIZE: 100,
	// KV 结果缓存保留秒数
	KV_TTL: 7 * 24 * 60 * 60,
	// 限流：每分钟新建任务数、每日新建任务数、每日可译字符数
	RATE_NEW_PER_MINUTE: 5,
	RATE_NEW_PER_DAY: 20,
	DAILY_CODEPOINT_BUDGET: 100000,
	// 排除翻译的标签
	SKIP_TAGS: ['script', 'style', 'head', 'title', 'template', 'noscript', 'code', 'pre'],
	// 允许保留的标签白名单
	ALLOW_TAGS: [
		'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
		'center', 'cite', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
		'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
		'i', 'img', 'li', 'main', 'mark', 'ol', 'p', 'q', 's', 'section', 'small', 'span',
		'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u',
		'ul', 'pre', 'code'
	],
	// 直接移除的标签
	DROP_TAGS: [
		'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
		'form', 'input', 'button', 'select', 'option', 'textarea', 'base', 'meta', 'link',
		'svg', 'math', 'audio', 'video', 'source', 'track', 'template', 'noscript'
	],
	// 允许保留的属性
	ALLOW_ATTR: {
		// hidden / aria-hidden 必须保留：清洗后还要靠它们判断「这段不该翻」
		'*': ['class', 'id', 'style', 'align', 'valign', 'width', 'height', 'dir', 'lang', 'title',
			'hidden', 'aria-hidden'],
		a: ['href', 'target', 'rel'],
		img: ['src', 'alt', 'border', 'hspace', 'vspace'],
		table: ['border', 'cellpadding', 'cellspacing', 'bgcolor', 'summary'],
		td: ['colspan', 'rowspan', 'bgcolor', 'nowrap'],
		th: ['colspan', 'rowspan', 'bgcolor', 'nowrap', 'scope'],
		col: ['span'],
		colgroup: ['span'],
		ol: ['start', 'type'],
		ul: ['type'],
		font: ['color', 'face', 'size']
	},
	// 允许保留的 CSS 属性（值还会再做一次危险函数过滤）
	ALLOW_CSS: [
		'color', 'background-color', 'background', 'font', 'font-family', 'font-size',
		'font-weight', 'font-style', 'text-align', 'text-decoration', 'text-indent',
		'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'vertical-align',
		'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
		'border-color', 'border-style', 'border-width', 'border-collapse', 'border-spacing',
		'border-radius', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
		'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
		'margin-left', 'width', 'height', 'max-width', 'min-width', 'display', 'float',
		'clear', 'overflow', 'table-layout', 'list-style-type', 'caption-side',
		// 隐藏类样式同样要留：去掉它们会让预header 等隐藏文本变成可见正文
		'visibility', 'mso-hide'
	],
	LINK_PROTOCOL: ['http:', 'https:', 'mailto:', 'tel:']
};

export default translationConst;
