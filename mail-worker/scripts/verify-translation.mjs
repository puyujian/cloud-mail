#!/usr/bin/env node
// 线上翻译链路端到端验收：部署后跑这一条命令，就知道「翻译失败，请重试」是真修好了还是没修好。
//
//   node scripts/verify-translation.mjs --token=<登录后的 localStorage.token> [--email=<emailId>]
//
// 需要一枚已登录用户的 JWT（浏览器 DevTools → Application → Local Storage → token），
// 以及该账号角色勾选了 email:translate 权限。
//
// 退出码：0 全通过；1 有失败项（可直接用于 CI / 部署脚本的守门条件）。

const HELP = `
用法: node scripts/verify-translation.mjs --token=<JWT> [选项]

选项:
  --token=<JWT>     登录后的 Authorization token
  --user=<email>    账号邮箱，和 --password 一起用时脚本自己登录取 token
  --password=<pwd>  账号密码
  --email=<id>      指定邮件 id；不填则自动取最近一封
  --lang=<zh|en>    目标语言，默认 zh
  --base=<url>      站点地址，默认 https://email.pei.ee
  --no-cache-check  跳过第二次调用命中缓存的检查
  --verbose         打印每一步的原始响应
`;

function parseArgs(argv) {
	const args = { base: 'https://email.pei.ee', lang: 'zh', cacheCheck: true, verbose: false };
	for (const raw of argv) {
		if (raw === '-h' || raw === '--help') {
			console.log(HELP);
			process.exit(0);
		}
		if (raw === '--verbose') {
			args.verbose = true;
			continue;
		}
		if (raw === '--no-cache-check') {
			args.cacheCheck = false;
			continue;
		}
		const match = raw.match(/^--([a-z-]+)=(.*)$/);
		if (!match) {
			console.error(`无法识别的参数: ${raw}`);
			process.exit(1);
		}
		args[match[1]] = match[2];
	}
	args.base = args.base.replace(/\/+$/, '');
	if (!args.token && !(args.user && args.password)) {
		console.error('需要 --token=<JWT>，或 --user=<email> --password=<pwd>');
		console.log(HELP);
		process.exit(1);
	}
	if (!['zh', 'en'].includes(args.lang)) {
		console.error('--lang 只支持 zh / en');
		process.exit(1);
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const failures = [];

let authToken = args.token || '';

async function login() {
	const response = await fetch(`${args.base}/api/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: args.user, password: args.password })
	});
	const data = await response.json();
	if (data?.code !== 200 || !data?.data?.token) {
		throw new Error(`登录失败：${data?.message || 'HTTP ' + response.status}`);
	}
	authToken = data.data.token;
	// authInfo 写在 KV 里，最终一致：登录后立刻用可能被判 401
	await new Promise(resolve => setTimeout(resolve, 1500));
}

function pass(name, extra = '') {
	console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`);
}

function fail(name, extra = '') {
	failures.push(name);
	console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
}

async function api(path, { method = 'GET', body } = {}, retried = false) {
	const url = `${args.base}/api${path}`;
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: authToken,
			'accept-language': args.lang === 'zh' ? 'zh' : 'en',
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await response.text();
	let data = null;
	try {
		data = JSON.parse(text);
	} catch (e) {
		data = null;
	}
	if (args.verbose) {
		console.log(`     ${method} ${url} -> ${response.status} ${text.slice(0, 400)}`);
	}
	// KV 最终一致会让刚登录的 token 偶发 401，重新登录再来一次
	if (!retried && data?.code === 401 && args.user && args.password) {
		await login();
		return api(path, { method, body }, true);
	}
	return { status: response.status, data, text };
}

// 只看“文字字符”：HTML 标签、style/url、数字和标点都不该稀释语言占比，
// 否则一封翻译得很好的邮件也会因为标签多而被判成“没翻译”。
function plainText(html) {
	return String(html || '')
		.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&[a-z#0-9]{2,8};/gi, ' ');
}

function cjkShare(text) {
	const chars = Array.from(plainText(text));
	const cjk = chars.filter(ch => /[\u4e00-\u9fff]/.test(ch)).length;
	const latin = chars.filter(ch => /[A-Za-z]/.test(ch)).length;
	const total = cjk + latin;
	return total === 0 ? 0 : cjk / total;
}

async function pickEmail() {
	if (args.email) return Number(args.email);
	// allReceive=1 表示跨账号取最近收件，避免依赖具体 accountId
	const latest = await api('/email/latest?emailId=0&allReceive=1');
	if (latest.data?.code !== 200) {
		const error = new Error(latest.data?.message || `HTTP ${latest.status}`);
		error.code = latest.data?.code;
		throw error;
	}
	const rows = Array.isArray(latest.data?.data) ? latest.data.data : [];
	const first = rows.find(row => row?.emailId);
	if (!first) {
		throw new Error('账号里没有收件，请用 --email=<id> 指定一封');
	}
	return Number(first.emailId);
}

async function runJob(emailId) {
	const started = Date.now();
	let { data } = await api('/email/translate', {
		method: 'POST',
		body: { emailId, targetLang: args.lang }
	});
	if (data?.code !== 200) {
		return { job: null, error: data };
	}

	let payload = data.data;
	let rounds = 0;
	// start 之后任务处于 pending，必须由 step 一块一块推进
	while (payload.state !== 'done' && payload.state !== 'error') {
		rounds += 1;
		if (rounds > 400) {
			return { job: payload, error: { message: 'step 轮询超过 400 轮仍未结束' } };
		}
		const step = await api('/email/translate/step', {
			method: 'POST',
			body: { jobId: payload.jobId }
		});
		if (step.data?.code !== 200) {
			return { job: payload, error: step.data };
		}
		payload = step.data.data;
	}

	const ms = Date.now() - started;
	if (payload.state === 'error') {
		return { job: payload, error: { message: payload.message || '任务失败', errorKey: payload.errorKey } };
	}
	return { job: payload, ms, rounds };
}

async function main() {
	console.log(`\n== 邮件全文翻译端到端验收 @ ${args.base} ==\n`);

	// 1) 站点可达
	const config = await api('/setting/websiteConfig');
	if (config.data?.code === 200) {
		pass('站点可达');
	} else {
		fail('站点可达', `HTTP ${config.status} ${config.text.slice(0, 120)}`);
		return;
	}

	// 2) 权限与登录态
	let emailId = null;
	try {
		emailId = await pickEmail();
	} catch (e) {
		fail('读取收件列表', e.message);
		if (e.code === 401 || e.code === 403) {
			console.log('     提示：token 过期，重新登录后从 localStorage 再取一枚');
		} else {
			console.log('     提示：用 --email=<id> 指定一封邮件跳过这一步');
		}
		return;
	}
	pass('选中邮件', `emailId=${emailId}`);

	// 3) 首轮翻译
	console.log('  … 首次翻译（会真实消耗 Workers AI 额度）');
	const first = await runJob(emailId).catch(e => ({ error: { message: e.message } }));
	if (first.error) {
		const key = first.error.errorKey ? ` [${first.error.errorKey}]` : '';
		fail('首次翻译', `${first.error.message}${key}`);
		if (first.error.code === 401 || first.error.code === 403) {
			console.log('     提示：token 过期或该角色没有 email:translate 权限');
		}
		return;
	}
	const job = first.job;
	pass('首次翻译完成', `${first.ms}ms / ${first.rounds} 轮 step / 分块 ${job.progress?.total ?? '?'}`);
	// 通道写清楚：配了外部通道却静默退回 Workers AI 时，一眼就能看出来
	pass('翻译通道', job.model || '未标记');

	// 4) 译文内容检查
	const content = job.content || '';
	const text = job.text || '';
	if (content.trim()) {
		pass('译文非空', `${Array.from(content).length} 字符`);
	} else {
		fail('译文非空', 'content 为空');
	}

	if (job.fallback) {
		fail('格式保留', '走了纯文本降级，HTML 版式没有保住');
	} else if (/<[a-z][\s\S]*>/i.test(content)) {
		const tags = new Set((content.match(/<([a-z][a-z0-9-]*)/gi) || []).map(t => t.slice(1).toLowerCase()));
		pass('格式保留', `标签 ${[...tags].slice(0, 8).join(',')}${tags.size > 8 ? '…' : ''}`);
	} else {
		fail('格式保留', '译文里没有任何 HTML 标签');
	}

	const share = cjkShare(text || content);
	if (args.lang === 'zh') {
		// 登录通知这类邮件会原样保留 UA、IP、用户名，拉丁字母占比很高，
		// 只要正文有两成以上是中文就足以证明真的翻了（实测这封是 36%）
		if (share > 0.2) {
			pass('目标语言正确', `中文占文字字符 ${(share * 100).toFixed(0)}%`);
		} else {
			fail('目标语言正确', `中文只占 ${(share * 100).toFixed(0)}%，可能没有真正翻译`);
		}
	} else if (share < 0.15) {
		pass('目标语言正确', `中文残留 ${(share * 100).toFixed(0)}%，已转成英文`);
	} else {
		fail('目标语言正确', `中文残留 ${(share * 100).toFixed(0)}%，可能没有真正翻译`);
	}

	// 5) 缓存命中（同一封邮件再翻一次应当直接返回缓存）
	if (args.cacheCheck) {
		const second = await api('/email/translate', {
			method: 'POST',
			body: { emailId, targetLang: args.lang }
		});
		const payload = second.data?.data;
		if (second.data?.code === 200 && payload?.cached && payload.state === 'done') {
			pass('缓存命中', '同封邮件秒回');
		} else {
			fail('缓存命中', `cached=${payload?.cached} state=${payload?.state}`);
		}
	}

	console.log('\n预览：');
	console.log('  ' + String(text || content).replace(/\s+/g, ' ').slice(0, 160) + '…');
}

main()
	.catch(e => {
		fail('脚本异常', e?.stack || String(e));
	})
	.finally(() => {
		console.log('');
		if (failures.length > 0) {
			console.log(`❌ 验收未通过（${failures.length} 项）：${failures.join('、')}`);
			process.exit(1);
		}
		console.log('✅ 全部通过');
	});
