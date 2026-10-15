import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { dbInit } from '../src/init/init';
import { SETTING_TABLE, SYNC_CLIPBOARD_COLUMNS } from '../src/init/setting-columns.mjs';
import {
	buildAlterSql,
	buildPlan,
	computeMissingColumns,
	parseArgs as parseMigrationArgs,
	parseDatabaseName,
	parsePragmaNames,
	resolveMode
} from '../scripts/migrate-sync-clipboard.mjs';
import {
	checkApplyGuards,
	maskOrigin,
	parseArgs as parseOnlineArgs,
	resolveCredentials,
	resolveOnlineMode
} from './online/verify-sync-clipboard.mjs';
import { runLegacySchema, runSyncClipboardMigration, settingColumnNames } from './helpers/db';

const COLUMN_NAMES = [
	'sync_clipboard_status',
	'sync_clipboard_url',
	'sync_clipboard_username',
	'sync_clipboard_password',
	'sync_clipboard_mode',
	'sync_clipboard_emails',
	'sync_clipboard_retry',
	'sync_clipboard_timeout'
];

beforeAll(async () => {
	await runLegacySchema(env);
	await runSyncClipboardMigration(env);
});

describe('迁移工具：参数与解析', () => {

	it('--flag 与 --key value 两种形式', () => {
		expect(parseMigrationArgs(['--apply', '--config', 'wrangler.toml', '--remote']))
			.toEqual({ apply: true, config: 'wrangler.toml', remote: true });
	});

	it('从 wrangler 配置解析 database_name（取第一个 [[d1_databases]]）', () => {
		const toml = [
			'name = "cloud-mail"',
			'[[kv_namespaces]]',
			'binding = "kv"',
			'',
			'[[d1_databases]]',
			'binding = "db"',
			'database_name = "cloud-email"',
			'database_id = "53eee143-4738-48a5-8fc7-35f541de454c"'
		].join('\n');

		expect(parseDatabaseName(toml)).toBe('cloud-email');
		expect(parseDatabaseName('name = "x"')).toBe('');
	});

	it('解析 wrangler d1 execute --json 的列名输出', () => {
		const output = 'telemetry notice\n[{"results":[{"name":"email_id"},{"name":"code"}],"success":true}]\n';
		expect(parsePragmaNames(output)).toEqual(['email_id', 'code']);
		expect(parsePragmaNames('not json')).toEqual([]);
		expect(parsePragmaNames('')).toEqual([]);
	});
});

describe('迁移工具：计划与幂等', () => {

	it('缺列计算：全缺 / 部分 / 齐备', () => {
		expect(computeMissingColumns([]).map(([name]) => name)).toEqual(COLUMN_NAMES);
		expect(computeMissingColumns(['sync_clipboard_status', 'sync_clipboard_retry']).map(([name]) => name))
			.toEqual(COLUMN_NAMES.filter(name => name !== 'sync_clipboard_status' && name !== 'sync_clipboard_retry'));
		expect(computeMissingColumns(COLUMN_NAMES)).toEqual([]);
	});

	it('SQL 与共享列定义一致（唯一来源）', () => {
		expect(buildAlterSql(SETTING_TABLE, 'sync_clipboard_status', SYNC_CLIPBOARD_COLUMNS.sync_clipboard_status))
			.toBe('ALTER TABLE setting ADD COLUMN sync_clipboard_status INTEGER NOT NULL DEFAULT 1');
		expect(buildAlterSql(SETTING_TABLE, 'sync_clipboard_url', SYNC_CLIPBOARD_COLUMNS.sync_clipboard_url))
			.toBe(`ALTER TABLE setting ADD COLUMN sync_clipboard_url TEXT NOT NULL DEFAULT ''`);

		const plan = buildPlan([]);
		expect(plan).toHaveLength(8);
		expect(plan.every(item => item.sql.startsWith('ALTER TABLE setting ADD COLUMN '))).toBe(true);
	});

	it('与 Worker 内 v3_4DB 使用同一份定义（迁移后计划为空）', async () => {
		const columns = await settingColumnNames(env);

		for (const name of COLUMN_NAMES) {
			expect(columns).toContain(name);
		}

		expect(buildPlan(columns)).toEqual([]);

		// 列定义对象就是 v3_4DB 使用的对象：键集合完全一致
		expect(Object.keys(SYNC_CLIPBOARD_COLUMNS)).toEqual(COLUMN_NAMES);
	});

	it('迁移定义与实体/迁移代码一致（重复执行安全）', async () => {
		await dbInit.v3_4DB({ env, get: () => undefined, set: () => {}, req: { header: () => undefined } });
		expect(buildPlan(await settingColumnNames(env))).toEqual([]);
	});
});

describe('迁移工具：远端写入守卫', () => {

	it('默认：local + dry-run', () => {
		expect(resolveMode({}, {})).toEqual({
			write: false,
			remote: false,
			configPath: 'wrangler.toml',
			database: ''
		});
	});

	it('--apply 才写库', () => {
		expect(resolveMode({ apply: true }, {}).write).toBe(true);
	});

	it('--remote 必须同时有 --allow-remote-write 与 ALLOW_REMOTE_WRITE=1', () => {
		expect(() => resolveMode({ remote: true }, {})).toThrowError(/allow-remote-write/);
		expect(() => resolveMode({ remote: true, 'allow-remote-write': true }, {})).toThrowError(/ALLOW_REMOTE_WRITE/);
		expect(() => resolveMode({ remote: true, 'allow-remote-write': true }, { ALLOW_REMOTE_WRITE: '0' })).toThrowError();

		expect(resolveMode({ remote: true, 'allow-remote-write': true, apply: true }, { ALLOW_REMOTE_WRITE: '1' }))
			.toEqual({ write: true, remote: true, configPath: 'wrangler.toml', database: '' });
	});

	it('--database 覆盖配置解析', () => {
		expect(resolveMode({ database: 'my-db' }, {}).database).toBe('my-db');
	});
});

describe('线上脚本：凭据只走环境变量', () => {

	it('CLI 传密码/用户名一律拒绝', () => {
		expect(() => resolveCredentials({ 'sync-pass': 'x' }, { SYNC_USER: 'u', SYNC_PASS: 'p' })).toThrowError(/环境变量/);
		expect(() => resolveCredentials({ 'sync-user': 'u' }, { SYNC_USER: 'u', SYNC_PASS: 'p' })).toThrowError(/环境变量/);
	});

	it('缺少环境变量时报错', () => {
		expect(() => resolveCredentials({}, {})).toThrowError(/SYNC_USER/);
		expect(() => resolveCredentials({}, { SYNC_USER: 'u' })).toThrowError(/SYNC_USER/);
	});

	it('环境变量提供时返回凭据', () => {
		expect(resolveCredentials({}, { SYNC_USER: 'admin', SYNC_PASS: 'p' })).toEqual({ username: 'admin', password: 'p' });
	});
});

describe('线上脚本：模式解析（只读 vs apply）', () => {

	const base = { 'worker-url': 'https://mail.example.com', token: 'jwt', 'sync-url': 'https://sync-test.example.workers.dev' };

	it('只读模式不需要 recipient/expect-host，也不等待验证码', () => {
		const mode = resolveOnlineMode(base, {});
		expect(mode.apply).toBe(false);
		expect(mode.recipient).toBe('');
		expect(mode.expectHost).toBe('');
	});

	it('apply 模式必须有 recipient', () => {
		expect(() => resolveOnlineMode({ ...base, apply: true }, {})).toThrowError(/recipient/);
	});

	it('缺少 worker/token/sync-url 时报错，且拒绝 http', () => {
		expect(() => resolveOnlineMode({}, {})).toThrowError(/缺少参数/);
		expect(() => resolveOnlineMode({ ...base, 'sync-url': 'http://sync.example.com' }, {})).toThrowError(/https/);
	});

	it('可用环境变量提供参数', () => {
		const mode = resolveOnlineMode({}, { WORKER_URL: 'https://w.example.com/', ADMIN_JWT: 'j', SYNC_URL: 'https://s.example.com' });
		expect(mode.workerUrl).toBe('https://w.example.com');
		expect(mode.syncUrl).toBe('https://s.example.com');
	});
});

describe('线上脚本：apply 前置守卫（防覆盖正式目标/凭据）', () => {

	const good = {
		before: { status: 1, url: '', username: '', hasPassword: false, mode: 0 },
		syncUrl: 'https://sync-test.example.workers.dev',
		expectHost: 'sync-test.example.workers.dev',
		env: { ALLOW_REMOTE_TARGET: '1' }
	};

	it('满足全部条件才放行', () => {
		expect(checkApplyGuards(good)).toEqual([]);
	});

	it('缺少/不匹配 expect-host → 拒绝', () => {
		expect(checkApplyGuards({ ...good, expectHost: '' }).join()).toMatch(/expect-host/);
		expect(checkApplyGuards({ ...good, expectHost: 'other.example.com' }).join()).toMatch(/主机不匹配/);
	});

	it('缺少 ALLOW_REMOTE_TARGET=1 → 拒绝', () => {
		expect(checkApplyGuards({ ...good, env: {} }).join()).toMatch(/ALLOW_REMOTE_TARGET/);
		expect(checkApplyGuards({ ...good, env: { ALLOW_REMOTE_TARGET: 'true' } }).join()).toMatch(/ALLOW_REMOTE_TARGET/);
	});

	it('已有密码 → 拒绝（不能覆盖用户凭据）', () => {
		expect(checkApplyGuards({ ...good, before: { ...good.before, hasPassword: true } }).join()).toMatch(/hasPassword/);
	});

	it('已开启 → 拒绝', () => {
		expect(checkApplyGuards({ ...good, before: { ...good.before, status: 0 } }).join()).toMatch(/已开启/);
	});

	it('已指向其他目标 → 拒绝', () => {
		expect(checkApplyGuards({ ...good, before: { ...good.before, url: 'https://sync.pei.ee' } }).join()).toMatch(/其他目标/);
	});

	it('已指向同一目标且无密码未开启 → 放行', () => {
		expect(checkApplyGuards({ ...good, before: { ...good.before, url: good.syncUrl } })).toEqual([]);
	});

	it('maskOrigin 只输出主机（不含路径/凭据）', () => {
		expect(maskOrigin('https://user:pw@sync.example.com:8443/path?x=1')).toBe('sync.example.com:8443');
		expect(maskOrigin('not-a-url')).toBe('');
	});
});
