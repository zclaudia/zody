import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HELPER_GHOST_CURSOR_OVERLAY_ARG } from "../broker-helper-constants.js";
import { HELPER_GHOST_CURSOR_OVERLAY_ARG as brokerReExport } from "../broker.js";

// F12（上游 v3.17.1，a60ba6a7）：broker→helper 链路必须在 fork argv 末位携带
// --ghost-cursor-overlay；漏传时 helper 侧 OverlayEnabled() 恒 false、agent 光标
// 完全不渲染。常量由 producer 包单源定义，broker 入口 re-export，js/d.ts 需同步。
const packageRoot = dirname(fileURLToPath(import.meta.url));

describe("broker-helper-constants ghost cursor overlay argv", () => {
  it("exposes the helper overlay arg used by the product chain", () => {
    expect(HELPER_GHOST_CURSOR_OVERLAY_ARG).toBe("--ghost-cursor-overlay");
  });

  it("re-exports the overlay arg from the broker entry", () => {
    // 公共 Host 通过 @zody/zcode-cua/broker 入口复用参数契约，防本地字面量漂移；
    // 直接断言字面量，避免常量与 re-export 同时缺失时 undefined===undefined 假通过。
    expect(brokerReExport).toBe("--ghost-cursor-overlay");
    expect(brokerReExport).toBe(HELPER_GHOST_CURSOR_OVERLAY_ARG);
  });

  it("keeps broker-helper-constants.d.ts in sync with the runtime constant", () => {
    const dts = readFileSync(join(packageRoot, "..", "broker-helper-constants.d.ts"), "utf8");
    expect(dts).toContain("export declare const HELPER_GHOST_CURSOR_OVERLAY_ARG: string;");
  });

  it("keeps broker.d.ts re-export in sync with broker.js", () => {
    const dts = readFileSync(join(packageRoot, "..", "broker.d.ts"), "utf8");
    expect(dts).toContain(
      'export { HELPER_GHOST_CURSOR_OVERLAY_ARG } from "./broker-helper-constants.js";',
    );
  });
});
