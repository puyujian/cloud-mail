import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', cors());

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定<br/>D1 database not bound',502));
	}

	if (err.message?.includes('D1_ERROR: no such column')) {
		return c.json(result.fail('请按照文档更新数据库<br/>Please update the database as documented', 502));
	}

	// 翻译表由 /api/init 建立，部署动作不会建表；自愈失败时给出可执行的提示
	if (err.message?.includes('no such table: email_translation')
		|| err.message?.includes('no such table: translation_')) {
		return c.json(result.fail('翻译数据表缺失，请先访问 /api/init/{JWT_SECRET} 初始化数据库<br/>Translation tables missing, run /api/init/{JWT_SECRET} first', 502));
	}

	return c.json(result.fail(err.message, err.code, err.errorKey));
});

export default app;


