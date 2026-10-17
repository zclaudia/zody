import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Fork spec「灰度开关的本地默认值（D1b）」（specs/fork-official-backend-runtime-dependencies.md）
 * 与任务 F2.6a 的 Main 侧验收（同文件验收 5 的 Main 部分）：
 * - 桌面上下文提示固定开启，经 Host env `ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=1` 下发；
 * - 渲染端动作追踪固定使用 `DISABLED_RENDERER_ACTION_TRACE_CONFIG`；
 * - Main 不再构造请求 `/api/v1/client/configs` 的 `fetchConfig`，也不再保留首个 Host
 *   spawn 前的灰度裁决门与 rollout 预热。
 *
 * Main 入口（index.ts）无法在单测中真实启动，沿用 startupNoForceUpdateGate.test.ts 的
 * 源码文本断言先例：这里断言装配已断开。行为断言分工——Host env 注入见
 * desktopHostProcess.test.ts，追踪禁用经 IPC 暴露给渲染端的取值见
 * rendererActionTraceIpc.test.ts。desktopContextPromptRollout.ts、
 * rendererActionTraceRollout.ts、singleFeatureRollout.ts 三个实现文件按任务要求保留
 * （同步友好），只断开装配。
 */

function readMainSource(relativePath: string): string {
  return readFileSync(new URL(`../src/main/${relativePath}`, import.meta.url), "utf8");
}

describe("Main 侧灰度本地固定值（F2.6a / D1b）", () => {
  it("灰度实现文件保留（同步友好），不做删除", () => {
    expect(
      existsSync(new URL("../src/main/desktopContextPromptRollout.ts", import.meta.url)),
    ).toBe(true);
    expect(
      existsSync(new URL("../src/main/rendererActionTraceRollout.ts", import.meta.url)),
    ).toBe(true);
    expect(existsSync(new URL("../src/main/singleFeatureRollout.ts", import.meta.url))).toBe(true);
  });

  it("index.ts 不再构造 /client/configs fetcher 与两个灰度 rollout", () => {
    const source = readMainSource("index.ts");

    expect(source).not.toContain("createDesktopContextPromptRollout");
    expect(source).not.toContain("createElectronDesktopContextPromptConfigFetcher");
    expect(source).not.toContain("createRendererActionTraceRollout");
    expect(source).not.toContain("electronClientConfigsFetcher");
    expect(source).not.toContain('from "./desktopContextPromptRollout.js"');
    // 原装配中 fetchConfig 只以工厂入参属性 `fetchConfig:` 出现；按代码形态匹配，
    // 避免误伤说明性注释里的文字（同 startupNoForceUpdateGate.test.ts 的先例）。
    expect(source).not.toContain("fetchConfig:");
  });

  it("index.ts 不再有首个 Host spawn 前的灰度裁决门与 rollout 预热", () => {
    const source = readMainSource("index.ts");

    expect(source).not.toContain("desktopContextPromptRollout");
    expect(source).not.toContain("resolveDesktopContextPromptEnabledForHost");
    expect(source).not.toContain("awaitFirstHostSpawnDecision");
    expect(source).not.toContain("firstHostSpawnDecisionPromise");
    // 说明：恒定 rollout 仍保留接口形状中的 awaitFirstDecision 方法（类型要求），
    // 但装配后没有任何调用方；此处只断言裁决门装配符号消失。
  });

  it("渲染端动作追踪在 Main 装配中固定为 DISABLED_RENDERER_ACTION_TRACE_CONFIG", () => {
    const source = readMainSource("index.ts");

    expect(source).toContain("DISABLED_RENDERER_ACTION_TRACE_CONFIG");
    expect(source).not.toContain("createRendererActionTraceRollout");
  });

  it("desktopHostProcess 不再有可覆盖的 desktopContextPromptEnabled 灰度依赖", () => {
    const source = readMainSource("desktopHostProcess.ts");

    expect(source).not.toContain("desktopContextPromptEnabled?: () => boolean");
    expect(source).not.toContain("dependencies.desktopContextPromptEnabled");
  });

  it("desktopHostProcess 恒向 Host env 下发 ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=1", () => {
    const source = readMainSource("desktopHostProcess.ts");

    expect(source).toContain('[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: "1"');
  });
});
