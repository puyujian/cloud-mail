#!/usr/bin/env node
/**
 * 线上验收脚本：cloud-mail 收信 → SyncClipboardCfServer 当前剪贴板
 *
 * 设计原则：
 *   - 默认只读（dry-run）：只做 GET + 只读连通性测试（PUT /api/setting/testSyncClipboard 仅 GET 目标 /api/version）
 *   - 只有显式 `--apply` 才会修改 Worker 设置；不会删除任何邮件
 *   - 不打印密码；不打印目标响应体
 *   - 必须指向隔离的 CfServer 实例：用 `--expect-host` 断言目标主机，避免误连正式实例
 *
 * 用法：
 *   node test/online/verify-sync-clipboard.mjs \
 *     --worker-url https://mail.example.com \
 *     --token "$ADMIN_JWT" \
 *     --sync-url https://sync-test.example.workers.dev \
 *     --expect-host sync-test.example.workers.dev \
 *     --sync-user admin --sync-pass "$SYNC_PASS" \
 *     --recipient admin@example.com \
 *     [--mode selected|all] [--expect-code 012345] [--timeout 300] [--apply] [--restore]
 *
 * 验收步骤（脚本会逐条打印）：
 *   1) 目标实例只读探测：GET /api/version、GET /SyncClipboard.json（记录基线 hash/text）
 *   2) 读取当前 Worker 端配置（应看不到密码，只有 hasPassword）
 *   3) 只读连通性测试（PUT /api/setting/testSyncClipboard，后端只 GET）
 *   4) --apply：写入配置（默认关闭→开启，selected 模式限定到 --recipient）
 *   5) 等待外部真实邮件进入收件箱（轮询 /api/allEmail/list），取出 AI 提取的 code
 *   6) 轮询目标实例剪贴板，断言 text === code、hash === 大写 SHA256(text)、size === 字符数（含前导零）
 *   7) --restore：把非敏感字段恢复为脚本开始前的值（密码无法恢复，脚本会提示）
 *
 * 退出码：0 = 通过；1 = 失败；2 = 参数/前置条件错误
 */

import { createHash } from 'node:crypto';

const args = parseArgs(process.argv.slice(2));

const REQUIRED = ['worker-url', 'token', 'sync-url', 'sync-user', 'sync-pass', 'recipient'];
for (const key of REQUIRED) {
	if (!args[key]) {
		fail(2, `缺少参数 --${key}（见脚本头部用法）`);
	}
}

const workerUrl = trimSlash(args['worker-url']);
const syncUrl = trimSlash(args['sync-url']);
const recipient = String(args.recipient).trim().toLowerCase();
const mode = args.mode === 'all' ? 0 : 1;
const timeoutMs = Number(args.timeout || 300) * 1000;
const apply = args.apply === true;
const restore = args.restore === true;

if (!/^https:\/\//.test(syncUrl)) {
	fail(2, '--sync-url 必须是 https:// 开头');
}

if (args['expect-host'] && new URL(syncUrl).host !== String(args['expect-host']).trim()) {
	fail(2, `目标主机不匹配：实际 ${new URL(syncUrl).host}，期望 ${args['expect-host']}`);
}

const basic = 'Basic ' + Buffer.from(`${args['sync-user']}:${args['sync-pass']}`, 'utf8').toString('base64');

const steps = [];
function step(name, ok, detail = '') {
	steps.push({ name, ok, detail });
	console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(code, message) {
	console.error(`\n⛔ ${message}\n`);
	process.exit(code);
}

async function syncFetch(path, options = {}) {
	return await fetch(syncUrl + path, {
		...options,
		headers: { authorization: basic, accept: 'application/json', ...(options.headers || {}) },
		redirect: 'manual'
	});
}

async function workerFetch(path, options = {}) {
	return await fetch(workerUrl + path, {
		...options,
		headers: {
			authorization: args.token,
			'content-type': 'application/json',
			...(options.headers || {})
		},
		redirect: 'manual'
	});
}

async function workerJson(path, options) {
	const res = await workerFetch(path, options);
	const text = await res.text();

	let json;
	try {
		json = JSON.parse(text);
	} catch {
		fail(1, `${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
	}

	if (json.code !== 200) {
		fail(1, `${path} 业务失败 code=${json.code} message=${json.message}`);
	}

	return json.data;
}

async function readClipboard() {
	const res = await syncFetch('/SyncClipboard.json');
	if (res.status !== 200) {
		fail(1, `GET /SyncClipboard.json 失败 HTTP ${res.status}`);
	}
	return await res.json();
}

async function main() {

	console.log(`\n=== SyncClipboard 线上验收（${apply ? 'APPLY' : 'DRY-RUN'}）===\n`);
	console.log(`Worker   : ${workerUrl}`);
	console.log(`Sync 实例: ${syncUrl}`);
	console.log(`收件邮箱 : ${recipient}（模式 ${mode === 1 ? 'selected' : 'all'}）\n`);

	// 1) 目标实例只读探测
	const versionRes = await syncFetch('/api/version');
	step('目标实例 GET /api/version', versionRes.status === 200, `HTTP ${versionRes.status}`);

	const baseline = await readClipboard();
	step('目标实例 GET /SyncClipboard.json（基线）', true, `hash=${short(baseline.hash)} size=${baseline.size ?? '-'}`);

	// 2) 读取当前配置（必须看不到密码）
	const before = await workerJson('/api/setting/querySyncClipboard');
	if (Object.prototype.hasOwnProperty.call(before, 'password')) {
		fail(1, 'GET /setting/querySyncClipboard 回传了 password 字段（不应存在）');
	}
	step('读取 Worker 配置（无密码回显）', true,
		`status=${before.status} url=${before.url || '-'} hasPassword=${before.hasPassword} mode=${before.mode} retry=${before.retry}`);

	// 3) 只读连通性测试（后端只 GET 目标 /api/version）
	const testResult = await workerJson('/api/setting/testSyncClipboard', {
		method: 'PUT',
		body: JSON.stringify({
			url: syncUrl,
			username: args['sync-user'],
			password: args['sync-pass']
		})
	});
	step('只读连通性测试（不覆盖剪贴板）', testResult.ok === true,
		`ok=${testResult.ok} status=${testResult.status} path=${testResult.path} reason=${testResult.reason || '-'}`);

	if (!apply) {
		console.log('\n（dry-run 结束：加 --apply 才会写入配置并等待真实邮件）');
		report();
		return;
	}

	// 4) 写入配置（selected 模式限定到测试收件箱，retry 用 1）
	const saved = await workerJson('/api/setting/setSyncClipboard', {
		method: 'PUT',
		body: JSON.stringify({
			status: 0,
			url: syncUrl,
			username: args['sync-user'],
			password: args['sync-pass'],
			mode,
			emails: mode === 1 ? recipient : '',
			retry: 1
		})
	});
	step('写入配置（开启 + 指定范围）', saved.hasPassword === true && saved.status === 0,
		`status=${saved.status} mode=${saved.mode} emails=${saved.emails || '-'}`);

	const startedAt = Date.now();

	// 5) 等待真实外部邮件进入收件箱
	console.log(`\n⏳ 等待外部真实邮件到达 ${recipient}（最多 ${timeoutMs / 1000}s，请从站外邮箱发送带验证码的邮件）...\n`);

	const mail = await waitForEmail(startedAt);
	if (!mail) {
		fail(1, `超时未收到新邮件（${recipient}）`);
	}

	if (!mail.code) {
		fail(1, `邮件 emailId=${mail.emailId} 未提取到验证码（检查 aiCode / aiCodeFilter）`);
	}

	if (args['expect-code'] && String(args['expect-code']) !== String(mail.code)) {
		fail(1, `验证码不一致：邮件内为 ${mail.code}，期望 ${args['expect-code']}`);
	}

	step('收到邮件且提取到验证码', true,
		`emailId=${mail.emailId} code 长度=${String(mail.code).length} 前导零=${/^0/.test(String(mail.code))}`);

	// 6) 轮询目标剪贴板
	const deadline = Date.now() + timeoutMs;
	let profile = null;

	while (Date.now() < deadline) {
		profile = await readClipboard();
		if (String(profile.text) === String(mail.code)) {
			break;
		}
		await sleep(3000);
	}

	if (!profile || String(profile.text) !== String(mail.code)) {
		fail(1, `剪贴板未同步到验证码：当前 text=${JSON.stringify(profile?.text ?? null)}`);
	}

	const expectedHash = createHash('sha256').update(String(mail.code), 'utf8').digest('hex').toUpperCase();

	step('剪贴板 text 与邮件验证码一致（含前导零）', true, `text=${JSON.stringify(profile.text)}`);
	step('hash = 大写 SHA256(UTF-8 验证码)', profile.hash === expectedHash, `hash=${short(profile.hash)}`);
	step('size = 字符数', Number(profile.size) === String(mail.code).length, `size=${profile.size}`);
	step('type = Text 且 hasData=false', profile.type === 'Text' && profile.hasData === false,
		`type=${profile.type} hasData=${profile.hasData} dataName=${JSON.stringify(profile.dataName)}`);

	if (restore) {
		await workerJson('/api/setting/setSyncClipboard', {
			method: 'PUT',
			body: JSON.stringify({
				status: before.status,
				url: before.url || '',
				username: before.username || '',
				mode: before.mode,
				emails: before.emails || '',
				retry: before.retry
			})
		});
		step('已恢复脚本前的非敏感配置', true, `status=${before.status}（密码保持本次配置，write-only 无法回读恢复）`);
	} else {
		console.log('\n⚠️  未使用 --restore：Worker 端仍保持“已开启”状态，请按需手动关闭。');
	}

	report();
}

async function waitForEmail(startedAt) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const res = await workerFetch(
			`/api/allEmail/list?accountEmail=${encodeURIComponent(recipient)}&type=receive&size=5&timeSort=0`
		);
		const text = await res.text();

		try {
			const json = JSON.parse(text);
			if (json.code === 200 && json.data?.list?.length) {
				const fresh = json.data.list.find(row => new Date(String(row.createTime).replace(' ', 'T') + 'Z').getTime() >= startedAt - 5000);
				if (fresh) {
					return fresh;
				}
			}
		} catch {
			// 忽略瞬时解析错误，继续轮询
		}

		await sleep(5000);
	}

	return null;
}

function report() {
	const failed = steps.filter(item => !item.ok);
	console.log(`\n=== 结果：${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`} （共 ${steps.length} 项）===\n`);
	process.exit(failed.length === 0 ? 0 : 1);
}

function parseArgs(argv) {
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

function trimSlash(value) {
	return String(value).replace(/\/+$/, '');
}

function short(value) {
	const text = String(value ?? '');
	return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => fail(1, `未捕获异常：${err?.name || 'Error'}`));
