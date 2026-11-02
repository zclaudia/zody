import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 限制单包 worker；全量 CLI 门禁同时运行多个包，避免资源争用触发计算用例的超时。
    maxWorkers: 2,
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    // 修复原因：mcp-ui 的 instances/callRaces 等模块回归与源码同目录；包内 `vitest tests` 只匹配 tests/，
    // 这些用例此前从未进入门禁。补 src/**/*.test.ts 让模块自带回归在包 cwd 下实际执行。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
  },
});
