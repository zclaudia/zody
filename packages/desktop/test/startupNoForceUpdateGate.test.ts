import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Fork spec「强制升级 gate（删除）」（specs/fork-official-backend-runtime-dependencies.md，
 * 决策 D1）验收 1 的源码级回归：打包 production 构建启动时，Main 在创建主窗口前
 * 不得发起任何网络请求（原 gate 是唯一在主窗口创建前同步等待网络的步骤），
 * 且源码中不再存在 forceUpdateGuard、forceUpdatePrompt、
 * forceUpdateMainWindowCreationBlocked、requestForceAutoUpdate。
 *
 * 单测无法真实执行打包版 app.ready 流程，这里按 hostMediaPreviewLogging.test.ts 的
 * 先例对启动源码做文本断言：gate 文件已删除，app.ready 处理器从入口到
 * ensurePrimaryWindow("app-ready") 之间不含任何网络调用；打包版运行时验证
 * （验收 1 的「打包版」部分）另行在打包产物上执行。
 */

function readMainSource(relativePath: string): string {
  return readFileSync(new URL(`../src/main/${relativePath}`, import.meta.url), "utf8");
}

function readSourceFromRepoRoot(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

function extractStartupSegment(indexSource: string): string {
  const startMarker = "app.whenReady().then";
  const endMarker = 'ensurePrimaryWindow("app-ready")';
  const startIndex = indexSource.indexOf(startMarker);
  const endIndex = indexSource.indexOf(endMarker);
  expect(startIndex, "index.ts 应保留 app.whenReady 启动入口").toBeGreaterThan(-1);
  expect(endIndex, "index.ts 应在 app ready 后创建主窗口").toBeGreaterThan(startIndex);
  return indexSource.slice(startIndex, endIndex);
}

describe("startup has no force-update gate", () => {
  it("gate 实现文件已删除", () => {
    expect(existsSync(new URL("../src/main/forceUpdateGuard.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/main/forceUpdatePrompt.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../../packages/shared/src/forceUpdate.ts", import.meta.url))).toBe(
      false,
    );
  });

  it("app ready 到创建主窗口之间没有网络调用（打包 production 亦不再有启动前强更请求）", () => {
    const indexSource = readMainSource("index.ts");
    const startupSegment = extractStartupSegment(indexSource);

    // 原 gate 通过 net.request 在主窗口创建前同步请求 /api/v1/client/configs；
    // 删除后启动段不允许再出现 net.request 调用或 gate 入口（调用点以 `net.request(` 匹配，
    // 避免误伤其他注释文字；启动段内的灰度预热 refresh 属 F2.6a 处理，不在本断言范围）。
    expect(startupSegment).not.toContain("net.request(");
    expect(startupSegment).not.toContain("maybeBlockStartupForForceUpdate");
    expect(startupSegment).not.toContain("forceUpdate");
  });

  it("index.ts 不再包含强更 gate 的任何符号与窗口创建拦截", () => {
    const indexSource = readMainSource("index.ts");

    expect(indexSource).not.toContain("forceUpdateGuard");
    expect(indexSource).not.toContain("forceUpdatePrompt");
    expect(indexSource).not.toContain("maybeBlockStartupForForceUpdate");
    expect(indexSource).not.toContain("forceUpdateMainWindowCreationBlocked");
    expect(indexSource).not.toContain("focusForceUpdateGateWindow");
    expect(indexSource).not.toContain("forceUpdateBlocked");
    // gate 删除后 coordinator 不再需要 canCreateWindow 拦截装配。
    expect(indexSource).not.toContain("canCreateWindow");
  });

  it("二次启动 deep link 路由不再有强更拦截分支", () => {
    const source = readMainSource("desktopSecondInstanceDeepLink.ts");

    expect(source).not.toContain("forceUpdateBlocked");
    expect(source).not.toContain("focusForceUpdateGateWindow");
    expect(source).not.toContain("canOpenWorkspace: () =>");
  });

  it("autoUpdater 不再包含强更自动升级入口及其状态监听", () => {
    const source = readMainSource("autoUpdater.ts");

    expect(source).not.toContain("requestForceAutoUpdate");
    expect(source).not.toContain("ForceAutoUpdateState");
    expect(source).not.toContain("activeForceAutoUpdateListener");
    expect(source).not.toContain("notifyForceAutoUpdate");
  });

  it("shared 不再导出强更解析与配置读取", () => {
    const sharedIndex = readSourceFromRepoRoot("packages/shared/src/index.ts");
    expect(sharedIndex).not.toContain("forceUpdate.js");

    const remoteAppConfig = readSourceFromRepoRoot("packages/shared/src/remoteAppConfig.ts");
    expect(remoteAppConfig).not.toContain("getForceUpdateMinimalVersionFromConfig");

    const codingPlanSubscription = readSourceFromRepoRoot(
      "packages/shared/src/coding-plan-subscription.ts",
    );
    expect(codingPlanSubscription).not.toContain("ForceUpdateConfig");
  });
});
