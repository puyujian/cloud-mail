import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import translationRepository from './repository/translation-repository';
export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		if (url.pathname.startsWith('/oss/')) {
			const key = url.pathname.slice('/oss/'.length);
			const resp = await r2Service.toObjResp({ env }, key);
			return resp || new Response('Not Found', { status: 404 });
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 const resp = await r2Service.toObjResp({ env }, url.pathname.substring(1));
			 return resp || new Response('Not Found', { status: 404 });
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		// 各项维护互不依赖：任何一项抛错都不能连累后面的清理（尤其翻译任务过期清理）
		const tasks = [
			['清理验证码记录', () => verifyRecordService.clearRecord({ env })],
			['重置每日发送数', () => userService.resetDaySendCount({ env })],
			['补全收件', () => emailService.completeReceiveAll({ env })],
			['自动清理邮件', () => emailService.autoClean({ env })],
			['刷新统计缓存', () => analysisService.refreshEchartsCache({ env })],
			['清理未绑定OAuth用户', () => oauthService.clearNoBindOathUser({ env })],
			['清理过期翻译任务', () => translationRepository.cleanExpired({ env }, Date.now())]
		]
		const settled = await Promise.allSettled(tasks.map(([, run]) => run()))
		settled.forEach((item, index) => {
			if (item.status === 'rejected') {
				console.warn(`${tasks[index][0]}失败：${item.reason?.message}`)
			}
		})
	},
};
