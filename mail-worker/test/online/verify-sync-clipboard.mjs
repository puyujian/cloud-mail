#!/usr/bin/env node
/**
 * 线上验收脚本：cloud-mail 收信 → SyncClipboardCfServer 当前剪贴板
 *
 * 两种模式，严格分离：
 *
 *  1) 只读连通性检查（默认，不需要 --recipient，不需要外部发信，不等待验证码）
 *     - GET 目标实例 /api/version（只看状态码，不读剪贴板正文）
 *     - PUT Worker /api/setting/testSyncClipboard（后端本身只 GET，绝不写剪贴板）
 *     - GET Worker /api/setting/querySyncClipboard（只看 status/mode/hasPassword/retry 与目标主机名）
 *     - 不读取、不打印任何邮件正文或剪贴板内容
 *
 *  2) 集成验收（--apply）：写配置 → 等真实外部邮件 → 校验剪贴板
 *     - 需要外部真实发信（站内发信不走 Email Worker，不会触发同步）
 *     - 输出只包含长度/布尔/状态码，**不打印验证码与剪贴板正文**
 *
 * 安全约束：
 *   - 凭据只从环境变量读取：SYNC_USER / SYNC_PASS（CLI 传密码会被拒绝，避免出现在进程列表）
 *   - --apply 必须同时满足：显式 --expect-host（且与 --sync-url 主机一致）+ 环境变量 ALLOW_REMOTE_TARGET=1
 *   - --apply 拒绝在「已有密码」或「已开启」或「已指向其他目标」的配置上执行，避免覆盖用户正式目标与凭据
 *   - 默认推荐只对**隔离实例**使用；--restore 会清掉本次写入的测试密码（因为起始状态必为关闭）
 *
 * 用法：
 *   # 只读连通性检查（默认）
 *   WORKER_URL=https://mail.example.com ADMIN_JWT=... \
 *   SYNC_URL=https://sync-test.example.workers.dev SYNC_USER=admin SYNC_PASS=... \
 *   node test/online/verify-sync-clipboard.mjs
 *
 *   # 集成验收（隔离实例）
 *   ALLOW_REMOTE_TARGET=1 WORKER_URL=... ADMIN_JWT=... SYNC_URL=... SYNC_USER=... SYNC_PASS=... \
 *   node test/online/verify-sync-clipboard.mjs --apply --expect-host sync-test.example.workers.dev \
 *     --recipient admin@example.com [--mode selected|all] [--expect-code 012345] [--timeout 300] [--restore]
 *
 * 退出码：0 = 通过；1 = 失败；2 = 参数/前置条件错误
 */

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

/** 凭据只允许来自环境变量（避免 CLI 参数留在进程列表里） */
export function resolveCredentials(args, env = {}) {
	if (args['sync-pass'] !== undefined || args['sync-user'] !== undefined) {
		throw new Error('凭据不能通过命令行传入：请使用环境变量 SYNC_USER / SYNC_PASS');
	}

	const username = String(env.SYNC_USER ?? '').trim();
	const password = String(env.SYNC_PASS ?? '');

	if (!username || !password) {
		throw new Error('缺少凭据：请设置环境变量 SYNC_USER / SYNC_PASS');
	}

	return { username, password };
}

export function resolveOnlineMode(args, env = {}) {
	const apply = args.apply === true;

	const workerUrl = trimSlash(args['worker-url'] || env.WORKER_URL || '');
	const syncUrl = trimSlash(args['sync-url'] || env.SYNC_URL || '');
	const token = String(args.token || env.ADMIN_JWT || '');

	if (!workerUrl || !syncUrl || !token) {
		throw new Error('缺少参数：--worker-url / --token / --sync-url（也可用环境变量 WORKER_URL / ADMIN_JWT / SYNC_URL）');
	}

	if (!/^https:\/\//.test(syncUrl)) {
		throw new Error('--sync-url 必须是 https:// 开头');
	}

	const recipient = String(args.recipient || env.RECIPIENT || '').trim().toLowerCase();

	if (apply && !recipient) {
		throw new Error('--apply 需要 --recipient（集成验收必须指定收件箱）');
	}

	return {
		apply,
		restore: args.restore === true,
		workerUrl,
		syncUrl,
		token,
		recipient,
		expectHost: String(args['expect-host'] || '').trim(),
		mode: args.mode === 'all' ? 0 : 1,
		timeoutMs: Number(args.timeout || 300) * 1000
	};
}

/**
 * --apply 前置守卫（纯函数，便于测试）：返回错误列表，空数组表示允许。
 * 目的：绝不覆盖用户正式目标 / 已有凭据 / 已开启的配置。
 */
export function checkApplyGuards({ before, syncUrl, expectHost, env = {} }) {
	const errors = [];

	if (!expectHost) {
		errors.push('缺少 --expect-host：apply 模式必须显式声明目标主机，防止误连正式实例');
	} else if (new URL(syncUrl).host !== expectHost) {
		errors.push(`目标主机不匹配：实际 ${new URL(syncUrl).host}，期望 ${expectHost}`);
	}

	if (String(env.ALLOW_REMOTE_TARGET ?? '') !== '1') {
		errors.push('缺少环境变量 ALLOW_REMOTE_TARGET=1（显式确认对远端目标写入）');
	}

	if (before?.hasPassword) {
		errors.push('现有配置已保存密码（hasPassword=true）：拒绝 apply，避免覆盖用户凭据');
	}

	if (Number(before?.status) === 0) {
		errors.push('现有配置已开启（status=0）：拒绝 apply，请先由用户/管理员关闭');
	}

	const beforeOrigin = trimSlash(before?.url || '');
	if (beforeOrigin && beforeOrigin !== trimSlash(syncUrl)) {
		errors.push(`现有配置已指向其他目标（${maskOrigin(beforeOrigin)}）：拒绝 apply`);
	}

	return errors;
}

/** 只保留主机名（含端口），不泄露路径/查询 */
export function maskOrigin(url) {
	try {
		const parsed = new URL(String(url));
		return parsed.host;
	} catch {
		return '';
	}
}

function trimSlash(value) {
	return String(value || '').replace(/\/+$/, '');
}

function short(value) {
	const text = String(value ?? '');
	return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const env = globalThis.process?.env || {};

	const steps = [];
	const step = (name, ok, detail = '') => {
		steps.push({ name, ok });
		console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
	};

	const fail = (code, message) => {
		console.error(`\n⛔ ${message}\n`);
		process.exit(code);
	};

	let mode;
	let credentials;

	try {
		mode = resolveOnlineMode(args, env);
		credentials = resolveCredentials(args, env);
	} catch (e) {
		fail(2, e.message);
	}

	const basic = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64');

	const syncFetch = (path, options = {}) => fetch(mode.syncUrl + path, {
		...options,
		headers: { authorization: basic, accept: 'application/json', ...(options.headers || {}) },
		redirect: 'manual'
	});

	const workerFetch = (path, options = {}) => fetch(mode.workerUrl + path, {
		...options,
		headers: { authorization: mode.token, 'content-type': 'application/json', ...(options.headers || {}) },
		redirect: 'manual'
	});

	const workerJson = async (path, options) => {
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
	};

	console.log(`\n=== SyncClipboard 验收（${mode.apply ? 'APPLY 集成验收' : 'READ-ONLY 连通性检查'}）===\n`);
	console.log(`Worker   : ${maskOrigin(mode.workerUrl)}`);
	console.log(`Sync 实例: ${maskOrigin(mode.syncUrl)}`);
	if (mode.apply) {
		console.log(`收件邮箱 : ${mode.recipient}（模式 ${mode.mode === 1 ? 'selected' : 'all'}）`);
	}
	console.log('');

	// --- 只读部分（两种模式共用，均不读取剪贴板/邮件正文）---

	const versionRes = await syncFetch('/api/version');
	step('目标实例 GET /api/version（只读连通）', versionRes.status === 200, `HTTP ${versionRes.status}`);

	const before = await workerJson('/api/setting/querySyncClipboard');

	if (Object.prototype.hasOwnProperty.call(before, 'password')) {
		fail(1, 'GET /setting/querySyncClipboard 回传了 password 字段（不应存在）');
	}

	step('读取 Worker 配置（无密码回显）', true,
		`status=${before.status} target=${before.url ? maskOrigin(before.url) : '-'} hasPassword=${before.hasPassword} mode=${before.mode} retry=${before.retry}`);

	const testResult = await workerJson('/api/setting/testSyncClipboard', {
		method: 'PUT',
		body: JSON.stringify({
			url: mode.syncUrl,
			username: credentials.username,
			password: credentials.password
		})
	});

	step('只读连通性测试（后端仅 GET，不覆盖剪贴板）', testResult.ok === true,
		`ok=${testResult.ok} status=${testResult.status} path=${testResult.path} reason=${testResult.reason || '-'}`);

	if (!mode.apply) {
		console.log('\n（只读检查结束：未读取任何邮件/剪贴板内容，未修改任何配置）');
		report(steps);
		return;
	}

	// --- 集成验收（仅 --apply）---

	const guardErrors = checkApplyGuards({
		before,
		syncUrl: mode.syncUrl,
		expectHost: mode.expectHost,
		env
	});

	if (guardErrors.length > 0) {
		fail(2, `apply 前置守卫未通过：\n  - ${guardErrors.join('\n  - ')}`);
	}

	step('apply 前置守卫（目标隔离 + 无既有凭据 + 未开启）', true, `expect-host=${mode.expectHost}`);

	const saved = await workerJson('/api/setting/setSyncClipboard', {
		method: 'PUT',
		body: JSON.stringify({
			status: 0,
			url: mode.syncUrl,
			username: credentials.username,
			password: credentials.password,
			mode: mode.mode,
			emails: mode.mode === 1 ? mode.recipient : '',
			retry: 1
		})
	});

	step('写入配置（开启 + 指定范围）', saved.hasPassword === true && saved.status === 0,
		`status=${saved.status} mode=${saved.mode} emails=${saved.emails || '-'}`);

	const startedAt = Date.now();

	console.log(`\n⏳ 等待外部真实邮件到达 ${mode.recipient}（最多 ${mode.timeoutMs / 1000}s，请从站外邮箱发送带验证码的邮件）...\n`);

	const mail = await waitForEmail(mode, workerFetch, startedAt);

	if (!mail) {
		fail(1, `超时未收到新邮件（${mode.recipient}）`);
	}

	const code = String(mail.code || '');

	if (!code) {
		fail(1, `邮件 emailId=${mail.emailId} 未提取到验证码（检查 aiCode / aiCodeFilter）`);
	}

	if (args['expect-code'] && String(args['expect-code']) !== code) {
		fail(1, '验证码与 --expect-code 不一致（不打印内容，请人工核对）');
	}

	step('收到邮件且提取到验证码', true,
		`emailId=${mail.emailId} 长度=${code.length} 前导零=${/^0/.test(code)}`);

	const deadline = Date.now() + mode.timeoutMs;
	let profile = null;

	while (Date.now() < deadline) {
		profile = await readProfile(mode, syncFetch);
		if (String(profile?.text ?? '') === code) {
			break;
		}
		await sleep(3000);
	}

	if (String(profile?.text ?? '') !== code) {
		fail(1, `剪贴板未同步到验证码（当前 text 长度=${String(profile?.text ?? '').length}）`);
	}

	const expectedHash = await sha256Upper(code);

	step('剪贴板内容与邮件验证码一致（含前导零）', true, `长度=${code.length} 前导零=${/^0/.test(code)}`);
	step('hash = 大写 SHA256(UTF-8 验证码)', profile.hash === expectedHash, `hash=${short(profile.hash)}`);
	step('size = 字符数', Number(profile.size) === code.length, `size=${profile.size}`);
	step('type = Text 且 hasData=false', profile.type === 'Text' && profile.hasData === false,
		`type=${profile.type} hasData=${profile.hasData} dataName=${JSON.stringify(profile.dataName)}`);

	if (mode.restore) {
		// 起始状态必为“关闭且无密码”（守卫保证），因此可以连同测试密码一起清掉
		await workerJson('/api/setting/setSyncClipboard', {
			method: 'PUT',
			body: JSON.stringify({
				status: before.status,
				url: before.url || '',
				username: before.username || '',
				mode: before.mode,
				emails: before.emails || '',
				retry: before.retry,
				clearPassword: true
			})
		});
		step('已恢复脚本前的配置（含清除本次测试密码）', true, `status=${before.status}`);
	} else {
		console.log('\n⚠️  未使用 --restore：Worker 端仍保持“已开启 + 本次测试密码”，请及时关闭并清除。');
	}

	report(steps);
}

async function readProfile(mode, syncFetch) {
	const res = await syncFetch('/SyncClipboard.json');

	if (res.status !== 200) {
		return null;
	}

	return await res.json();
}

async function waitForEmail(mode, workerFetch, startedAt) {
	const deadline = Date.now() + mode.timeoutMs;

	while (Date.now() < deadline) {
		const res = await workerFetch(
			`/api/allEmail/list?accountEmail=${encodeURIComponent(mode.recipient)}&type=receive&size=5&timeSort=0`
		);
		const text = await res.text();

		try {
			const json = JSON.parse(text);
			if (json.code === 200 && json.data?.list?.length) {
				const fresh = json.data.list.find(row => {
					const time = new Date(String(row.createTime).replace(' ', 'T') + 'Z').getTime();
					return Number.isFinite(time) && time >= startedAt - 5000;
				});
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

async function sha256Upper(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	let hex = '';
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex.toUpperCase();
}

function report(steps) {
	const failed = steps.filter(item => !item.ok);
	console.log(`\n=== 结果：${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`} （共 ${steps.length} 项）===\n`);
	process.exit(failed.length === 0 ? 0 : 1);
}

// 仅作为 CLI 直接运行时才执行（被测试 import 时不触发）
const entry = globalThis.process?.argv?.[1] || '';
if (entry.endsWith('verify-sync-clipboard.mjs')) {
	main().catch(e => {
		console.error(`\n⛔ 未捕获异常：${e?.name || 'Error'}\n`);
		process.exit(1);
	});
}
