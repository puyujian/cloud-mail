#!/usr/bin/env node
/**
 * 独立幂等迁移工具：为 setting 表补齐 SyncClipboard 集成所需的列。
 *
 * 为什么需要它：
 *   - `GET /api/init/<jwt_secret>` 会连带执行**全部历史迁移**（含历史 UPDATE/索引重建），
 *     只为这一个功能去跑整套迁移没有必要，也不是推荐路径；
 *   - 本工具只做一件事：读 PRAGMA → 逐列补缺 → 复核。旧库、半升级库、重复执行都安全，
 *     不会吞掉真实错误（非“并发重复列”的异常会直接失败并退出非 0）。
 *   - 列定义唯一来源：`src/init/setting-columns.mjs`（与 Worker 内 v3_4DB 共用，不散落多份）。
 *
 * 安全默认值：
 *   - 默认 **dry-run**（只打印将要执行的 SQL，不写库）
 *   - 默认 **--local**（wrangler 本地 SQLite，绝不碰远端）
 *   - 写远端必须同时满足：`--remote` + `--allow-remote-write` + 环境变量 `ALLOW_REMOTE_WRITE=1`
 *   - 不硬编码账号/凭据：认证完全交给 wrangler（可用部署工程师自己的登录态或授权桥）
 *
 * 用法：
 *   # 1) 先看计划（默认 local + dry-run，零写入）
 *   node scripts/migrate-sync-clipboard.mjs
 *
 *   # 2) 本地库实际执行
 *   node scripts/migrate-sync-clipboard.mjs --apply
 *
 *   # 3) 远端正式库（需要显式三重开关）
 *   ALLOW_REMOTE_WRITE=1 node scripts/migrate-sync-clipboard.mjs \
 *     --remote --allow-remote-write --apply --config wrangler.toml --database cloud-email
 *
 * 迁移后：
 *   - 所有新列都有默认值，功能**默认关闭**；
 *   - KV 缓存会在「首次保存设置」或 `/init` 刷新时写入新字段；KV 缺字段时运行时会按“关闭”处理。
 */

import { SETTING_TABLE, SYNC_CLIPBOARD_COLUMNS } from '../src/init/setting-columns.mjs';

export const DEFAULT_CONFIG_PATH = 'wrangler.toml';

/** 解析 --key value / --flag 形式参数 */
export function parseArgs(argv) {
	const parsed = {};

	for (let i = 0; i < argv.length; i++) {
		const item = argv[i];
		if (!item.startsWith('--')) continue;

		const key = item.slice(2);
		const next = argv[i + 1];

		if (next === undefined || next.startsWith('--')) {
			parsed[key] = true;
		} else {
			parsed[key] = next;
			i++;
		}
	}

	return parsed;
}

/** 从 wrangler 配置文本里取第一个 [[d1_databases]] 的 database_name */
export function parseDatabaseName(tomlText) {
	const lines = String(tomlText ?? '').split(/\r?\n/);
	let inD1 = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith('[')) {
			inD1 = trimmed === '[[d1_databases]]';
			continue;
		}

		if (!inD1) continue;

		const match = trimmed.match(/^database_name\s*=\s*"([^"]+)"/);
		if (match) {
			return match[1];
		}
	}

	return '';
}

/** 解析 `wrangler d1 execute --json` 输出中的列名列表 */
export function parsePragmaNames(output) {
	const text = String(output ?? '');
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');

	if (start === -1 || end === -1 || end < start) {
		return [];
	}

	let json;
	try {
		json = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}

	const rows = Array.isArray(json) ? (json[0]?.results || []) : (json?.results || []);
	return rows.map(row => row?.name).filter(Boolean);
}

export function computeMissingColumns(existingNames, columnDefs = SYNC_CLIPBOARD_COLUMNS) {
	const existing = new Set(existingNames || []);
	return Object.entries(columnDefs).filter(([name]) => !existing.has(name));
}

export function buildAlterSql(table, name, definition) {
	return `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`;
}

export function buildPlan(existingNames, columnDefs = SYNC_CLIPBOARD_COLUMNS, table = SETTING_TABLE) {
	return computeMissingColumns(existingNames, columnDefs).map(([name, definition]) => ({
		name,
		sql: buildAlterSql(table, name, definition)
	}));
}

/**
 * 决定运行模式（纯函数，便于测试）。
 * 返回 { write, remote, configPath, database }；不安全组合直接抛错。
 */
export function resolveMode(args, env = {}) {
	const remote = args.remote === true;

	if (remote && args['allow-remote-write'] !== true) {
		throw new Error('拒绝对远端写入：需要显式 --allow-remote-write');
	}

	if (remote && String(env.ALLOW_REMOTE_WRITE ?? '') !== '1') {
		throw new Error('拒绝对远端写入：需要环境变量 ALLOW_REMOTE_WRITE=1');
	}

	return {
		write: args.apply === true,
		remote,
		configPath: String(args.config || DEFAULT_CONFIG_PATH),
		database: args.database ? String(args.database) : ''
	};
}

const HELP = `用法: node scripts/migrate-sync-clipboard.mjs [选项]

  --config <path>           wrangler 配置文件（默认 ${DEFAULT_CONFIG_PATH}）
  --database <name>         D1 数据库名（默认从配置文件 [[d1_databases]] 读取）
  --local                   操作本地库（默认）
  --remote                  操作远端库（必须同时给 --allow-remote-write 且 ALLOW_REMOTE_WRITE=1）
  --allow-remote-write      显式允许远端写入
  --apply                   真正执行 ALTER（默认 dry-run，只打印计划）
  --persist-to <dir>        本地持久化目录（透传给 wrangler）
  --help                    显示帮助

说明：列定义来自 src/init/setting-columns.mjs，与 Worker 内 v3_4DB 完全一致；默认关闭、幂等可重复执行。`;

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.help === true) {
		console.log(HELP);
		return 0;
	}

	const env = globalThis.process?.env || {};

	let mode;
	try {
		mode = resolveMode(args, env);
	} catch (e) {
		console.error(`\n⛔ ${e.message}\n`);
		return 2;
	}

	const fs = await import('node:fs');
	const { spawnSync } = await import('node:child_process');

	let database = mode.database;

	if (!database) {
		let configText = '';
		try {
			configText = fs.readFileSync(mode.configPath, 'utf8');
		} catch {
			console.error(`\n⛔ 读不到配置文件 ${mode.configPath}，请用 --config 指定或 --database 直接给库名\n`);
			return 2;
		}
		database = parseDatabaseName(configText);
	}

	if (!database) {
		console.error('\n⛔ 未能确定 D1 数据库名，请用 --database 指定\n');
		return 2;
	}

	const target = mode.remote ? 'REMOTE（远端）' : 'LOCAL（本地）';
	console.log(`\n=== SyncClipboard 迁移（${target}，${mode.write ? 'APPLY' : 'DRY-RUN'}）===`);
	console.log(`配置: ${mode.configPath}`);
	console.log(`数据库: ${database}\n`);

	const wranglerArgs = ['wrangler', 'd1', 'execute', database, mode.remote ? '--remote' : '--local', '--json', '-c', mode.configPath];
	if (mode.remote && mode.write) wranglerArgs.push('--yes');
	if (!mode.remote && args['persist-to']) wranglerArgs.push('--persist-to', String(args['persist-to']));

	const run = (sql) => {
		const result = spawnSync('npx', [...wranglerArgs, '--command', sql], { encoding: 'utf8' });
		if (result.status !== 0) {
			throw new Error(`wrangler 执行失败（exit ${result.status}）：${String(result.stderr || '').trim().slice(0, 300)}`);
		}
		return result.stdout || '';
	};

	try {
		const existing = parsePragmaNames(run(`SELECT name FROM pragma_table_info('${SETTING_TABLE}')`));
		const plan = buildPlan(existing);

		console.log(`现有列 ${existing.length} 个，待补 ${plan.length} 个：`);
		for (const item of plan) {
			console.log(`  - ${item.sql}`);
		}

		if (plan.length === 0) {
			console.log('\n✅ 已是最新（幂等）：无需变更\n');
			return 0;
		}

		if (!mode.write) {
			console.log('\n（dry-run 结束：加 --apply 才会真正执行 ALTER）\n');
			return 0;
		}

		for (const item of plan) {
			run(item.sql);
			console.log(`  ✔ ${item.name}`);
		}

		const after = parsePragmaNames(run(`SELECT name FROM pragma_table_info('${SETTING_TABLE}')`));
		const remaining = buildPlan(after);

		if (remaining.length > 0) {
			console.error(`\n⛔ 迁移后仍有缺列：${remaining.map(item => item.name).join(', ')}\n`);
			return 1;
		}

		console.log('\n✅ 迁移完成：8 列齐备，功能默认关闭（status=1）');
		console.log('   提示：KV 缓存会在首次保存设置或 /init 刷新时写入新字段；KV 缺字段时按“关闭”处理\n');
		return 0;
	} catch (e) {
		console.error(`\n⛔ ${e.message}\n`);
		return 1;
	}
}

// 仅作为 CLI 直接运行时才执行（被测试 import 时不触发）
const entry = globalThis.process?.argv?.[1] || '';
if (entry.endsWith('migrate-sync-clipboard.mjs')) {
	main().then(code => process.exit(code)).catch(e => {
		console.error(`\n⛔ 未捕获异常：${e?.name || 'Error'}\n`);
		process.exit(1);
	});
}
