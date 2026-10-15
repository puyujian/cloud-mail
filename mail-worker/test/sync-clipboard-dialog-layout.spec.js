import { describe, it, expect } from 'vitest';
import sfc from '../../mail-vue/src/views/sys-setting/index.vue?raw';

/**
 * 窄屏布局与可达性的静态守卫（在 Workers pool 里跑，无浏览器、无网络）。
 *
 * 背景：390×844 下 SyncClipboard 弹窗 footer 的「开关 + Test connection + Save」曾横排溢出，
 * Save 右半落到 viewport 外不可点。
 *
 * 这里的断言只能覆盖「结构与样式契约」，真实的像素级验证由
 * `node scripts/check-dialog-layout.mjs`（无头 Chromium + 构建产物 CSS）承担，
 * 二者互补：本文件保证源码不退化，脚本保证实际渲染结果。
 */

/** 取出 <style scoped> 段落 */
function styleBlock() {
	const start = sfc.indexOf('<style');
	const body = sfc.slice(sfc.indexOf('>', start) + 1);
	const end = body.indexOf('</style>');
	return body.slice(0, end);
}

/** 粗略提取某个 class 的规则体（够用即可，避免引入 css 解析器） */
function ruleBody(cssText, selector) {
	const at = cssText.indexOf(selector);
	if (at < 0) return '';
	const open = cssText.indexOf('{', at);
	if (open < 0) return '';

	let depth = 0;
	let end = open;
	while (end < cssText.length) {
		if (cssText[end] === '{') depth++;
		else if (cssText[end] === '}') {
			depth--;
			if (depth === 0) break;
		}
		end++;
	}

	return cssText.slice(open, end + 1);
}

const css = styleBlock();

describe('SyncClipboard 弹窗：结构契约', () => {

	it('弹窗使用独立 class（不依赖通用 forward-dialog 改造）', () => {
		expect(sfc).toContain('class="forward-dialog sync-clipboard-dialog"');
		// 旧的通用弹窗仍保持原 class，没有被改名/加新样式
		expect((sfc.match(/class="forward-dialog"/g) || []).length).toBeGreaterThanOrEqual(5);
	});

	it('footer 使用独立容器：开关一组、按钮一组', () => {
		expect(sfc).toContain('class="dialog-footer sync-clipboard-footer"');
		expect(sfc).toContain('class="sync-clipboard-footer-switch"');
		expect(sfc).toContain('class="sync-clipboard-footer-actions"');
	});

	it('新弹窗不再复用 webhook 的按钮容器 class', () => {
		// webhook-footer-right 只应留给 webhook 弹窗自身
		const footerStart = sfc.indexOf('class="dialog-footer sync-clipboard-footer"');
		const footerEnd = sfc.indexOf('</template>', footerStart);
		const syncFooter = sfc.slice(footerStart, footerEnd);

		expect(syncFooter).not.toContain('webhook-footer-right');
		expect(syncFooter).toContain('sync-clipboard-footer-actions');
	});

	it('设置齿轮按钮带 aria-label；未新增无名按钮', () => {
		expect(sfc).toContain(':aria-label="$t(\'syncClipboard\')"');

		// 弹窗里的按钮都有可读文本（Test / Save），没有只含图标的无名按钮
		const footerStart = sfc.indexOf('class="dialog-footer sync-clipboard-footer"');
		const syncFooter = sfc.slice(footerStart, sfc.indexOf('</template>', footerStart));

		expect(syncFooter).not.toMatch(/<el-button[^>]*>\s*<Icon/);
	});
});

describe('SyncClipboard 弹窗：responsive 样式契约', () => {

	it('footer 允许换行并带 gap（不再单行硬挤）', () => {
		const body = ruleBody(css, '.sync-clipboard-footer {');

		expect(body).toContain('flex-wrap: wrap');
		expect(body).toMatch(/gap:\s*\d+px/);
	});

	it('窄屏（<=540px）开关与按钮组各占整行、按钮等分且可收缩', () => {
		const dialog = ruleBody(css, '.sync-clipboard-dialog {');
		const mediaAt = dialog.indexOf('@media (max-width: 540px)');

		expect(mediaAt).toBeGreaterThan(-1);

		// @media 块一直取到所属规则结束（ruleBody 已保证配对）
		const media = dialog.slice(mediaAt);

		expect(media).toContain('flex: 1 1 100%');
		expect(media).toContain('margin-left: 0');
		expect(media).toMatch(/\.el-button[\s\S]*flex: 1 1 0/);
		expect(media).toContain('min-width: 0');
	});

	it('极窄屏（<=360px）弹窗边距缩小，保证内容宽度', () => {
		expect(css).toContain(':deep(.sync-clipboard-dialog.el-dialog)');
		expect(css).toMatch(/@media \(max-width: 360px\)/);
		expect(css).toContain('width: calc(100% - 24px) !important');
	});

	it('内容区控件可收缩（防止 input/tag 把宽度撑出弹窗）', () => {
		const body = ruleBody(css, '.sync-clipboard-body {');

		expect(body).toContain('min-width: 0');
		expect(body).toContain('.el-input-tag');
		expect(body).toContain('max-width: 100%');
	});

	it('新样式全部 scope 在 .sync-clipboard-* 下，不污染旧 dialog', () => {
		const dialogBlock = ruleBody(css, '.sync-clipboard-dialog {');

		expect(dialogBlock).toContain('.sync-clipboard-footer');
		expect(dialogBlock).toContain('.sync-clipboard-body');

		// 通用 .dialog-footer 规则本身没有被改动成 wrap（避免影响其他旧弹窗）
		const generic = ruleBody(css, '.dialog-footer {');
		expect(generic).not.toContain('flex-wrap');
	});
});