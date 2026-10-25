import i18next from 'i18next';
import zh from './zh.js'
import en from './en.js'
import app from '../hono/hono';

app.use('*', async (c, next) => {
	const lang = c.req.header('accept-language')?.split('-')[0]
	i18next.init({
		lng: lang,
	});
	return await next()
})

const resources = {
	en: {
		translation: en
	},
	zh: {
		translation: zh,
	},
};

i18next.init({
	fallbackLng: 'zh',
	resources,
});

export const t = (key, values) => i18next.t(key, values)

// 请求级翻译器：长耗时异步流程中全局 lng 可能被其他请求改写，
// 因此在入口处就把语言固定下来，避免跨请求串语言。
export const getT = (c) => {
	const lang = c?.req?.header?.('accept-language')?.split('-')[0];
	return i18next.getFixedT(lang === 'en' ? 'en' : 'zh');
}

export default i18next;
