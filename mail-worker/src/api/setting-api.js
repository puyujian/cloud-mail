import app from '../hono/hono';
import result from '../model/result';
import settingService from '../service/setting-service';
import userContext from "../security/user-context";

app.put('/setting/set', async (c) => {
	await settingService.set(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/setting/query', async (c) => {
	const setting = await settingService.get(c);
	return c.json(result.ok(setting));
});

app.get('/setting/websiteConfig', async (c) => {
	const setting = await settingService.websiteConfig(c);
	return c.json(result.ok(setting));
})

app.put('/setting/setBackground', async (c) => {
	const key = await settingService.setBackground(c, await c.req.json());
	return c.json(result.ok(key));
});

app.delete('/setting/deleteBackground', async (c) => {
	await settingService.deleteBackground(c);
	return c.json(result.ok());
});

app.put('/setting/setBlacklist', async (c) => {
	const setting = await settingService.setBlacklist(c, await c.req.json());
	return c.json(result.ok(setting));
})

app.get('/setting/querySyncClipboard', async (c) => {
	const data = await settingService.getSyncClipboard(c);
	return c.json(result.ok(data));
});

app.put('/setting/setSyncClipboard', async (c) => {
	const data = await settingService.setSyncClipboard(c, await c.req.json());
	return c.json(result.ok(data));
});

app.put('/setting/testSyncClipboard', async (c) => {
	const data = await settingService.testSyncClipboard(c, await c.req.json());
	return c.json(result.ok(data));
});

