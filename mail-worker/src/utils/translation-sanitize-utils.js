import translationConst from '../const/translation-const';

const DROP_TAGS = new Set(translationConst.DROP_TAGS);
const ALLOW_TAGS = new Set(translationConst.ALLOW_TAGS);
const ALLOW_CSS = new Set(translationConst.ALLOW_CSS);
const LINK_PROTOCOL = new Set(translationConst.LINK_PROTOCOL);
const GLOBAL_ATTR = new Set(translationConst.ALLOW_ATTR['*']);

const DANGEROUS_CSS = /expression\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding|url\s*\(|\\|<|>/i;
// <style> 块允许 url()，因此单独一套规则：先剔除可执行的构造，再逐个校验 url 目标
const DANGEROUS_CSS_BLOCK = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import|@charset|<\/style|<\/?[a-z]/gi;
// <style> 是唯一能突破内联白名单的入口：position:fixed + inset + z-index 这类组合
// 会让邮件内容盖住整个应用界面，因此按声明级剔除，而不是只过滤 url()
const RISKY_CSS_PROP = /^(z-index|inset|inset-[a-z]+|top|right|bottom|left|zoom|transform|transform-origin|filter|backdrop-filter|mix-blend-mode|clip-path|contain|will-change|perspective|animation|animation-[a-z]+|transition|transition-[a-z]+|pointer-events)$/;
const DECLARATION = /([-a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([^;{}]*)/g;
// position:fixed|sticky 会让内容脱离文档流覆盖视口，邮件排版用不到
const ESCAPING_POSITION = /^\s*(fixed|sticky)\b/i;

// CSS 注释等价于空白：position:/**/fixed 与 inset/**/:0 在浏览器里都合法，
// 按原文字符串过滤会被完整绕过，因此先按 CSS 语义把注释折成空格
function stripCssComments(css) {
	return String(css).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

// CSS 允许 \6f 这类转义写属性名与伪类，正则直接匹配原文会被绕过
// （:h\6fst、p\6fsition 都能过关键字过滤）。先解码成明文再过滤。
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

const sanitizeUtils = {

	// 邮件靠 <style> 里的 class 控制版式（含 display:none 的 preheader）。
	// 整段丢弃会让隐藏文本在译文里显形，因此清洗后原样带回输出。
	extractStyleText(document) {
		const blocks = [];
		document.querySelectorAll('style').forEach(el => {
			// print-only 样式表不能注入屏幕视图，否则 @media print 外的规则会干扰网页排版
			const media = String(el.getAttribute('media') || '');
			if (/print/i.test(media) && !/screen/i.test(media)) return;
			blocks.push(el.textContent || '');
		});
		if (blocks.length === 0) return '';
		let css = stripCssComments(decodeCssEscapes(blocks.join('\n')));
		// 解码后仍残留的反斜杠一律去掉，避免二次转义绕过后续过滤
		css = css.replace(/\\/g, '').replace(DANGEROUS_CSS_BLOCK, '');
		// 声明级过滤：z-index / inset / fixed 这类定位逃逸一律剔除
		css = css.replace(DECLARATION, (whole, name, value) => {
			const prop = name.toLowerCase();
			if (RISKY_CSS_PROP.test(prop)) return '';
			if (prop === 'position' && ESCAPING_POSITION.test(value || '')) return '';
			return whole;
		});
		// 选择器级过滤：:host 只对 Shadow 宿主生效，相当于给邮件开了全局样式后门
		css = css.replace(/([^{}]+)\{([^{}]*)\}/g, (whole, selector) => {
			return /:host|::?slotted|::?part/i.test(selector) ? '' : whole;
		});
		css = css.replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, quote, target) => {
			const value = String(target || '').trim();
			if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) {
				return 'url(' + JSON.stringify(value) + ')';
			}
			return 'none';
		});
		return css.slice(0, translationConst.MAX_EMAIL_CSS_BYTES);
	},


	removeDangerousElements(document) {
		['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
			'form', 'input', 'button', 'select', 'option', 'textarea', 'base', 'meta',
			'link', 'svg', 'math', 'audio', 'video', 'source', 'track', 'template', 'noscript'
		].forEach(tag => {
			document.querySelectorAll(tag).forEach(el => el.remove());
		});
	},

	cleanStyle(value) {
		if (!value) return '';
		// 先解码 CSS 转义再白名单：p\6fsition 这类写法不解析就会被放过
		const decoded = stripCssComments(decodeCssEscapes(value)).replace(/\\/g, '');
		const kept = [];
		for (const part of decoded.split(';')) {
			const index = part.indexOf(':');
			if (index < 1) continue;
			const name = part.slice(0, index).trim().toLowerCase();
			const val = part.slice(index + 1).trim();
			if (!name || !val) continue;
			if (!ALLOW_CSS.has(name)) continue;
			if (DANGEROUS_CSS.test(val)) continue;
			kept.push(name + ': ' + val);
		}
		return kept.join('; ');
	},

	cleanHref(value) {
		const target = String(value || '').trim();
		if (target.startsWith('{{domain}}')) {
			return target;
		}
		try {
			const url = new URL(target, 'https://local.invalid');
			if (!LINK_PROTOCOL.has(url.protocol)) {
				return '';
			}
			return target;
		} catch (e) {
			return '';
		}
	},

	cleanAttr(el, name, value) {
		const tag = el.tagName ? el.tagName.toLowerCase() : '';
		const allowed = GLOBAL_ATTR.has(name)
			|| (translationConst.ALLOW_ATTR[tag] || []).includes(name);
		if (!allowed) return '';
		if (name === 'style') return this.cleanStyle(value);
		if (name === 'href') return this.cleanHref(value);
		if (name === 'src') return this.cleanHref(value) || (String(value).startsWith('{{domain}}') ? value : '');
		if (name === 'target') return value === '_blank' ? '_blank' : '';
		if (name === 'rel') return '';
		return String(value);
	},

	cleanElement(el) {
		const tag = el.tagName ? el.tagName.toLowerCase() : '';
		if (DROP_TAGS.has(tag)) {
			el.remove();
			return;
		}
		if (!ALLOW_TAGS.has(tag)) {
			const parent = el.parentNode;
			if (!parent) return;
			while (el.firstChild) {
				parent.insertBefore(el.firstChild, el);
			}
			el.remove();
			return;
		}

		const names = el.getAttributeNames ? el.getAttributeNames() : [];
		// 布尔属性（hidden）空值也必须保留，否则隐藏段落在清洗后变成可见正文
		const keepEmpty = new Set(['hidden']);
		for (const name of names) {
			const lower = String(name).toLowerCase();
			if (lower.startsWith('on')) {
				el.removeAttribute(name);
				continue;
			}
			if (keepEmpty.has(lower)) continue;
			const value = this.cleanAttr(el, lower, el.getAttribute(name));
			el.removeAttribute(name);
			if (value) {
				el.setAttribute(lower, value);
			}
		}

		if (tag === 'a' && el.getAttribute('target') === '_blank') {
			el.setAttribute('rel', 'noopener noreferrer');
		}
	},

	sanitizeTree(root, maxDepth = translationConst.MAX_DOM_DEPTH) {
		const elements = root.querySelectorAll('*');
		for (const el of elements) {
			this.cleanElement(el);
		}
		// 显式栈遍历：极深嵌套的恶意邮件不能把清洗流程打到栈溢出
		const stack = [{ node: root, depth: 0 }];
		while (stack.length > 0) {
			const { node, depth } = stack.pop();
			if (depth > maxDepth) {
				throw new Error('TRANSLATION_TOO_LARGE');
			}
			const children = Array.from(node.childNodes || []);
			for (const child of children) {
				if (child.nodeType !== 1) continue;
				const tag = child.tagName ? child.tagName.toLowerCase() : '';
				if (DROP_TAGS.has(tag)) {
					child.remove();
					continue;
				}
				stack.push({ node: child, depth: depth + 1 });
			}
		}
		return root;
	},

	isHidden(el) {
		if (!el || el.nodeType !== 1) return false;
		if (el.hasAttribute('hidden')) return true;
		const ariaHidden = el.getAttribute('aria-hidden');
		if (ariaHidden && ariaHidden.toLowerCase() === 'true') return true;
		const style = el.getAttribute('style') || '';
		return /display\s*:\s*none/i.test(style)
			|| /visibility\s*:\s*(hidden|collapse)/i.test(style)
			|| /mso-hide\s*:\s*all/i.test(style)
			|| /font-size\s*:\s*0(\.0+)?(px|pt|em|rem)?\s*(;|$)/i.test(style);
	}
};

export default sanitizeUtils;
