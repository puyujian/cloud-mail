import { describe, it, expect } from 'vitest';
import translationHtmlUtils from '../src/utils/translation-html-utils';
import translationConst from '../src/const/translation-const';

describe('translation-html-utils', () => {

	it('保留 HTML 结构并替换文本', () => {
		const html = '<div><p>Hello <strong>world</strong></p><img src="{{domain}}/a.png" onerror="x()"><script>alert(1)</script></div>';
		const doc = translationHtmlUtils.parse(html);
		translationHtmlUtils.sanitize(doc);
		const units = translationHtmlUtils.extractUnits(doc);

		expect(units.length).toBe(2);
		expect(doc.body.innerHTML).not.toContain('script');
		expect(doc.body.innerHTML).not.toContain('onerror');
		expect(doc.body.innerHTML).toContain('{{domain}}/a.png');

		const map = new Map();
		for (const unit of units) {
			if (unit.parts) {
				for (const part of unit.parts) map.set(part.id, 'ZH:' + part.text);
			} else {
				map.set(unit.id, 'ZH:' + unit.text);
			}
		}

		const before = translationHtmlUtils.fingerprint(doc);
		translationHtmlUtils.applyTranslations(units, map);
		const after = translationHtmlUtils.fingerprint(doc);
		const out = translationHtmlUtils.serialize(doc);

		expect(after).toBe(before);
		expect(out).toContain('<strong>ZH:world</strong>');
		expect(out).toContain('ZH:Hello');
	});

	it('保留文本节点前后的空白', () => {
		const doc = translationHtmlUtils.parse('<p>  Line one\nLine two  </p>');
		const units = translationHtmlUtils.extractUnits(doc);

		expect(units[0].leading).toBe('  ');
		expect(units[0].trailing).toBe('  ');

		translationHtmlUtils.applyTranslations(units, new Map([[units[0].id, 'X']]));
		expect(doc.body.innerHTML).toBe('<p>  X  </p>');
	});

	it('跳过隐藏节点', () => {
		const doc = translationHtmlUtils.parse(
			'<div><span style="display: none">hidden</span><span aria-hidden="true">aria</span><p>visible</p></div>'
		);
		const units = translationHtmlUtils.extractUnits(doc);

		expect(units.map(unit => unit.text)).toEqual(['visible']);
	});

	it('长文本按句拆分并完整回填', () => {
		const sentenceA = 'A'.repeat(300);
		const sentenceB = 'B'.repeat(300);
		const doc = translationHtmlUtils.parse('<p>' + sentenceA + '。' + sentenceB + '。</p>');
		const units = translationHtmlUtils.extractUnits(doc);

		expect(units[0].parts).toBeTruthy();
		expect(units[0].parts.length).toBe(2);
		// 标点保留在句尾，不单独丢失
		expect(units[0].parts[0].text).toBe(sentenceA + '。');
		expect(units[0].parts[1].text).toBe(sentenceB + '。');

		const map = new Map();
		for (const part of units[0].parts) map.set(part.id, 'Z' + part.text.length);
		translationHtmlUtils.applyTranslations(units, map);

		expect(doc.body.innerHTML).toBe('<p>Z301Z301</p>');
	});

	it('纯文本按行拆分并保留换行', () => {
		const text = 'Line1\n\n  Line2\n';
		const units = translationHtmlUtils.extractPlainUnits(text);

		expect(units.map(unit => unit.lineIndex)).toEqual([0, 2]);
		expect(translationHtmlUtils.buildPlainChunks(units).length).toBe(1);

		const map = new Map();
		for (const unit of units) map.set(unit.id, 'T:' + unit.text.trim());
		expect(translationHtmlUtils.applyPlainTranslations(text, units, map)).toBe('T:Line1\n\nT:Line2\n');
	});

	it('清洗危险协议与危险样式', () => {
		const doc = translationHtmlUtils.parse(
			'<a href="javascript:alert(1)">x</a>'
			+ '<a href="https://ok.com/a">y</a>'
			+ '<div style="color: red; position: fixed; background-image: url(http://x)">t</div>'
		);
		translationHtmlUtils.sanitize(doc);
		const out = doc.body.innerHTML;

		expect(out).not.toContain('javascript:');
		expect(out).toContain('https://ok.com/a');
		expect(out).toContain('color: red');
		expect(out).not.toContain('position');
		expect(out).not.toContain('url(');
	});

	it('分块数量超限时抛错', () => {
		// 单元数按「单块条目上限 × (分块上限 + 4)」生成，改常量时这条边界测试自动跟随
		const total = translationConst.CHUNK_MAX_ITEMS * (translationConst.MAX_CHUNKS + 4);
		const many = Array.from({ length: total }, (_, i) => '<p>t' + i + '</p>').join('');
		const doc = translationHtmlUtils.parse(many);
		const units = translationHtmlUtils.extractUnits(doc);

		expect(() => translationHtmlUtils.buildChunks(units)).toThrow('TRANSLATION_TOO_LARGE');
	});

	it('纯文本译文按单元拼接', () => {
		const doc = translationHtmlUtils.parse('<p>A</p><p>B</p>');
		const units = translationHtmlUtils.extractUnits(doc);
		const map = new Map([[units[0].id, '甲'], [units[1].id, '乙']]);

		expect(translationHtmlUtils.toPlainTranslation(units, map)).toBe('甲\n乙');
	});
	it('纯符号、路径、版本号不进模型分块', () => {
		// 线上 8B 模型拿到这些片段后开始原地打转，把整批 token 烧光
		const html = '<div><p>&gt;</p><p>6.24.0</p><p>package-lock.json</p>'
			+ '<p>https://github.com/puyujian/Cloud189Checkin/actions/runs/1</p>'
			+ '<p>someone@example.com</p><p>CVE-2026-6733</p><p>Hello world, please review.</p></div>';
		const doc = translationHtmlUtils.parse(html);
		translationHtmlUtils.sanitize(doc);
		const units = translationHtmlUtils.extractUnits(doc);
		const items = translationHtmlUtils.buildChunks(units).flat();

		expect(items.map(item => item.text)).toEqual(['Hello world, please review.']);
		// 被跳过的片段在回填时保持原样
		const map = new Map([[items[0].id, '你好世界，请复核。']]);
		translationHtmlUtils.applyTranslations(units, map);
		const out = translationHtmlUtils.serialize(doc);
		expect(out).toContain('6.24.0');
		expect(out).toContain('package-lock.json');
		expect(out).toContain('你好世界，请复核。');
	});
});
