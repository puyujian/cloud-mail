import { settingConst } from '../const/entity-const';
import KvConst from '../const/kv-const';

/**
 * SyncClipboardCfServer 集成。
 *
 * 协议依据：SyncClipboardCfServer docs/protocol.md
 *   - 所有端点要求 HTTP Basic Auth
 *   - PUT /SyncClipboard.json 写入「当前剪贴板」Text profile：
 *     { type:'Text', hash:大写 SHA256(UTF-8 全文), text:全文, hasData:false, dataName:null, size:字符数 }
 *   - 服务端自行同步 current profile / 历史 / 广播，本集成只负责写当前剪贴板
 *   - GET /api/version（只读）用于连通性测试
 *
 * 安全约束（与设置 UI / 测试一致）：
 *   - 只允许 https，禁止 URL 内嵌凭据、IP 字面量、localhost/内网域名、非根路径
 *   - redirect:'manual'，绝不跟随跳转，避免 Basic 凭据泄漏到第三方主机
 *   - 超时用 AbortController；401/403 与 4xx 不重试；5xx/429/408/网络错误有限重试
 *   - 单次同步（含全部重试与退避）受 MAX_TOTAL_BUDGET_MS 硬上限约束，必须小于 waitUntil 后台窗口
 *   - 不读取、不记录目标响应体；日志只输出固定原因 + emailId/status，绝不输出验证码、密码、
 *     目标 URL、响应体或任意 e.message（异常对象可能携带请求 URL / 凭据 / 内容）
 *
 * 去重语义（best effort，非严格保证）：
 *   - 去重键 = messageId(缺失时用 emailId) + 收件邮箱，键与值都不含验证码
 *   - KV 最终一致且无跨请求原子性，不承诺 exactly-once；重复投递极少数情况下可能双写
 *   - 无持久有序队列，因此无法保证「晚到的旧验证码不会覆盖新值」：
 *     乱序/延迟到达的邮件仍会按其到达顺序写入，服务端历史由 SyncClipboardCfServer 负责
 */

const PROFILE_PATH = '/SyncClipboard.json';
const VERSION_PATH = '/api/version';

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const DEFAULT_RETRY = 2;
const MAX_RETRY = 3;

// 去重标记 TTL：同一封邮件（messageId+收件箱）在此窗口内不重复写入剪贴板
const DEDUPE_TTL_SECONDS = 60 * 60 * 24;

// 有界退避：最多 MAX_RETRY 次重试，退避 250/500/750ms，累计 ≤1500ms，且全部计入总预算
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 750;

// 单次同步的总预算硬上限（含全部重试、退避、超时等待）。
// 最坏配置 15s 超时 × (1+3) 次 = 60s，会超出 ctx.waitUntil 常见的 30s 后台窗口，
// 因此这里统一收敛：任何路径（同步写入 / 只读连通测试）都不会超过该预算。
const MAX_TOTAL_BUDGET_MS = 25000;

const encoder = new TextEncoder();

// 明确拒绝的本机/内网后缀（域名解析到内网 IP 的情况无法在配置期判定，见 README 已知限制）
const LOCAL_HOST_RE = /(^|\.)localhost$|(^|\.)local$|(^|\.)internal$|(^|\.)home\.arpa$|(^|\.)localhost\.localdomain$/;

function toInt(value, fallback) {
	if (value === null || value === undefined || value === '') return fallback;
	const num = Number(value);
	return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function clampInt(value, min, max, fallback) {
	const num = toInt(value, fallback);
	if (num < min) return min;
	if (num > max) return max;
	return num;
}

function normalizeHost(hostname) {
	return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

// IPv6（含 [::1] 形式）、IPv4 字面量、纯数字（十进制 IP，如 2130706433）
function isIpLiteral(host) {
	if (!host) return true;
	if (host.startsWith('[') || host.includes(':')) return true;
	if (/^\d+$/.test(host)) return true;
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * 校验管理员配置的目标地址。
 * 只接受 `https://<公网域名>[:端口]/`，返回 origin 供拼协议路径。
 */
function validateTargetUrl(rawUrl) {
	const value = String(rawUrl ?? '').trim();

	if (!value) {
		return { ok: false, reason: 'url-empty' };
	}

	let url;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, reason: 'url-invalid' };
	}

	if (url.protocol !== 'https:') {
		return { ok: false, reason: 'url-not-https' };
	}

	// 防 URL 内嵌凭据：既会泄漏到日志/URL，也与 Basic 头冲突
	if (url.username || url.password) {
		return { ok: false, reason: 'url-has-credentials' };
	}

	// 只使用 origin；带路径/查询/片段说明配置错了位置，直接拒绝而不是静默丢弃
	if (url.pathname !== '/' || url.search || url.hash) {
		return { ok: false, reason: 'url-has-path' };
	}

	const host = normalizeHost(url.hostname);

	if (!host) {
		return { ok: false, reason: 'url-invalid' };
	}

	if (isIpLiteral(host)) {
		return { ok: false, reason: 'url-ip-not-supported' };
	}

	if (LOCAL_HOST_RE.test(host) || !host.includes('.')) {
		return { ok: false, reason: 'url-local-not-supported' };
	}

	return { ok: true, origin: url.origin, host };
}

function normalizeEmails(value) {
	const list = String(value ?? '')
		.split(/[,，;；\s]+/)
		.map(item => item.trim().toLowerCase())
		.filter(Boolean);

	// 去重（保持首次出现顺序）
	return Array.from(new Set(list));
}

/** 收件箱过滤：全站放行；指定模式要求收件邮箱在名单内（大小写不敏感） */
function matchRecipient(config, toEmail) {
	if (config.mode !== settingConst.syncClipboardMode.SELECTED) {
		return true;
	}

	const target = String(toEmail ?? '').trim().toLowerCase();
	if (!target) {
		return false;
	}

	return normalizeEmails(config.emails).includes(target);
}

/** 把设置行（含旧库/KV 缺字段的情况）归一化为内部配置对象 */
function resolveConfig(raw) {
	const source = raw || {};

	return {
		status: toInt(source.syncClipboardStatus, settingConst.syncClipboardStatus.CLOSE),
		url: String(source.syncClipboardUrl ?? '').trim(),
		username: String(source.syncClipboardUsername ?? '').trim(),
		password: String(source.syncClipboardPassword ?? ''),
		mode: toInt(source.syncClipboardMode, settingConst.syncClipboardMode.ALL),
		emails: String(source.syncClipboardEmails ?? ''),
		retry: clampInt(source.syncClipboardRetry, 0, MAX_RETRY, DEFAULT_RETRY),
		timeout: clampInt(source.syncClipboardTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
	};
}

async function sha256Hex(text, upperCase) {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
	let hex = '';
	for (const byte of new Uint8Array(digest)) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return upperCase ? hex.toUpperCase() : hex;
}

/** 构造 Text profile；验证码按原样保留前导零，size 为字符数 */
async function buildTextProfile(code) {
	const text = code === null || code === undefined ? '' : String(code);

	return {
		type: 'Text',
		hash: await sha256Hex(text, true),
		text,
		hasData: false,
		dataName: null,
		size: text.length
	};
}

function basicAuthHeader(username, password) {
	const bytes = encoder.encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return 'Basic ' + btoa(binary);
}

function classifyStatus(status) {
	if (typeof status !== 'number') return 'network';
	if (status === 0) return 'redirected'; // 浏览器语义下的 opaqueredirect
	if (status >= 200 && status < 300) return 'ok';
	if (status >= 300 && status < 400) return 'redirected';
	if (status === 401 || status === 403) return 'unauthorized';
	if (status === 408 || status === 429) return 'retryable';
	if (status >= 500) return 'retryable';
	return 'client-error';
}

function defaultSleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带超时与有限重试的单次协议请求，整体受 deadline 硬约束。
 * 返回 { ok, status?, reason, attempts, elapsedMs }；从不读取响应体。
 * reason: ok | timeout | network | redirected | unauthorized | client-error | retryable
 */
async function requestWithRetry(options) {
	const {
		url,
		method,
		headers,
		body,
		timeoutMs,
		retries,
		fetchImpl,
		sleep,
		deadline
	} = options;

	const startedAt = Date.now();
	const budgetDeadline = deadline ?? (startedAt + MAX_TOTAL_BUDGET_MS);
	const attempts = clampInt(retries, 0, MAX_RETRY, DEFAULT_RETRY) + 1;
	let last = { ok: false, reason: 'timeout', attempts: 0 };

	for (let attempt = 0; attempt < attempts; attempt++) {

		if (attempt > 0) {
			const wait = Math.min(BACKOFF_BASE_MS * attempt, BACKOFF_MAX_MS);
			// 预算不足就不再等待，直接收敛为超时
			if (Date.now() + wait >= budgetDeadline) {
				break;
			}
			await sleep(wait);
		}

		const remaining = budgetDeadline - Date.now();
		if (remaining <= 0) {
			last = { ok: false, reason: 'timeout', attempts: attempt };
			break;
		}

		const attemptTimeout = Math.max(1, Math.min(timeoutMs, remaining));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), attemptTimeout);

		try {
			const res = await fetchImpl(url, {
				method,
				headers,
				body,
				signal: controller.signal,
				redirect: 'manual'
			});

			// 主动丢弃响应体：既不缓存目标端内容，也不把它带进日志
			try {
				await res.body?.cancel?.();
			} catch {
				// ignore
			}

			const kind = classifyStatus(res.status);

			if (kind === 'ok') {
				return { ok: true, status: res.status, attempts: attempt + 1, elapsedMs: Date.now() - startedAt };
			}

			last = { ok: false, status: res.status, reason: kind, attempts: attempt + 1 };

			if (kind !== 'retryable') {
				return { ...last, elapsedMs: Date.now() - startedAt };
			}
		} catch (e) {
			last = {
				ok: false,
				reason: e?.name === 'AbortError' ? 'timeout' : 'network',
				attempts: attempt + 1
			};
		} finally {
			clearTimeout(timer);
		}
	}

	return { ...last, elapsedMs: Date.now() - startedAt };
}

/** 同一封邮件（messageId 优先，缺失时用 emailId）+ 收件箱 作为去重键；键里不含验证码 */
async function buildDedupeKey(data) {
	const messageId = String(data.messageId ?? '').trim();
	const scope = messageId ? `mid:${messageId}` : `eid:${toInt(data.emailId, 0)}`;
	const raw = `${scope}\n${String(data.toEmail ?? '').trim().toLowerCase()}`;

	return KvConst.SYNC_CLIPBOARD_MSG + await sha256Hex(raw, false);
}

// 只记录固定原因与必要标识：不含验证码、密码、目标 URL、响应体、异常 message
function logSyncFailure(data, result) {
	console.error(
		`SyncClipboard 同步失败 emailId=${toInt(data.emailId, 0)} reason=${result.reason} status=${result.status ?? '-'} attempts=${result.attempts ?? '-'}`
	);
}

function logIgnored(context, e) {
	// 异常对象的 name 只有类型名（如 TypeError/AbortError），不含 URL/凭据/内容
	console.error(`SyncClipboard ${context}（已忽略）name=${e?.name || 'Error'}`);
}

const syncClipboardService = {

	PROFILE_PATH,
	VERSION_PATH,
	DEFAULT_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	DEFAULT_RETRY,
	MAX_RETRY,
	MAX_TOTAL_BUDGET_MS,

	validateTargetUrl,
	normalizeEmails,
	matchRecipient,
	resolveConfig,
	buildTextProfile,
	buildDedupeKey,
	classifyStatus,

	/**
	 * 收信后把验证码写入管理员配置的 SyncClipboardCfServer 当前剪贴板。
	 * 任何失败都只返回结果对象，不抛异常（调用方仍应 catch 兜底）。
	 */
	async syncReceivedEmail(c, data, deps = {}) {

		const fetchImpl = deps.fetchImpl || fetch;
		const sleep = deps.sleep || defaultSleep;
		const deadline = deps.deadline ?? (Date.now() + MAX_TOTAL_BUDGET_MS);

		try {
			const config = data.config || resolveConfig(data.settings);

			if (config.status !== settingConst.syncClipboardStatus.OPEN) {
				return { synced: false, reason: 'disabled' };
			}

			if (!matchRecipient(config, data.toEmail)) {
				return { synced: false, reason: 'filtered' };
			}

			const code = data.code === null || data.code === undefined ? '' : String(data.code);

			if (!code) {
				return { synced: false, reason: 'empty-code' };
			}

			const target = validateTargetUrl(config.url);

			if (!target.ok) {
				logSyncFailure(data, { reason: target.reason, attempts: 0 });
				return { synced: false, reason: target.reason };
			}

			const kv = c?.env?.kv;
			const dedupeKey = await buildDedupeKey(data);

			// KV 最终一致：这里的命中判断是 best effort，不构成严格去重保证
			if (kv) {
				try {
					const cached = await kv.get(dedupeKey);
					if (cached) {
						return { synced: false, reason: 'deduped' };
					}
				} catch (e) {
					logIgnored('去重标记读取失败，继续同步', e);
				}
			}

			const profile = await buildTextProfile(code);
			const result = await requestWithRetry({
				url: target.origin + PROFILE_PATH,
				method: 'PUT',
				headers: {
					'content-type': 'application/json',
					authorization: basicAuthHeader(config.username, config.password)
				},
				body: JSON.stringify(profile),
				timeoutMs: config.timeout,
				retries: config.retry,
				fetchImpl,
				sleep,
				deadline
			});

			if (!result.ok) {
				logSyncFailure(data, result);
				return { synced: false, reason: result.reason, status: result.status };
			}

			// 仅在写入成功后打标记；KV 非原子，重复投递极少数情况下仍可能双写
			if (kv) {
				try {
					await kv.put(dedupeKey, String(toInt(data.emailId, 0)), { expirationTtl: DEDUPE_TTL_SECONDS });
				} catch (e) {
					logIgnored('去重标记写入失败', e);
				}
			}

			return { synced: true, reason: 'ok', status: result.status };

		} catch (e) {
			logIgnored('同步异常', e);
			return { synced: false, reason: 'error' };
		}
	},

	/**
	 * 只读连通性测试：GET /api/version（无则回退 GET /SyncClipboard.json），绝不写剪贴板。
	 * 两次请求共享同一 25s 预算，返回值只含状态码与布尔结果，不含目标响应体。
	 */
	async testConnection(c, config, deps = {}) {

		const fetchImpl = deps.fetchImpl || fetch;
		const sleep = deps.sleep || defaultSleep;
		const deadline = deps.deadline ?? (Date.now() + MAX_TOTAL_BUDGET_MS);

		const target = validateTargetUrl(config?.url);

		if (!target.ok) {
			return { ok: false, reason: target.reason };
		}

		const headers = {
			accept: 'application/json',
			authorization: basicAuthHeader(config.username ?? '', config.password ?? '')
		};

		const timeoutMs = clampInt(config?.timeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

		const first = await requestWithRetry({
			url: target.origin + VERSION_PATH,
			method: 'GET',
			headers,
			timeoutMs,
			retries: 0,
			fetchImpl,
			sleep,
			deadline
		});

		if (first.ok) {
			return { ok: true, status: first.status, path: VERSION_PATH };
		}

		// 老实例可能没有 /api/version；回退到只读的 GET /SyncClipboard.json
		if (first.status === 404 || first.status === 405) {
			const second = await requestWithRetry({
				url: target.origin + PROFILE_PATH,
				method: 'GET',
				headers,
				timeoutMs,
				retries: 0,
				fetchImpl,
				sleep,
				deadline
			});

			return second.ok
				? { ok: true, status: second.status, path: PROFILE_PATH }
				: { ok: false, reason: second.reason, status: second.status };
		}

		return { ok: false, reason: first.reason, status: first.status };
	}
};

export default syncClipboardService;
