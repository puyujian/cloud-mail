import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// 本地单测配置：
// - 绑定全部来自 wrangler-test-local.toml（miniflare 本地模拟 D1/KV），不会写远端
// - 不进远端：不要在此加 remote/experimental 开关
export default defineWorkersConfig({
	test: {
		include: ['test/**/*.spec.js'],
		// 共享同一份本地存储，便于「迁移 → 断言」类测试；各用例自造数据、键名互不冲突
		poolOptions: {
			workers: {
				singleWorker: true,
				isolatedStorage: false,
				wrangler: { configPath: './wrangler-test-local.toml' },
				miniflare: {
					compatibilityDate: '2025-06-04',
					compatibilityFlags: ['nodejs_compat']
				}
			}
		}
	}
});
