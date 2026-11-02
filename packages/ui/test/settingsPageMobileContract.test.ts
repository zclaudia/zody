import { readSourceText } from "./readSourceText.js";
import { describe, expect, it } from "vitest";

const settingsPageSource = readSourceText(
  new URL("../src/SettingsPage.tsx", import.meta.url),
  "utf8",
);

describe("SettingsPage mobile shell contract", () => {
  it("手机模式使用设置首页/分区投影，并隐藏桌面 chrome 与重复标题", () => {
    expect(settingsPageSource).toContain("data-mobile-settings-view");
    expect(settingsPageSource).toContain("<MobileSettingsSectionHeader");
    // 帮助按钮只在非手机模式渲染。
    expect(settingsPageSource).toContain("!usesInlineWindowControls && !isMobileSettings");
    // 桌面 breadcrumb 行在手机隐藏，但保留在 DOM/source 契约中。
    expect(settingsPageSource).toContain('cn("flex h-12 shrink-0", isMobileSettings && "hidden")');
    // 正文标题块在手机隐藏，由分区 header 承担标题。
    expect(settingsPageSource).toContain('<div className={cn(isMobileSettings && "hidden")}>');
    // 主滚动链保持不变，手机底部安全区单独占位。
    expect(settingsPageSource).toContain(
      'className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"',
    );
    expect(settingsPageSource).toContain("zcode-safe-area-bottom");
    // index 下 section 子树只隐藏不卸载，保留草稿和选中态。
    expect(settingsPageSource).toContain(
      'isMobileSettings && mobileSettingsView === "index" && "hidden"',
    );
  });

  it("设置 history 初始化有 once guard，卸载时回收条目", () => {
    expect(settingsPageSource).toContain("mobileHistoryInitializedRef");
    expect(settingsPageSource).toContain("planInitialWebRemoteControlMobileSettingsHistory");
    expect(settingsPageSource).toContain("clearWebRemoteControlMobileSettingsHistoryState");
    expect(settingsPageSource).toContain("handleMobileBackOrClose");
  });

  it("连接分区只在手机 Web Remote Control 且已注入连接能力时出现", () => {
    // 平台可见性由 createSettingsPageConfig 的单一切换位决定，桌面与普通 Web 不渲染该分区。
    expect(settingsPageSource).toContain("isWebRemoteControlMobile: showMobileConnectionSettings");
    expect(settingsPageSource).toContain("isMobileSettings && Boolean(mobileConnectionSettings)");
    expect(settingsPageSource).toContain("<WebRemoteControlMobileConnectionSettingsSection");
  });

  it("popstate 处理器只回写 React 状态，不写 history", () => {
    const start = settingsPageSource.indexOf("const handlePopState");
    const end = settingsPageSource.indexOf('window.addEventListener("popstate"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const popStateBlock = settingsPageSource.slice(start, end);
    expect(popStateBlock).not.toMatch(/history\.(pushState|replaceState|back)/);
  });
});
