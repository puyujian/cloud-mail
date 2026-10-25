import DOMPurify from 'dompurify';

const ALLOW_TAGS = [
	'a', 'abbr', 'address', 'article', 'aside', 'b', 'blockquote', 'br', 'caption',
	'center', 'cite', 'col', 'colgroup', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
	'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
	'i', 'img', 'li', 'main', 'mark', 'ol', 'p', 'q', 's', 'section', 'small', 'span',
	'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u',
	'ul', 'pre', 'code'
];

const ALLOW_ATTR = [
	'class', 'id', 'style', 'align', 'valign', 'width', 'height', 'dir', 'lang', 'title',
	'href', 'target', 'rel', 'src', 'alt', 'border', 'hspace', 'vspace',
	'cellpadding', 'cellspacing', 'bgcolor', 'summary', 'colspan', 'rowspan',
	'nowrap', 'scope', 'span', 'start', 'type', 'color', 'face', 'size',
	// hidden 必须留：邮件用隐藏元素放 preheader，剥掉属性会把隐藏文本显示成正文
	'hidden', 'aria-hidden'
];

const FORBID_TAGS = [
	'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
	'form', 'input', 'button', 'select', 'option', 'textarea', 'base', 'meta', 'link',
	'svg', 'math', 'audio', 'video', 'source', 'track', 'template', 'noscript'
];

let hookInstalled = false;

// 内联 style 同样要过白名单：Shadow DOM 里的 position:fixed + inset + z-index
// 会让邮件正文盖住整个应用界面，这不是脚本注入但同样属于 UI 劫持
function cleanInlineStyle(el) {
	const raw0 = el.getAttribute('style');
	if (!raw0) return;
	// 先解码 CSS 转义，否则 p\6fsition / z-\69ndex 这类写法会绕过属性白名单
	const raw = stripCssComments(decodeCssEscapes(raw0)).replace(/\\/g, '');
	const kept = [];
	for (const part of raw.split(';')) {
		const index = part.indexOf(':');
		if (index < 1) continue;
		const name = part.slice(0, index).trim().toLowerCase();
		const value = part.slice(index + 1).trim();
		if (!name || !value) continue;
		if (RISKY_CSS_PROP.test(name)) continue;
		if (name === 'position' && ESCAPING_POSITION.test(value)) continue;
		if (DANGEROUS_CSS.test(value)) continue;
		kept.push(name + ': ' + value);
	}
	if (kept.length === 0) {
		el.removeAttribute('style');
		return;
	}
	el.setAttribute('style', kept.join('; '));
}

function installHook() {
	if (hookInstalled) return;
	DOMPurify.addHook('afterSanitizeAttributes', node => {
		if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
			node.setAttribute('rel', 'noopener noreferrer');
		}
		cleanInlineStyle(node);
	});
	hookInstalled = true;
}

/**
 * 清洗邮件 HTML（原文与译文共用）。
 * 返回可安全插入 Shadow DOM 的 HTML 字符串。
 */
export function sanitizeEmailHtml(html) {
	if (!html) return '';
	installHook();
	return DOMPurify.sanitize(String(html), {
		ALLOWED_TAGS: ALLOW_TAGS,
		ALLOWED_ATTR: ALLOW_ATTR,
		ALLOW_DATA_ATTR: false,
		FORBID_TAGS,
		FORBID_CONTENTS: ['script', 'style', 'template', 'noscript'],
		ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
		KEEP_CONTENT: true
	});
}

/**
 * 解析清洗后的 HTML，取出 body 的内联样式声明（用于替代旧的 bodyStyle 字符串注入）。
 */
export function extractBodyStyle(html) {
	if (!html) return '';
	const match = String(html).match(/<body[^>]*style="([^"]*)"/i);
	if (!match) return '';

	const safe = [];
	const allowed = new Set([
		'color', 'background', 'background-color', 'font', 'font-family', 'font-size',
		'line-height', 'text-align', 'padding', 'margin'
	]);
	// body 的 style 同样是攻击面：先解码再逐条白名单
	const bodyRaw = stripCssComments(decodeCssEscapes(match[1])).replace(/\\/g, '');
	for (const part of bodyRaw.split(';')) {
		const index = part.indexOf(':');
		if (index < 1) continue;
		const name = part.slice(0, index).trim().toLowerCase();
		const value = part.slice(index + 1).trim();
		if (!allowed.has(name) || !value) continue;
		if (/url\s*\(|expression|javascript:|@import/i.test(value)) continue;
		if (/[<>"]/.test(value)) continue;
		safe.push(name + ': ' + value);
	}
	return safe.join('; ');
}

/**
 * 邮件自带的 <style> 不能整段丢弃，否则依赖 class 的版式会全部走形。
 * 这里保留选择器与声明，但剔除所有能执行脚本或外联的写法，再注入 Shadow DOM
 * （Shadow DOM 天然把样式限制在组件内，不会污染宿主页面）。
 */
const DANGEROUS_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import|@charset|<\/style|<\/?[a-z]/gi;
// 与后端保持同一套白名单口径：定位逃逸属性会让邮件内容覆盖整个应用 UI
const RISKY_CSS_PROP = /^(z-index|inset|inset-[a-z]+|top|right|bottom|left|zoom|transform|transform-origin|filter|backdrop-filter|mix-blend-mode|clip-path|contain|will-change|perspective|animation|animation-[a-z]+|transition|transition-[a-z]+|pointer-events)$/;
// position:fixed|sticky 会脱离文档流贴住视口，任何容器都拦不住，邮件排版用不到
const ESCAPING_POSITION = /^\s*(fixed|sticky)\b/i;

// CSS 注释等价空白：position:/**/fixed 与 inset/**/:0 都合法，
// 不先折平就能整段绕过关键字过滤
function stripCssComments(css) {
	return String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// CSS 转义绕过：:h\6fst / p\6fsition 这类写法能躲开关键字过滤，先解码再校验
function decodeCssEscapes(css) {
	return String(css)
		.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?/g, (whole, hex) => {
			const code = parseInt(hex, 16);
			if (!code || code > 0x10ffff) return '';
			try {
				return String.fromCodePoint(code);
			} catch (e) {
				return '';
			}
		})
		.replace(/\\(.)/g, '$1');
}

export function extractEmailCss(html) {
	if (!html) return '';
	const blocks = [];
	const pattern = /<style([^>]*)>([\s\S]*?)<\/style>/gi;
	let match;
	while ((match = pattern.exec(String(html))) !== null) {
		// 只服务于打印的样式表不能注入屏幕视图，否则 @media print 之外的
		// print-only 规则会反过来影响网页排版
		const attrs = match[1] || '';
		const media = /media\s*=\s*["']?([^"'>]+)/i.exec(attrs);
		if (media && /print/i.test(media[1]) && !/screen/i.test(media[1])) continue;
		blocks.push(match[2]);
	}
	if (blocks.length === 0) return '';

	let css = stripCssComments(decodeCssEscapes(blocks.join('\n')));
	// 解码后仍残留的反斜杠全部清掉，杜绝二次转义
	css = css.replace(/\\/g, '').replace(DANGEROUS_CSS, '');
	// 声明级过滤：z-index / inset / fixed 组合能让邮件盖住整个应用界面
	css = css.replace(/([-a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([^;{}]*)/g, (whole, name, value) => {
		const prop = name.toLowerCase();
		if (RISKY_CSS_PROP.test(prop)) return '';
		if (prop === 'position' && ESCAPING_POSITION.test(value || '')) return '';
		return whole;
	});
	// :host / ::part 只对 Shadow 宿主生效，等于给邮件开了全局样式后门
	css = css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, selector) => {
		return /:host|::?slotted|::?part/i.test(selector) ? '' : whole;
	});
	// url() 只放行 http(s) 与内联图片，其余（含 js 协议与本地路径）一律去掉
	css = css.replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote, target) => {
		const value = String(target || '').trim();
		if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) {
			return 'url(' + JSON.stringify(value) + ')';
		}
		return 'none';
	});
	return css.slice(0, 100 * 1024);
}

export default sanitizeEmailHtml;