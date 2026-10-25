import { describe, it, expect } from 'vitest';
import translationHtmlUtils from '../src/utils/translation-html-utils';

// 评审回归：class 版式、body 属性、隐藏段落、仅 <body> 外壳
describe('译文格式保真', () => {

	it('保留邮件 <style> 与 class 版式', () => {
		const html = '<html><head><style>.brand{color:#c00}.pad{padding:12px}</style></head>'
			+ '<body class="mail"><div class="brand pad">Hello</div></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const units = translationHtmlUtils.extractUnits(doc);
		translationHtmlUtils.applyTranslations(units, new Map(units.map(u => [u.id, '你好'])));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).toContain('.brand{color:#c00}');
		expect(out).toContain('class="brand pad"');
		expect(out).toContain('你好');
	});

	it('style 里的脚本构造被剔除', () => {
		const html = '<html><head><style>.a{background:url(javascript:alert(1))}'
			+ 'b{}</style></head><body><p>Hi</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toContain('javascript:');
		expect(out).not.toContain('<script');
	});

	it('仅 <body> 外壳的邮件也能翻译', () => {
		const html = '<body><p>Hello world</p></body>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const units = translationHtmlUtils.extractUnits(doc);
		expect(units.length).toBe(1);
		expect(units[0].text).toBe('Hello world');
	});

	it('样式表里的 display:none 不误判可见文本（含 print 媒体与层叠）', () => {
		const cases = [
			'<style>@media print{.text{display:none}}</style><p class="text">VISIBLE</p>',
			'<style>.text{display:none}.text{display:block}</style><p class="text">VISIBLE</p>',
			'<style>.text{display:none}</style><p class="text">VISIBLE</p>'
		];
		for (const body of cases) {
			const html = '<html><head>' + body.split('</style>')[0] + '</style></head><body>'
				+ body.split('</style>')[1] + '</body></html>';
			const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
			const units = translationHtmlUtils.extractUnits(doc);
			expect(units.map(u => u.text)).toContain('VISIBLE');
		}
	});

	it('混合内容的文本单元保持文档顺序', () => {
		const html = '<html><body><p>Start<b>middle</b>end</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const units = translationHtmlUtils.extractUnits(doc);
		expect(units.map(u => u.text)).toEqual(['Start', 'middle', 'end']);
	});

	it('CSS 注释写法不能绕过过滤（position:/**/fixed）', () => {
		const html = '<html><head><style>'
			+ '.a{position:/**/fixed!important;inset/**/:0!important;z-index/**/:2147483647!important}'
			+ '.b{color/**/:#222}'
			+ '</style></head><body>'
			+ '<div style="position:/**/sticky!important;z-index/**/:2147483647!important;color:#333">x</div>'
			+ '</body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
		expect(out).not.toContain('z-index');
		expect(out).not.toContain('inset');
		expect(out).toContain('color: #333');
	});

	it('内联 style 的转义写法同样被剔除', () => {
		const html = '<html><body><a style="p\\6fsition:f\\69xed!important;'
			+ 'z-\\69ndex:2147483647!important;inset:0!important;color:#c00">mail overlay</a></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
		expect(out).not.toContain('z-index');
		expect(out).not.toContain('inset');
		expect(out).toContain('color: #c00');
	});

	it('position:fixed/sticky 与定位逃逸属性一并剔除', () => {
		const html = '<html><head><style>'
			+ '.a{position:fixed;inset:0;z-index:2147483647;background:#fff}'
			+ '.b{position:sticky;top:0}'
			+ '.c{position:relative;color:#222}'
			+ '</style></head><body><p class="a b c">Hi</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
		expect(out).not.toContain('z-index');
		expect(out).toContain('position:relative');
		expect(out).toContain('color:#222');
	});

	it('CSS 转义写法不能绕过过滤', () => {
		const html = '<html><head><style>'
			+ ':h\\6fst{p\\6fsition:f\\69xed!important;z-\\69ndex:2147483647!important;width:100vw!important}'
			+ '.k\\65ep{color:#222}'
			+ '</style></head><body><p class="keep">Hi</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
		expect(out).not.toContain('z-index');
		expect(out).not.toContain(':host');
		expect(out).not.toContain('\\');
		expect(out).toContain('color:#222');
	});

	it('样式表里的定位逃逸与 :host 被剔除', () => {
		const html = '<html><head><style>'
			+ ':host{position:fixed;inset:0;z-index:2147483647}'
			+ '.ok{color:#222;position:fixed;inset:0;width:100vw}'
			+ '</style></head><body><p class="ok">Hi</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).not.toContain(':host');
		expect(out).not.toContain('z-index');
		expect(out).not.toContain('inset');
		expect(out).toContain('color:#222');
		expect(out).toContain('width:100vw');
	});

	it('id 锚点保留、print-only 样式表不进屏幕视图', () => {
		const html = '<html><head>'
			+ '<style media="print">.only-print{color:#000}</style>'
			+ '<style media="screen">.on-screen{color:#222}</style>'
			+ '</head><body><a id="anchor" href="#top">x</a></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).toContain('id="anchor"');
		expect(out).toContain('.on-screen{color:#222}');
		expect(out).not.toContain('.only-print');
	});

	it('body 背景等属性被保留', () => {
		const html = '<html><body style="background:#f5f5f5;color:#222"><p>Hi</p></body></html>';
		const doc = translationHtmlUtils.sanitize(translationHtmlUtils.parse(html));
		const out = translationHtmlUtils.serialize(doc);
		expect(out).toContain('background: #f5f5f5');
		expect(out).toContain('color: #222');
	});
});
