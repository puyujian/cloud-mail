import { defineConfig } from 'vitest/config';

// 纯 Node 环境的单元测试配置：不依赖 wrangler 配置与 Workers 运行时
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.mjs']
	}
});
