import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 已连接手机连接设置统一进入 SettingsPage 的“连接”分区（spec §1、§4）。
 *
 * bootstrap 没有可注入的 session 级测试缝；这里锁定源码不变量：
 * - 连接能力经 Root props 注入，UI 不 import web store；
 * - 保存仍走 saveMobileRemoteSettingsDraft 唯一 helper；
 * - 有效变化仍只经 reopenSetup("auto") 重建一次；
 * - 旧的“连接设置”浮层入口和 switcher 回调不再存在。
 */

const source = readFileSync(
  resolve(process.cwd(), "packages/web/src/mobile-remote/bootstrap.tsx"),
  "utf8",
);

describe("mobile remote connection settings IA plumbing", () => {
  it("把连接配置、唯一保存 helper 和重连动作注入 Root", () => {
    expect(source).toContain("webRemoteControlMobileConnectionSettings={mobileConnectionSettings}");
    expect(source).toContain("saveMobileRemoteSettingsDraft({");
    expect(source).toContain("store: context.configStore");
    expect(source).toContain("reconnect: reopenAfterConnectionChange");
    expect(source).toContain('const reopenAfterConnectionChange = (): void => reopenSetup("auto")');
  });

  it("不再注册独立的连接设置浮层或菜单回调", () => {
    expect(source).not.toContain("MobileRemoteConnectionSettingsSurface");
    expect(source).not.toContain("registerOpenConnectionSettings");
    expect(source).not.toContain("openConnectionSettingsOverlay");
    expect(source).not.toContain("onOpenConnectionSettings");
  });

  it("首次配置、失败页与 Root 外 StartPage 继续走独立 setup 流程", () => {
    // 独立入口只剩失败页与 StartPage 的 reopenSetup("settings")。
    expect(source).toContain('onOpenSettings: () => reopenSetup("settings")');
    expect(source).toContain('onOpenSettings={() => reopenSetup("settings")}');
    expect(source).toContain("resolveMobileRemoteConnection");
  });
});
