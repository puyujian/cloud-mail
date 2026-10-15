#!/usr/bin/env node
/**
 * 窄屏布局守卫（本地静态 fixture，无需 preview/登录/网络）
 *
 * 背景：390×844 下 SyncClipboard 弹窗 footer 的「开关 + Test connection + Save」曾横排溢出，
 * Save 右半落到 viewport 外不可点。本脚本用构建产物 CSS + 复刻的 dialog DOM，
 * 在无头 Chromium 里按真实视口测量，防止回归。
 *
 * 覆盖：
 *   - 320×568 / 390×844 / 1280×633 三个视口
 *   - Save/Test 按钮「完整位于视口内」且「中心点命中自身（未被遮挡）」
 *   - 无横向溢出；footer 内开关与按钮组在窄屏换行（两组不再同排抢宽度）
 *   - 对照组：删除新规则后必须能复现失败（证明测量确实在测这件事）
 *
 * 运行：node scripts/check-dialog-layout.mjs [--chrome <path>] [--keep] [--screenshot <dir>]
 * 退出码：0 = 通过；1 = 布局回归；2 = 环境不可用（缺 Chrome / 缺构建产物）
 *
 * 说明：`--screenshot <dir>` 会输出本地静态 fixture 的截图（非真实 preview，仅供对比参考）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VIEWPORTS = [
	{ w: 320, h: 568 },
	{ w: 390, h: 844 },
	{ w: 1280, h: 633 }
];

const CHROME_CANDIDATES = [
	'/root/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable'
];

const SCOPE_ATTR = 'data-v-3409a0c2';

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) parsed[key] = true;
		else { parsed[key] = next; i++; }
	}
	return parsed;
}

function findChrome(explicit) {
	const candidates = explicit ? [explicit] : CHROME_CANDIDATES;
	for (const item of candidates) {
		if (fs.existsSync(item)) return item;
	}
	return '';
}

function findDistDir() {
	const dir = path.resolve(process.cwd(), 'dist');
	const assets = path.join(dir, 'assets');

	if (!fs.existsSync(assets)) {
		return '';
	}

	const cssFiles = fs.readdirSync(assets).filter(f => f.endsWith('.css'));
	if (cssFiles.length === 0) return '';

	return { dir, assets, cssFiles: cssFiles.map(f => path.join(assets, f)) };
}

const MEASURE_JS = `
function rect(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width), y: Math.round(r.y), bottom: Math.round(r.bottom) };
}
function inViewport(el) {
  const r = el.getBoundingClientRect();
  return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.width > 0 && r.height > 0;
}
function hitTest(el) {
  const r = el.getBoundingClientRect();
  const el2 = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return !!el2 && (el2 === el || el.contains(el2) || el2.contains(el));
}
const dlg = document.getElementById('dlg');
const save = document.getElementById('btn-save');
const test = document.getElementById('btn-test');
const footerSwitch = dlg.querySelector('.sync-clipboard-footer-switch');
const footerActions = dlg.querySelector('.sync-clipboard-footer-actions');
const out = {
  viewport: { w: innerWidth, h: innerHeight },
  docScrollW: document.documentElement.scrollWidth,
  dialog: rect(dlg),
  footer: rect(dlg.querySelector('.el-dialog__footer')),
  save: rect(save),
  test: rect(test),
  saveFullyVisible: inViewport(save),
  testFullyVisible: inViewport(test),
  saveClickable: hitTest(save),
  testClickable: hitTest(test),
  horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 0.5,
  switchAboveActions: !!(footerSwitch && footerActions)
    ? footerSwitch.getBoundingClientRect().bottom <= footerActions.getBoundingClientRect().top + 1
    : false,
  noNestedOverlap: !!(save.getBoundingClientRect().right <= test.getBoundingClientRect().left + 1
    || test.getBoundingClientRect().right <= save.getBoundingClientRect().left + 1
    || save.getBoundingClientRect().top >= test.getBoundingClientRect().bottom - 1
    || test.getBoundingClientRect().top >= save.getBoundingClientRect().bottom - 1)
};
const pre = document.createElement('pre');
pre.id = 'measure-result';
pre.textContent = 'MEASURE ' + JSON.stringify(out);
document.body.appendChild(pre);
`;

/** 复刻生产的 dialog DOM 结构（含 scoped 属性与 footer 两级容器） */
function buildFixtureHtml({ cssHrefs, withNewClasses }) {
	const a = SCOPE_ATTR;
	const dlgClass = withNewClasses ? 'el-dialog forward-dialog sync-clipboard-dialog' : 'el-dialog forward-dialog';
	const bodyClass = withNewClasses ? 'forward-set-body sync-clipboard-body' : 'forward-set-body';
	const footerInner = withNewClasses
		? `<div ${a} class="dialog-footer sync-clipboard-footer">
        <div ${a} class="sync-clipboard-footer-switch">${switchHtml(a)}</div>
        <div ${a} class="sync-clipboard-footer-actions">
          <button ${a} class="el-button" id="btn-test">Test connection</button>
          <button ${a} class="el-button el-button--primary" id="btn-save">Save</button>
        </div>
      </div>`
		: `<div ${a} class="dialog-footer">
        ${switchHtml(a)}
        <div ${a} class="webhook-footer-right">
          <button ${a} class="el-button" id="btn-test">Test connection</button>
          <button ${a} class="el-button el-button--primary" id="btn-save">Save</button>
        </div>
      </div>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${cssHrefs.map(h => `<link rel="stylesheet" href="${h}">`).join('\n')}
<style>body{margin:0;font-family:system-ui,sans-serif}</style>
</head>
<body>
<div ${a} class="settings-container">
  <div ${a} class="el-overlay">
    <div ${a} class="overlay-center" style="display:flex;justify-content:center;align-items:flex-start">
      <div ${a} class="${dlgClass}" id="dlg" role="dialog">
        <header ${a} class="el-dialog__header"><div ${a} class="forward-head"><span ${a} class="forward-set-title">SyncClipboard Sync</span></div></header>
        <div ${a} class="el-dialog__body">
          <div ${a} class="${bodyClass}">
            <div ${a} class="el-input"><div ${a} class="el-input__wrapper"><input ${a} class="el-input__inner" placeholder="Instance URL"></div></div>
            <div ${a} class="el-input"><div ${a} class="el-input__wrapper"><input ${a} class="el-input__inner" type="password" value="********"></div></div>
            <div ${a} class="tg-msg-label"><span ${a}>Scope</span>
              <div ${a} class="el-radio-group">
                <label ${a} class="el-radio"><span ${a} class="el-radio__label">All mailboxes</span></label>
                <label ${a} class="el-radio is-checked"><span ${a} class="el-radio__label">Selected recipients</span></label>
              </div>
            </div>
            <div ${a} class="el-input-tag"><div ${a} class="el-input-tag__wrapper"><span ${a} class="el-tag">admin@example.com</span></div></div>
            <div ${a} class="tg-msg-label"><span ${a}>Retries</span>
              <div ${a} class="el-input-number"><span ${a}>-</span><span ${a}>+</span>
                <div ${a} class="el-input"><div ${a} class="el-input__wrapper"><input ${a} class="el-input__inner" value="1"></div></div>
              </div>
            </div>
          </div>
        </div>
        <footer ${a} class="el-dialog__footer">${footerInner}</footer>
      </div>
    </div>
  </div>
</div>
<script>${MEASURE_JS}</script>
</body>
</html>`;
}

function switchHtml(a) {
	return `<label ${a} class="el-switch is-checked">
          <span ${a} class="el-switch__label el-switch__label--left is-active"><span ${a}>Enable</span></span>
          <input ${a} class="el-switch__input" type="checkbox">
          <span ${a} class="el-switch__core" style="width:40px"><span ${a} class="el-switch__action"></span></span>
          <span ${a} class="el-switch__label el-switch__label--right"><span ${a}>Disable</span></span>
        </label>`;
}

/** 去掉新规则的 CSS（对照组）：按选择器精确删除规则块（含 @media 包裹） */
function stripNewRules(cssText) {
	let text = cssText;
	let removed = 0;

	for (const needle of ['sync-clipboard-footer', 'sync-clipboard-dialog']) {
		while (true) {
			const at = text.indexOf(needle);
			if (at < 0) break;

			const open = text.indexOf('{', at);
			if (open < 0) break;

			let depth = 0;
			let end = open;
			while (end < text.length) {
				if (text[end] === '{') depth++;
				else if (text[end] === '}') {
					depth--;
					if (depth === 0) break;
				}
				end++;
			}

			let selStart = text.lastIndexOf('}', at);
			selStart = selStart < 0 ? 0 : selStart + 1;

			// 若整条规则被 @media 包裹，连同 @media 一起删除
			const prelude = text.slice(selStart, open);
			const mediaOpen = text.lastIndexOf('@media', open);
			if (mediaOpen >= 0 && text.slice(mediaOpen, selStart).trim().endsWith('{')) {
				selStart = mediaOpen;
			} else if (prelude.includes('@media')) {
				// no-op
			}

			text = text.slice(0, selStart) + text.slice(end + 1);
			removed++;
		}
	}

	return { text, removed };
}

function runMeasure(chrome, fileUrl, viewport) {
	const out = execFileSync(chrome, [
		'--headless',
		'--disable-gpu',
		'--no-sandbox',
		'--hide-scrollbars',
		'--virtual-time-budget=1500',
		`--window-size=${viewport.w},${viewport.h}`,
		'--dump-dom',
		fileUrl
	], { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });

	const match = out.match(/MEASURE (\{[\s\S]*?\})<\/pre>/);
	if (!match) {
		throw new Error(`未取到测量结果（viewport ${viewport.w}x${viewport.h}）`);
	}

	return JSON.parse(match[1]);
}

function shoot(chrome, fileUrl, viewport, outFile) {
	execFileSync(chrome, [
		'--headless',
		'--disable-gpu',
		'--no-sandbox',
		'--hide-scrollbars',
		'--virtual-time-budget=1500',
		`--window-size=${viewport.w},${viewport.h}`,
		`--screenshot=${outFile}`,
		fileUrl
	], { encoding: 'utf8', timeout: 60000 });
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const chrome = findChrome(args.chrome);

	if (!chrome) {
		console.error('⛔ 找不到无头 Chromium，可用 --chrome <path> 指定；本检查需要浏览器，已跳过（exit 2）');
		return 2;
	}

	const dist = findDistDir();
	if (!dist) {
		console.error('⛔ 找不到 mail-worker/dist 构建产物：请先运行 mail-vue 的 pnpm run build');
		return 2;
	}

	const newCss = dist.cssFiles
		.filter(file => fs.readFileSync(file, 'utf8').includes('sync-clipboard-footer'))
		.map(file => path.basename(file));

	if (newCss.length === 0) {
		console.error('⛔ 构建产物里找不到 sync-clipboard-footer 规则：新弹窗样式未被打包');
		return 1;
	}

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-layout-'));
	const copyCss = () => {
		const names = [];
		for (const file of dist.cssFiles) {
			const base = path.basename(file);
			fs.copyFileSync(file, path.join(workDir, base));
			names.push(base);
		}
		return names;
	};

	const failures = [];

	try {
		const afterCss = copyCss();

		// 对照组：删除新规则，确认在窄屏会复现“Save 不可点”
		const strippedText = stripNewRules(fs.readFileSync(path.join(workDir, newCss[0]), 'utf8'));
		fs.writeFileSync(path.join(workDir, 'stripped.css'), strippedText.text);
		fs.writeFileSync(path.join(workDir, 'after.html'), buildFixtureHtml({
			cssHrefs: afterCss,
			withNewClasses: true
		}));
		fs.writeFileSync(path.join(workDir, 'before.html'), buildFixtureHtml({
			cssHrefs: [...afterCss, 'stripped.css'],
			withNewClasses: false
		}));

		console.log('\n=== 窄屏布局守卫（SyncClipboard 弹窗 footer）===\n');

		// 1) 对照组必须失败（否则说明测量没测到真实问题）
		const control = runMeasure(chrome, 'file://' + path.join(workDir, 'before.html'), { w: 390, h: 844 });
		const controlReproduced = control.saveFullyVisible === false || control.saveClickable === false;
		console.log(`${controlReproduced ? '✅' : '❌'} 对照组（移除新规则）应在 390×844 复现溢出：save.right=${control.save.right} viewport=${control.viewport.w} clickable=${control.saveClickable}`);

		if (!controlReproduced) {
			failures.push('对照组未复现：测量逻辑可能无效');
		}

		// 2) 修复后三个视口都必须通过
		for (const viewport of VIEWPORTS) {
			const m = runMeasure(chrome, 'file://' + path.join(workDir, 'after.html'), viewport);
			const checks = [
				['Save 完整可见', m.saveFullyVisible],
				['Test 完整可见', m.testFullyVisible],
				['Save 可点（未被遮挡）', m.saveClickable],
				['Test 可点（未被遮挡）', m.testClickable],
				['无横向溢出', !m.horizontalOverflow],
				['按钮不重叠', m.noNestedOverlap]
			];

			if (viewport.w <= 540) {
				checks.push(['窄屏开关与按钮组换行', m.switchAboveActions]);
			}

			const bad = checks.filter(([, ok]) => !ok);
			console.log(`${bad.length === 0 ? '✅' : '❌'} ${viewport.w}×${viewport.h} — Save[${m.save.x},${m.save.right}] Test[${m.test.x},${m.test.right}]` +
				(bad.length ? ` 失败：${bad.map(([name]) => name).join('、')}` : ''));

			if (bad.length) {
				failures.push(`${viewport.w}x${viewport.h}: ${bad.map(([name]) => name).join(', ')}`);
			}
		}

		if (args.screenshot) {
			const dir = String(args.screenshot);
			fs.mkdirSync(dir, { recursive: true });

			for (const viewport of VIEWPORTS) {
				shoot(chrome, 'file://' + path.join(workDir, 'after.html'), viewport,
					path.join(dir, `sync-clipboard-dialog-${viewport.w}x${viewport.h}.png`));
			}

			shoot(chrome, 'file://' + path.join(workDir, 'before.html'), { w: 390, h: 844 },
				path.join(dir, 'sync-clipboard-dialog-before-fix-390x844.png'));

			console.log(`\n📸 本地静态 fixture 截图已写入 ${dir}（非真实 preview，仅供参考）`);
		}

		if (args.keep) {
			console.log(`\nfixture 保留在 ${workDir}`);
		}
	} finally {
		if (!args.keep) {
			fs.rmSync(workDir, { recursive: true, force: true });
		}
	}

	if (failures.length) {
		console.error(`\n⛔ 布局守卫失败：${failures.join(' | ')}\n`);
		return 1;
	}

	console.log('\n✅ 布局守卫通过：320/390 窄屏下 Test 与 Save 均完整可见可点，桌面布局不受影响\n');
	return 0;
}

// 仅作为 CLI 直接运行时执行（便于被其他脚本 import）
const entry = globalThis.process?.argv?.[1] || '';
if (entry.endsWith('check-dialog-layout.mjs')) {
	process.exit(main());
}

export { buildFixtureHtml, stripNewRules, VIEWPORTS };