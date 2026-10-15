import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import {verifyRecordType, settingConst} from '../const/entity-const';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import {t} from '../i18n/i18n'
import verifyRecordService from './verify-record-service';
import userContext from '../security/user-context';
import domainUtils from '../utils/domain-uitls';
import syncClipboardService from './sync-clipboard-service';

//SyncClipboard 字段只能走 /setting/setSyncClipboard（含 URL 校验与 write-only 密码语义）
const SYNC_CLIPBOARD_FIELDS = [
	'syncClipboardStatus',
	'syncClipboardUrl',
	'syncClipboardUsername',
	'syncClipboardPassword',
	'syncClipboardMode',
	'syncClipboardEmails',
	'syncClipboardRetry',
	'syncClipboardTimeout'
];

const SYNC_CLIPBOARD_REASON_KEY = {
	'url-empty': 'syncClipboardUrlEmpty',
	'url-invalid': 'syncClipboardUrlInvalid',
	'url-not-https': 'syncClipboardUrlNotHttps',
	'url-has-credentials': 'syncClipboardUrlHasCredentials',
	'url-has-path': 'syncClipboardUrlHasPath',
	'url-ip-not-supported': 'syncClipboardUrlIpNotSupported',
	'url-local-not-supported': 'syncClipboardUrlLocalNotSupported'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

//严格枚举：只接受 0/1（数字或纯数字字符串），其余一律报错，不做隐式回退
function strictEnum(value, allowed) {
	if (typeof value === 'number' && Number.isInteger(value) && allowed.includes(value)) {
		return value;
	}

	if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
		const num = Number(value.trim());
		if (allowed.includes(num)) return num;
	}

	return null;
}

const settingService = {

	async refresh(c) {
		const settingRow = await orm(c).select().from(setting).get();
		settingRow.resendTokens = JSON.parse(settingRow.resendTokens);
		c.set('setting', settingRow);
		await c.env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	},

	async query(c) {

		if (c.get?.('setting')) {
			return c.get('setting')
		}

		const setting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });

		if (!setting) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}

		let domainList = c.env.domain;

		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList)
			} catch (error) {
				throw new BizError(t('notJsonDomain'));
			}
		}

		if (!c.env.domain) {
			throw new BizError(t('noDomainVariable'));
		}

		domainList = domainList.map(item => '@' + item);
		setting.domainList = domainList;

		let projectLink = c.env.project_link;
		if (typeof projectLink === 'string' && projectLink === 'false') {
			projectLink = false
		} else if (projectLink === false) {
			projectLink = false
		} else {
			projectLink = true
		}

		setting.projectLink = projectLink;

		setting.emailPrefixFilter = setting.emailPrefixFilter.split(",").filter(Boolean);

		c.set?.('setting', setting);
		return setting;
	},

	async get(c, showSiteKey = false) {

		const queried = await this.query(c);
		// 返回副本：掩码不得写回 c.get('setting') / KV 解析出的凭据对象
		const settingRow = { ...queried, resendTokens: { ...queried.resendTokens } };

		//SyncClipboard 密码只写不读：对外只回传“是否已设置”
		settingRow.hasSyncClipboardPassword = !!queried.syncClipboardPassword;
		delete settingRow.syncClipboardPassword;


		const recordList = await verifyRecordService.selectListByIP(c);

		if (!showSiteKey) {
			settingRow.siteKey = settingRow.siteKey ? `${settingRow.siteKey.slice(0, 6)}******` : null;
		}

		settingRow.secretKey = settingRow.secretKey ? `${settingRow.secretKey.slice(0, 6)}******` : null;

		Object.keys(settingRow.resendTokens).forEach(key => {
			settingRow.resendTokens[key] = `${settingRow.resendTokens[key].slice(0, 12)}******`;
		});

		settingRow.s3AccessKey = settingRow.s3AccessKey ? `${settingRow.s3AccessKey.slice(0, 12)}******` : null;
		settingRow.s3SecretKey = settingRow.s3SecretKey ? `${settingRow.s3SecretKey.slice(0, 12)}******` : null;
		settingRow.tgBotToken = settingRow.tgBotToken ? `${settingRow.tgBotToken.slice(0, 20)}******` : null;
		settingRow.hasR2 = !!c.env.r2
		settingRow.hasCfEmail = !!c.env.email

		let regVerifyOpen = false
		let addVerifyOpen = false

		recordList.forEach(row => {
			if (row.type === verifyRecordType.REG) {
				regVerifyOpen = row.count >= settingRow.regVerifyCount
			}
			if (row.type === verifyRecordType.ADD) {
				addVerifyOpen = row.count >= settingRow.addVerifyCount
			}
		})

		settingRow.regVerifyOpen = regVerifyOpen
		settingRow.addVerifyOpen = addVerifyOpen

		settingRow.storageType = await r2Service.storageType(c);

		return settingRow;
	},

	async set(c, params) {
		SYNC_CLIPBOARD_FIELDS.forEach(field => delete params[field]);

		const settingData = await this.query(c);
		let resendTokens = { ...settingData.resendTokens, ...params.resendTokens };
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain]) delete resendTokens[domain];
		});

		if (Array.isArray(params.emailPrefixFilter)) {
			params.emailPrefixFilter = params.emailPrefixFilter + '';
		}

		if (Array.isArray(params.aiCodeFilter)) {
			params.aiCodeFilter = params.aiCodeFilter + '';
		}

		if (params.webhookUrl !== undefined) {
			params.webhookUrl = domainUtils.toOssDomain(params.webhookUrl) || '';
		}

		params.resendTokens = JSON.stringify(resendTokens);

		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	async deleteBackground(c) {

		const { background } = await this.query(c);
		if (!background) return

		if (background.startsWith('http')) {
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
			return;
		}

		if (background) {
			await r2Service.delete(c,background)
			await orm(c).update(setting).set({ background: '' }).run();
			await this.refresh(c)
		}
	},

	async setBackground(c, params) {

		let { background } = params

		await this.deleteBackground(c);

		if (background && !background.startsWith('http')) {

			const file = fileUtils.base64ToFile(background)

			const arrayBuffer = await file.arrayBuffer();
			background = constant.BACKGROUND_PREFIX + await fileUtils.getBuffHash(arrayBuffer) + fileUtils.getExtFileName(file.name);


			await r2Service.putObj(c, background, arrayBuffer, {
				contentType: file.type,
				cacheControl: `public, max-age=31536000, immutable`,
				contentDisposition: `inline; filename="${file.name}"`
			});

		}

		await orm(c).update(setting).set({ background }).run();
		await this.refresh(c);
		return background;
	},


	async setBlacklist(c, params) {
		const { blackSubject, blackContent, blackFrom  } = params
		await orm(c).update(setting).set({ blackSubject, blackContent, blackFrom }).run();
		await this.refresh(c);
		return this.get(c);
	},

	//SyncClipboard 只读配置：不包含密码（只回传 hasPassword）
	async getSyncClipboard(c) {
		const config = syncClipboardService.resolveConfig(await this.query(c));

		return {
			status: config.status,
			url: config.url,
			username: config.username,
			hasPassword: !!config.password,
			mode: config.mode,
			emails: config.emails,
			retry: config.retry,
			timeout: config.timeout
		};
	},

	async setSyncClipboard(c, params) {

		const form = params || {};
		const update = {};

		if (form.status !== undefined) {
			const status = strictEnum(form.status, [settingConst.syncClipboardStatus.OPEN, settingConst.syncClipboardStatus.CLOSE]);

			if (status === null) {
				throw new BizError(t('syncClipboardStatusInvalid'));
			}

			update.syncClipboardStatus = status;
		}

		if (form.mode !== undefined) {
			//mode 非法值绝不能隐式转成 ALL，否则会把同步范围静默扩大到全站
			const mode = strictEnum(form.mode, [settingConst.syncClipboardMode.ALL, settingConst.syncClipboardMode.SELECTED]);

			if (mode === null) {
				throw new BizError(t('syncClipboardModeInvalid'));
			}

			update.syncClipboardMode = mode;
		}

		if (form.url !== undefined) {
			update.syncClipboardUrl = String(form.url ?? '').trim();
		}

		if (form.username !== undefined) {
			const username = String(form.username ?? '').trim();

			//Basic 凭据以首个冒号分隔，且 CR/LF 会导致请求头注入
			if (username.includes(':') || /[\r\n]/.test(username)) {
				throw new BizError(t('syncClipboardUsernameInvalid'));
			}

			update.syncClipboardUsername = username;
		}

		if (form.emails !== undefined) {
			const raw = Array.isArray(form.emails) ? form.emails.join(',') : form.emails;
			const emails = syncClipboardService.normalizeEmails(raw);

			if (emails.some(item => !EMAIL_RE.test(item))) {
				throw new BizError(t('syncClipboardEmailInvalid'));
			}

			update.syncClipboardEmails = emails.join(',');
		}

		if (form.retry !== undefined) {
			const retry = Number(form.retry);

			//非数字一律报错；越界数值钳制到安全范围（接口会回传实际存储值）
			if (!Number.isFinite(retry)) {
				throw new BizError(t('syncClipboardRetryInvalid'));
			}

			update.syncClipboardRetry = Math.min(Math.max(Math.trunc(retry), 0), syncClipboardService.MAX_RETRY);
		}

		if (form.timeout !== undefined) {
			const timeout = Number(form.timeout);

			if (!Number.isFinite(timeout)) {
				throw new BizError(t('syncClipboardTimeoutInvalid'));
			}

			update.syncClipboardTimeout = Math.min(Math.max(Math.trunc(timeout), syncClipboardService.MIN_TIMEOUT_MS), syncClipboardService.MAX_TIMEOUT_MS);
		}

		//write-only 密码：非空字符串=设置新值；password:null 或 clearPassword:true=清除；缺省/空串=保留旧值
		//密码允许包含冒号（协议取首个冒号之后的全部），但不允许 CR/LF
		if (typeof form.password === 'string' && form.password !== '') {
			if (/[\r\n]/.test(form.password)) {
				throw new BizError(t('syncClipboardPasswordInvalid'));
			}
			update.syncClipboardPassword = form.password;
		} else if (form.clearPassword === true || form.password === null) {
			update.syncClipboardPassword = '';
		}

		// 校验合并后的最终状态：开启必须有合法 https 地址与完整凭据；指定模式必须有收件邮箱
		const merged = syncClipboardService.resolveConfig({ ...await this.query(c), ...update });

		if (merged.url) {
			const target = syncClipboardService.validateTargetUrl(merged.url);
			if (!target.ok) {
				throw new BizError(t(SYNC_CLIPBOARD_REASON_KEY[target.reason] || 'syncClipboardUrlInvalid'));
			}
		}

		if (merged.status === settingConst.syncClipboardStatus.OPEN) {

			if (!merged.url) {
				throw new BizError(t('syncClipboardUrlEmpty'));
			}

			if (update.syncClipboardPassword === '') {
				// 不允许“清密码但仍开启”的静默失效配置
				throw new BizError(t('syncClipboardPasswordClearWhileOpen'));
			}

			if (!merged.username) {
				throw new BizError(t('syncClipboardUsernameEmpty'));
			}

			if (!merged.password) {
				throw new BizError(t('syncClipboardPasswordEmpty'));
			}

			if (merged.mode === settingConst.syncClipboardMode.SELECTED
				&& syncClipboardService.normalizeEmails(merged.emails).length === 0) {
				throw new BizError(t('syncClipboardEmailEmpty'));
			}
		}

		if (Object.keys(update).length === 0) {
			return this.getSyncClipboard(c);
		}

		await orm(c).update(setting).set(update).run();
		await this.refresh(c);

		return this.getSyncClipboard(c);
	},

	//只读连通性测试：绝不写入剪贴板
	async testSyncClipboard(c, params) {

		const form = params || {};
		const saved = syncClipboardService.resolveConfig(await this.query(c));

		const url = form.url !== undefined && String(form.url ?? '').trim() !== ''
			? String(form.url).trim()
			: saved.url;

		const username = form.username !== undefined ? String(form.username ?? '').trim() : saved.username;

		const password = typeof form.password === 'string' && form.password !== ''
			? form.password
			: saved.password;

		const result = await syncClipboardService.testConnection(c, {
			url,
			username,
			password,
			timeout: saved.timeout
		});

		return {
			ok: !!result.ok,
			status: result.status ?? null,
			path: result.path || null,
			reason: result.reason || null,
			message: result.ok ? t('syncClipboardTestOk') : this.syncClipboardReasonMessage(result.reason)
		};
	},

	syncClipboardReasonMessage(reason) {

		if (SYNC_CLIPBOARD_REASON_KEY[reason]) {
			return t(SYNC_CLIPBOARD_REASON_KEY[reason]);
		}

		switch (reason) {
			case 'unauthorized':
				return t('syncClipboardUnauthorized');
			case 'timeout':
				return t('syncClipboardTimeout');
			case 'redirected':
				return t('syncClipboardRedirected');
			case 'retryable':
			case 'client-error':
				return t('syncClipboardServerError');
			default:
				return t('syncClipboardNetworkError');
		}
	},

	async websiteConfig(c) {

		const settingRow = await this.get(c, true);
		const token = await userContext.getToken(c);

		return {
			register: settingRow.register,
			title: settingRow.title,
			manyEmail: settingRow.manyEmail,
			addEmail: settingRow.addEmail,
			autoRefresh: settingRow.autoRefresh,
			addEmailVerify: settingRow.addEmailVerify,
			registerVerify: settingRow.registerVerify,
			send: settingRow.send,
			r2Domain: settingRow.r2Domain,
			siteKey: settingRow.siteKey,
			background: settingRow.background,
			loginOpacity: settingRow.loginOpacity,
			domainList: settingRow.loginDomain === 1 && !token ? [] : settingRow.domainList,
			regKey: settingRow.regKey,
			regVerifyOpen: settingRow.regVerifyOpen,
			addVerifyOpen: settingRow.addVerifyOpen,
			noticeTitle: settingRow.noticeTitle,
			noticeContent: settingRow.noticeContent,
			noticeType: settingRow.noticeType,
			noticeDuration: settingRow.noticeDuration,
			noticePosition: settingRow.noticePosition,
			noticeWidth: settingRow.noticeWidth,
			noticeOffset: settingRow.noticeOffset,
			notice: settingRow.notice,
			loginDomain: settingRow.loginDomain,
			linuxdoClientId: settingRow.linuxdoClientId,
			linuxdoSwitch: settingRow.linuxdoSwitch,
			githubClientId: settingRow.githubClientId,
			githubSwitch: settingRow.githubSwitch,
			googleClientId: settingRow.googleClientId,
			googleSwitch: settingRow.googleSwitch,
			minEmailPrefix: settingRow.minEmailPrefix,
			projectLink: settingRow.projectLink
		};
	},

};

export default settingService;
