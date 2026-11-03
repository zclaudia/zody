import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Remote 只读会话边界（M2-T2）。
 *
 * bootstrap 没有可注入的完整 session 级测试缝；这里锁定源码不变量，配套的
 * `mobileRemoteSessionContext.test.ts` / `mobileRemoteReleaseCheck.test.ts` 验证实际行为：
 * - Remote 只从 `ZodyRemoteBridge.getSessionContext()` 读取；
 * - 不存在 SecureStore / URL / localStorage 配置读写或 clientInstanceId 生成路径；
 * - 修改连接、切换电脑和失败出口统一走 `returnShell`；
 * - release manifest 校验发生在创建业务 transport 之前。
 */

const source = readFileSync(
  resolve(process.cwd(), "packages/web/src/mobile-remote/bootstrap.tsx"),
  "utf8",
);

describe("Remote 只读 session context（M2-T2）", () => {
  it("从 getSessionContext 读取会话并交给现有 gateway transport", () => {
    expect(source).toContain("readMobileRemoteSessionContext({");
    expect(source).toContain("setStreamClientId(session.context.clientInstanceId)");
    expect(source).toContain("clientInstanceId: gatewayConfig.clientInstanceId");
    expect(source).toContain("appVersion: gatewayConfig.appVersion");
  });

  it("没有配置写入、SecureStore 或 clientInstanceId 生成路径", () => {
    expect(source).not.toContain("MobileRemoteConfigStore");
    expect(source).not.toContain("createMobileRemoteSecureStore");
    expect(source).not.toContain("getClientInstanceId");
    expect(source).not.toContain("saveMobileRemoteSettingsDraft");
    expect(source).not.toContain("resolveMobileRemoteConnection");
    expect(source).not.toContain("secureStore");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("URLSearchParams(params)");
    expect(source).not.toContain("seedStableWebRemoteControlClientId");
    expect(source).not.toContain("reopenSetup");
  });

  it("连接修改、切换电脑和失败出口统一 returnShell", () => {
    expect(source).toContain("session.bridge.returnShell(reason, session.context.sessionId)");
    expect(source).toContain('context.requestReturnShell("connection-settings")');
    expect(source).toContain('context.requestReturnShell("settings")');
    expect(source).toContain('context.requestReturnShell("backend")');
    expect(source).toContain('context.requestReturnShell("notification-backend-mismatch")');
    expect(source).toContain("reconnect: () => context.requestReturnShell");
  });

  it("启动业务 Channel 前校验 release manifest 的 bridgeVersion", () => {
    const releaseCheck = source.indexOf("checkMobileRemoteRelease");
    const transportCreate = source.indexOf("new GatewayTerminalTransport");
    const transportStart = source.indexOf("transport.start()");
    expect(releaseCheck).toBeGreaterThan(0);
    expect(releaseCheck).toBeLessThan(transportCreate);
    expect(releaseCheck).toBeLessThan(transportStart);
    expect(source).toContain('release.kind === "upgrade-required"');
    expect(source).toContain('upgrade: "mobile"');
  });

  it("文件、通知与 lifecycle 适配器均携带 sessionId", () => {
    expect(source).toContain("createMobileRemoteFileCapabilities(");
    expect(source).toContain("resolveMobileRemoteFileBridge(),");
    expect(source).toContain("{ sessionId: session.context.sessionId }");
    expect(source).toContain("createMobileNotificationPlatform(globalThis, {");
    expect(source).toContain("installMobileRemoteNativeHost({");
    expect(source).toContain("sessionId: session.context.sessionId");
  });

  it("业务 Channel ready 后先启动发布检查/markRemoteReady，再消费通知 intent", () => {
    const bootstrapStart = source.indexOf("bootstrapPairedSession = async");
    expect(bootstrapStart).toBeGreaterThan(0);
    const bootstrapBody = source.slice(bootstrapStart);
    // M3-T2：ready 收口统一走 signalBusinessReady（先启动 release controller，再 markRemoteReady）。
    const readyIndex = bootstrapBody.indexOf("signalBusinessReady();");
    const consumeIndex = bootstrapBody.indexOf("void consumeNativeNotification();");
    expect(readyIndex).toBeGreaterThan(0);
    expect(consumeIndex).toBeGreaterThan(readyIndex);
    expect(source).toContain("markRemoteReady");
    expect(source).toContain("markReady.call(bridge, gatewayConfig.sessionId)");
    expect(source).toContain("parseMobileRemoteBridgeEnvelope(");
  });
});
