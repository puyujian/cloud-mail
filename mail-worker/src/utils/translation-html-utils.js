import { parseHTML } from 'linkedom';
import translationConst from '../const/translation-const';
import sanitizeUtils from './translation-sanitize-utils';

const SKIP_TAGS = new Set(translationConst.SKIP_TAGS);
const encoder = new TextEncoder();

function byteLen(text) {
	return encoder.encode(text).length;
}

function codePointLen(text) {
	return Array.from(text || '').length;
}

// UTF-8 单字符字节数（精确，避免逐字符调用 TextEncoder）
function charBytes(codePoint) {
	if (codePoint <= 0x7F) return 1;
	if (codePoint <= 0x7FF) return 2;
	if (codePoint <= 0xFFFF) return 3;
	return 4;
}

const translationHtmlUtils = {

	// 只有 <body>（无 <html> 外壳）的邮件，linkedom 解析出来的 document.body 是空壳，
	// 必须补上外壳才能取到内容；已有 <html> 的则原样保留，避免重复包裹
	wrap(content) {
		if (!content) return '';
		const hasHtml = /<html[\s>]/i.test(content);
		const hasBody = /<body[\s>]/i.test(content);
		if (hasHtml && hasBody) {
			return content;
		}
		if (hasBody) {
			return '<!DOCTYPE html><html>' + content + '</html>';
		}
		return '<!DOCTYPE html><html><body>' + content + '</body></html>';
	},

	parse(content) {
		const { document } = parseHTML(this.wrap(content));
		return document;
	},

	// 返回清洗结果：document 供翻译，styleText 供输出时带回 class 版式
	sanitize(document) {
		const styleText = sanitizeUtils.extractStyleText(document);
		sanitizeUtils.removeDangerousElements(document);
		sanitizeUtils.sanitizeTree(document.body);
		document.styleText = styleText;
		return document;
	},

	// 只按 HTML 的 hidden / aria-hidden / 内联样式判断可见性。
	// <style> 里的 class 规则要过媒体查询与层叠，正则推导会误判可见文本，
	// 因此保留 class 本身（版式由样式表决定），不据此跳过翻译。
	isHidden(node) {
		let current = node;
		while (current && current.nodeType === 1) {
			if (sanitizeUtils.isHidden(current)) return true;
			current = current.parentNode;
		}
		return false;
	},

	inSkipTag(node) {
		let current = node.parentNode;
		while (current && current.nodeType === 1) {
			const tag = current.tagName ? current.tagName.toLowerCase() : '';
			if (SKIP_TAGS.has(tag)) return true;
			current = current.parentNode;
		}
		return false;
	},

	// 无标点的长文本（或单个超长单词）按码点硬切，保证单片不超过 UNIT_MAX_BYTES
	hardSplit(text, maxBytes) {
		const parts = [];
		let current = '';
		let bytes = 0;
		for (const ch of Array.from(text)) {
			const size = charBytes(ch.codePointAt(0));
			if (bytes + size > maxBytes && current) {
				parts.push(current);
				current = '';
				bytes = 0;
			}
			current += ch;
			bytes += size;
		}
		if (current) parts.push(current);
		return parts;
	},

	splitParts(text) {
		const parts = [];
		const pattern = /[^。！？!?.\n]*[。！？!?.]?\s*\n?|[^。！？!?.\n]+$/g;
		let match;
		let lastIndex = 0;
		while ((match = pattern.exec(text)) !== null) {
			if (match[0] === '') {
				pattern.lastIndex += 1;
				continue;
			}
			const raw = match[0];
			const trimmed = raw.replace(/\s+$/, '');
			const sep = raw.slice(trimmed.length);
			parts.push({ text: trimmed, sep });
			lastIndex = pattern.lastIndex;
		}
		if (lastIndex < text.length) {
			parts.push({ text: text.slice(lastIndex), sep: '' });
		}
		if (parts.length === 0) {
			parts.push({ text, sep: '' });
		}

		const out = [];
		for (const part of parts.filter(item => item.text !== '' || item.sep !== '')) {
			if (byteLen(part.text) <= translationConst.UNIT_MAX_BYTES) {
				out.push(part);
				continue;
			}
			const pieces = this.hardSplit(part.text, translationConst.UNIT_MAX_BYTES);
			pieces.forEach((piece, index) => {
				out.push({ text: piece, sep: index === pieces.length - 1 ? part.sep : '' });
			});
		}
		return out;
	},

	// 严格按文档顺序（前序）产出文本单元。
	// 逆序扫描会让 <p>Start<b>mid</b>end</p> 变成 end/Start/mid：
	// HTML 回填位置不受影响，但模型上下文和纯文本回退都会错序。
	// URL、邮箱、路径、版本号、代码标识符和纯符号片段交给 8B 模型只会被改写，
	// 线上还出现过整批 token 全在打转（“为一个为一个…”）：这些片段直接照抄，不进分块也不计费
	isTranslatable(text) {
		const value = String(text || '').trim();
		if (!value) {
			return false;
		}
		// 没有任何字母：纯数字、标点、分隔符
		if (!/\p{L}/u.test(value)) {
			return false;
		}
		if (/^(?:https?:\/\/|www\.)\S+$/iu.test(value)) {
			return false;
		}
		if (/^\S+@\S+\.\S+$/u.test(value)) {
			return false;
		}
		// 不含空格且带分隔符的「标识符样」短串：package-lock.json、CVE-2026-6733、
		// v6.24.0、a@b.com。带分隔符才算标识符——Line1、t0 这类普通词仍要翻译
		if (!/\s/.test(value) && /^[\w.@/:-]+$/u.test(value) && /[._/@:-]/u.test(value)) {
			return false;
		}
		return true;
	},

	extractUnits(document) {
		const units = [];
		let index = 0;
		let nodes = 0;
		const pushChildren = (stack, node, depth) => {
			const children = Array.from(node.childNodes || []);
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push({ node: children[i], depth });
			}
		};
		const stack = [{ node: document.body, depth: 0 }];
		while (stack.length > 0) {
			const frame = stack.pop();
			const node = frame.node;
			if (!node) continue;
			if (frame.depth > translationConst.MAX_DOM_DEPTH) {
				throw new Error('TRANSLATION_TOO_LARGE');
			}
			if (node.nodeType === 1) {
				const tag = node === document.body ? '' : (node.tagName ? node.tagName.toLowerCase() : '');
				if (tag && SKIP_TAGS.has(tag)) continue;
				if (tag && this.isHidden(node)) continue;
				if (tag) {
					nodes += 1;
					if (nodes > translationConst.MAX_DOM_NODES) {
						throw new Error('TRANSLATION_TOO_LARGE');
					}
				}
				pushChildren(stack, node, frame.depth + 1);
				continue;
			}
			if (node.nodeType !== 3) continue;
			const data = node.data || '';
			if (!data.trim()) continue;
			const leading = data.match(/^\s*/)[0];
			const trailing = data.match(/\s*$/)[0];
			const core = data.slice(leading.length, data.length - trailing.length);
			if (!core) continue;
			index += 1;
			const id = 'n' + String(index).padStart(4, '0');
			const unit = { id, text: core, node, leading, trailing, parts: null };
			if (byteLen(core) > translationConst.UNIT_MAX_BYTES) {
				const parts = this.splitParts(core);
				unit.parts = parts.map((part, partIndex) => ({
					id: id + '.p' + String(partIndex + 1).padStart(4, '0'),
					text: part.text,
					sep: part.sep
				}));
			}
			units.push(unit);
		}
		return units;
	},

	buildChunks(units) {
		const items = [];
		for (const unit of units) {
			if (unit.parts) {
				for (const part of unit.parts) {
					if (part.text && this.isTranslatable(part.text)) {
						items.push({ id: part.id, text: part.text });
					}
				}
			} else if (this.isTranslatable(unit.text)) {
				items.push({ id: unit.id, text: unit.text });
			}
		}

		const chunks = [];
		let current = [];
		let currentBytes = 0;
		for (const item of items) {
			const size = byteLen(item.text);
			const overflow = current.length >= translationConst.CHUNK_MAX_ITEMS
				|| (current.length > 0 && currentBytes + size > translationConst.CHUNK_MAX_BYTES);
			if (overflow) {
				chunks.push(current);
				current = [];
				currentBytes = 0;
			}
			current.push(item);
			currentBytes += size;
		}
		if (current.length > 0) {
			chunks.push(current);
		}

		if (chunks.length > translationConst.MAX_CHUNKS) {
			throw new Error('TRANSLATION_TOO_LARGE');
		}
		return chunks;
	},

	countSourceCodepoints(units) {
		let total = 0;
		for (const unit of units) {
			total += codePointLen(unit.text);
		}
		return total;
	},

	applyTranslations(units, map) {
		for (const unit of units) {
			if (!unit.node) continue;
			if (unit.parts) {
				let text = unit.leading;
				for (const part of unit.parts) {
					const translated = map.has(part.id) ? map.get(part.id) : part.text;
					text += translated + part.sep;
				}
				unit.node.data = text + unit.trailing;
			} else {
				const translated = map.has(unit.id) ? map.get(unit.id) : unit.text;
				unit.node.data = unit.leading + translated + unit.trailing;
			}
		}
		return units;
	},

	fingerprint(document) {
		const tokens = [];
		// 与清洗同样使用显式栈，避免深嵌套邮件在指纹阶段栈溢出
		const stack = [document.body];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			const children = Array.from(node.childNodes || []);
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				if (child.nodeType === 1) {
					const tag = child.tagName ? child.tagName.toLowerCase() : '';
					const names = (child.getAttributeNames ? child.getAttributeNames() : []).filter(name => name !== 'style');
					const pairs = names.map(name => name + '=' + child.getAttribute(name)).join('&');
					tokens.push(tag + '[' + pairs + ']');
					stack.push(child);
				} else if (child.nodeType === 3) {
					if ((child.data || '').trim()) {
						tokens.push('#text');
					}
				}
			}
		}
		return tokens.join('|');
	},

	// 译文的 <style> 与 body 属性必须带回：邮件版式靠 class 与 body 背景，
	// 少了它们译文会走形成纯文本外观；内容本身仍是清洗后的安全子集
	serialize(document) {
		if (!document || !document.body) return '';
		const css = document.styleText || '';
		const head = css ? '<style>' + css + '</style>' : '';
		const attrs = ['class', 'style', 'align', 'dir', 'lang', 'bgcolor', 'hidden', 'aria-hidden']
			.filter(name => document.body.hasAttribute(name))
			.map(name => {
				const raw = document.body.getAttribute(name);
				// 与元素属性同一套白名单：body 上的 style 同样要过危险函数过滤
				const value = name === 'style'
					? sanitizeUtils.cleanStyle(raw)
					: sanitizeUtils.cleanAttr(document.body, name, raw);
				return value ? name + '="' + String(value).replace(/"/g, '&quot;') + '"' : '';
			})
			.filter(Boolean)
			.join(' ');
		const open = attrs ? '<div ' + attrs + '>' : '';
		const close = attrs ? '</div>' : '';
		return head + open + document.body.innerHTML + close;
	},

	extractPlainUnits(text) {
		const units = [];
		const lines = String(text || '').split('\n');
		lines.forEach((line, index) => {
			if (!line.trim()) return;
			const baseId = 't' + String(index).padStart(5, '0');
			if (byteLen(line) <= translationConst.UNIT_MAX_BYTES) {
				units.push({ id: baseId, lineIndex: index, text: line });
				return;
			}
			// 超长单行同样硬切，否则单个 item 会突破 CHUNK_MAX_BYTES
			const pieces = this.hardSplit(line, translationConst.UNIT_MAX_BYTES);
			units.push({
				id: baseId,
				lineIndex: index,
				text: line,
				parts: pieces.map((piece, partIndex) => ({
					id: baseId + 'p' + String(partIndex).padStart(4, '0'),
					text: piece,
					sep: ''
				}))
			});
		});
		return units;
	},

	buildPlainChunks(units) {
		const items = [];
		for (const unit of units) {
			if (unit.parts) {
				for (const part of unit.parts) {
					if (part.text && this.isTranslatable(part.text)) items.push({ id: part.id, text: part.text });
				}
			} else if (this.isTranslatable(unit.text)) {
				items.push({ id: unit.id, text: unit.text });
			}
		}

		const chunks = [];
		let current = [];
		let currentBytes = 0;
		for (const item of items) {
			const size = byteLen(item.text);
			const overflow = current.length >= translationConst.CHUNK_MAX_ITEMS
				|| (current.length > 0 && currentBytes + size > translationConst.CHUNK_MAX_BYTES);
			if (overflow) {
				chunks.push(current);
				current = [];
				currentBytes = 0;
			}
			current.push(item);
			currentBytes += size;
		}
		if (current.length > 0) {
			chunks.push(current);
		}
		if (chunks.length > translationConst.MAX_CHUNKS) {
			throw new Error('TRANSLATION_TOO_LARGE');
		}
		return chunks;
	},

	toPlainTranslation(units, map) {
		const lines = [];
		for (const unit of units) {
			if (unit.parts) {
				let line = '';
				for (const part of unit.parts) {
					line += (map.has(part.id) ? map.get(part.id) : part.text) + part.sep;
				}
				lines.push(line.replace(/\s+$/, ''));
			} else {
				lines.push(map.has(unit.id) ? map.get(unit.id) : unit.text);
			}
		}
		return lines.join('\n').trim();
	},

	applyPlainTranslations(sourceText, units, map) {
		const lines = String(sourceText || '').split('\n');
		for (const unit of units) {
			if (unit.parts) {
				lines[unit.lineIndex] = unit.parts
					.map(part => (map.has(part.id) ? map.get(part.id) : part.text) + part.sep)
					.join('');
			} else {
				lines[unit.lineIndex] = map.has(unit.id) ? map.get(unit.id) : unit.text;
			}
		}
		return lines.join('\n');
	}
};

export default translationHtmlUtils;