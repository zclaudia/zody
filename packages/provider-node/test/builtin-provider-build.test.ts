import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("构建配置契约：builtin-provider-config-build", { timeout: 30_000 }, async () => {
  // 构建工具直接运行于 Node；不让 Vitest 的模块转换掩盖打包入口的导入／文件路径问题。
  const result = await promisify(execFile)(
    process.execPath,
    ["--test", "scripts/test/builtin-provider-config-build.test.mjs"],
    { cwd: resolve(import.meta.dirname, "../../.."), timeout: 25_000 },
  );
  expect(result.stdout).toContain("fail 0");
});
// 上游 v3.17.1（a60ba6a7）内置配置 rev33 → rev43 全量对齐（本仓 a265fba2）后配置体积显著增大，
// 子进程构建+测试实测约 7.2s（其中 tsup 真实打包约 4.9s），超过 Vitest 默认 5s 用例超时；
// 外层用例超时取 30s，保持大于 execFile 内层 25s 预算，使真实挂起仍由 execFile 的 ETIMEDOUT 先行报告。
