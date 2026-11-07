import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  USER_INSTRUCTIONS_MAX_BYTES,
  USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE,
} from "../src/index.js";

/**
 * PZ07（docs/ui/settings-personalization.md）：保存侧上限与 CLI adapter 读取截断必须同口径。
 * CLI 侧截断语义由 apps/zody-cli/packages/adapters/tests/fs-context.test.ts 持有，
 * 本域只验「两侧上限同值」：shared 常量与 adapter 的 DEFAULT_MAX_BYTES 都是 100 * 1024。
 * adapter 常量未导出且不能反向依赖 CLI 包，这里按 ui/desktop 既有源码扫描契约测试的
 * 先例（如 packages/ui/test/appQuickPickCommandStability.test.ts）直接读源码文本防漂移：
 * 任一侧单独改上限都会让本测试失败，强制两侧同步（spec「两侧改动必须同步」）。
 */
describe("user instructions limits", () => {
  it("USER_INSTRUCTIONS_MAX_BYTES 为 100KB，与 CLI adapter DEFAULT_MAX_BYTES 同值", () => {
    expect(USER_INSTRUCTIONS_MAX_BYTES).toBe(100 * 1024);

    const adapterSource = readFileSync(
      new URL("../../../apps/zody-cli/packages/adapters/src/context/index.ts", import.meta.url),
      "utf8",
    );
    // adapter 的 DEFAULT_MAX_BYTES 是未导出字面量；只允许与 shared 常量等价的 100 * 1024 写法。
    expect(adapterSource).toMatch(/const DEFAULT_MAX_BYTES = 100 \* 1024;/);
  });

  it("saveUserInstructions 超限错误码稳定为 user_instructions_too_large", () => {
    expect(USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE).toBe("user_instructions_too_large");
  });
});
