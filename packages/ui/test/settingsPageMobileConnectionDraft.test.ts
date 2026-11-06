// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/SettingsPage.js";

/**
 * SettingsPage 手机连接分区草稿清理 + 有效变化重连的集成回归（spec §4 / M12、M13、M15）。
 *
 * SettingsPage 在设置首页下只隐藏分区、不卸载，因此顶部返回、浏览器 popstate 和
 * Android 返回都必须通过 SettingsPage 的投影变化触发草稿重置，而不是只在 Cancel
 * 按钮里 reset。这里渲染真实 SettingsPage（真实 mobile 索引/分区/history），只替换
 * 业务分区与平台/服务边界。
 */

const backHandlers: Array<() => boolean> = [];
const storeState: Record<string, unknown> = {
  interfaceMode: "coding",
  setInterfaceMode: vi.fn(),
  theme: "system",
  setTheme: vi.fn(),
  codePreviewSettings: {},
  setCodePreviewSettings: vi.fn(),
  uiFontSizePx: 13,
  setUiFontSizePx: vi.fn(),
  notificationEnabled: true,
  setNotificationEnabled: vi.fn(),
  notificationSoundEnabled: true,
  setNotificationSoundEnabled: vi.fn(),
  setNewUserOnboardingOpen: vi.fn(),
};
const tabStoreState: Record<string, unknown> = {
  activeWorkspaceIdentity: undefined,
  activeWorkspacePath: undefined,
  tabs: [],
};
const services = {
  settingService: {
    get: vi.fn(async () => ({})),
    update: vi.fn(async () => {}),
    updateDataBaseDir: vi.fn(async () => {}),
  },
};
const localServices = {
  systemService: {
    info: vi.fn(async () => ({ homedir: "/tmp", platform: "darwin" })),
    listIntegratedTerminalShells: vi.fn(async () => []),
  },
};

const mockPlatform = {
  onBackPressed: (listener: () => boolean) => {
    backHandlers.push(listener);
    return () => {
      const index = backHandlers.indexOf(listener);
      if (index >= 0) backHandlers.splice(index, 1);
    };
  },
  syncAppSettings: vi.fn(),
};

vi.mock("@/DesktopWindowFrame.js", () => ({
  DesktopWindowFrame: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/WorkspaceSidebarFooter.js", () => ({ WorkspaceSidebarFooter: () => null }));
vi.mock("@/WorkspaceHelpMenuButton.js", () => ({ WorkspaceHelpMenuButton: () => null }));
vi.mock("@/DesktopWindowControls.js", () => ({ DesktopWindowControls: () => null }));
vi.mock("@/WindowsTopLeftLogo.js", () => ({ WindowsTopLeftLogo: () => null }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    variant?: string;
    size?: string;
    [key: string]: unknown;
  }) => createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    localePreference: "system",
    setLocalePreference: vi.fn(),
  }),
}));
vi.mock("@/hooks/useWebRemoteControlMobileViewport.js", () => ({
  useWebRemoteControlMobileViewport: () => true,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mockPlatform,
  useSelectDirectory: () => vi.fn(async () => null),
}));
vi.mock("@/hooks/useServices.js", () => ({
  ServiceProvider: ({ children }: { children: ReactNode }) => children,
  useServices: () => services,
  useOptionalServices: () => services,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => localServices,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: undefined, update: vi.fn() }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZodyStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector(tabStoreState),
}));
vi.mock("@/settings/SettingsPageParts.js", () => ({
  SETTINGS_FRAME_CONTENT_CLASSNAME: "settings-content",
}));
// 使用真实 settingsPageConfig（平台可见性/排序是本次验收点），只替换重型业务分区。
vi.mock("@/settingsPageHelpers.js", async () => {
  const config = await vi.importActual<typeof import("@/settings/settingsPageConfig.js")>(
    "@/settings/settingsPageConfig.js",
  );
  return {
    createSettingsPageConfig: config.createSettingsPageConfig,
    resolveSettingsSectionForPlatform: config.resolveSettingsSectionForPlatform,
    GeneralSectionContent: () => createElement("div", null, "general"),
    GeneralSectionHeader: () => null,
  };
});
vi.mock("@/settingsCodePreview.js", () => ({ AppearanceSectionContent: () => null }));
vi.mock("@/settings/ModelProviderSection.js", () => ({ ModelProviderSection: () => null }));
vi.mock("@/settings/UsageStatsSection.js", () => ({ UsageStatsSection: () => null }));
vi.mock("@/settings/SubagentsSection.js", () => ({ SubagentsSection: () => null }));
vi.mock("@/settings/AutomationsSection.js", () => ({ AutomationsSection: () => null }));
vi.mock("@/settings/PluginsSection.js", () => ({ PluginsSection: () => null }));
vi.mock("@/settings/HooksSection.js", () => ({ HooksSection: () => null }));
vi.mock("@/settings/WorkspaceFileSearchSection.js", () => ({
  WorkspaceFileSearchSection: () => null,
}));
vi.mock("@/settings/MemorySettingsSection.js", () => ({ MemorySettingsSection: () => null }));
vi.mock("@/settings/BrowserSettingsSection.js", () => ({ BrowserSettingsSection: () => null }));
vi.mock("@/settings/RemoteAccessSection.js", () => ({ RemoteAccessSection: () => null }));
vi.mock("@/settings/ComputerUseSection.js", () => ({ ComputerUseSection: () => null }));
vi.mock("@/settings/ShortcutSettingsSection.js", () => ({ ShortcutSettingsSection: () => null }));
vi.mock("@/settings/MigrationSection.js", () => ({ MigrationSection: () => null }));

function renderSettingsPage(scopeChanged = false) {
  const save = vi.fn(async () => ({ scopeChanged }));
  const reconnect = vi.fn();
  const onBack = vi.fn();
  const mobileConnectionSettings = {
    initial: {
      gatewayUrl: "https://gateway.example.com",
      namespace: "zody",
      credentialConfigured: true,
    },
    allowInsecureTransport: true,
    save,
    reconnect,
  };
  render(
    createElement(SettingsPage, {
      isWebRemoteControl: true,
      mobileConnectionSettings,
      onBack,
    }),
  );
  return { save, reconnect, onBack };
}

function connectionSectionItem(): HTMLElement {
  return screen.getByTestId("mobile-settings-section-connection");
}

function gatewayInput(): HTMLInputElement {
  return screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label") as HTMLInputElement;
}

function namespaceInput(): HTMLInputElement {
  return screen.getByLabelText("webRemoteControl.mobileSetup.namespace.label") as HTMLInputElement;
}

function credentialInput(): HTMLInputElement {
  return screen.getByLabelText("webRemoteControl.mobileSetup.credential.label") as HTMLInputElement;
}

/** 模拟浏览器/Android 返回落点：改写 state 后派发 popstate（jsdom 不执行真实遍历）。 */
function dispatchPopState(state: unknown) {
  act(() => {
    window.history.replaceState(state, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
  });
}

const settingsIndexState = { zcodeMobilePage: "home", zcodeMobileSettings: { view: "index" } };

async function openConnectionSection() {
  fireEvent.click(connectionSectionItem());
  await waitFor(() =>
    expect(window.history.state).toMatchObject({
      zcodeMobileSettings: { view: "section", section: "connection" },
    }),
  );
  fireEvent.change(gatewayInput(), { target: { value: "https://unsaved.example.com" } });
  fireEvent.change(namespaceInput(), { target: { value: "unsaved" } });
  fireEvent.change(credentialInput(), { target: { value: "zgd_unsaved" } });
}

async function expectDraftDiscardedAfterReturn() {
  await waitFor(() =>
    expect(document.querySelector('[data-mobile-settings-index="true"]')).toBeTruthy(),
  );
  fireEvent.click(connectionSectionItem());
  await waitFor(() =>
    expect(window.history.state).toMatchObject({
      zcodeMobileSettings: { view: "section", section: "connection" },
    }),
  );
  expect(gatewayInput().value).toBe("https://gateway.example.com");
  expect(namespaceInput().value).toBe("zody");
  expect(credentialInput().value).toBe("");
}

describe("SettingsPage mobile connection draft lifecycle", () => {
  let backSpy: ReturnType<typeof vi.spyOn>;
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({ zcodeMobilePage: "home" }, "");
    backHandlers.length = 0;
    backSpy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    goSpy = vi.spyOn(window.history, "go").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState(null, "");
  });

  it("只在手机 Web Remote Control 注入连接能力时显示连接分区", async () => {
    const view = renderSettingsPage();
    expect(connectionSectionItem()).toBeTruthy();

    // 分区页顶部返回：回设置首页并丢弃未保存输入。
    await openConnectionSection();
    fireEvent.click(screen.getByRole("button", { name: "common.back" }));
    expect(backSpy).toHaveBeenCalledOnce();
    dispatchPopState(settingsIndexState);
    await expectDraftDiscardedAfterReturn();
    expect(view.reconnect).not.toHaveBeenCalled();
  });

  it("浏览器返回离开连接分区时丢弃草稿，再次进入不保留 Gateway/namespace/凭证", async () => {
    renderSettingsPage();
    await openConnectionSection();

    // 浏览器返回直接落到设置首页条目。
    dispatchPopState(settingsIndexState);
    await expectDraftDiscardedAfterReturn();
  });

  it("Android 返回由 SettingsPage 消费并丢弃草稿", async () => {
    renderSettingsPage();
    await openConnectionSection();
    expect(backHandlers).toHaveLength(1);

    let handled = false;
    act(() => {
      handled = backHandlers[0]!();
    });
    expect(handled).toBe(true);
    expect(backSpy).toHaveBeenCalledOnce();

    dispatchPopState(settingsIndexState);
    await expectDraftDiscardedAfterReturn();
  });

  it("有效变化先 go(-2) 回退设置条目，落回宿主后才重连一次", async () => {
    const view = renderSettingsPage(true);
    await openConnectionSection();
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSettings.save" }));

    await waitFor(() => expect(view.save).toHaveBeenCalledOnce());
    expect(view.reconnect).not.toHaveBeenCalled();
    expect(goSpy).toHaveBeenCalledWith(-2);
    expect(backSpy).not.toHaveBeenCalled();

    // 先落在中间设置首页不重连；必须等宿主条目。
    dispatchPopState(settingsIndexState);
    expect(view.reconnect).not.toHaveBeenCalled();

    dispatchPopState({ zcodeMobilePage: "home" });
    expect(view.reconnect).toHaveBeenCalledOnce();
    expect(view.onBack).toHaveBeenCalledOnce();

    dispatchPopState({ zcodeMobilePage: "home" });
    expect(view.reconnect).toHaveBeenCalledOnce();
  });

  it("无有效变化保存成功回设置首页并丢弃草稿，不重连", async () => {
    const view = renderSettingsPage(false);
    await openConnectionSection();
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSettings.save" }));

    await waitFor(() => expect(view.save).toHaveBeenCalledOnce());
    expect(backSpy).toHaveBeenCalledOnce();
    expect(view.reconnect).not.toHaveBeenCalled();

    dispatchPopState(settingsIndexState);
    await waitFor(() =>
      expect(document.querySelector('[data-mobile-settings-index="true"]')).toBeTruthy(),
    );
    fireEvent.click(connectionSectionItem());
    expect(gatewayInput().value).toBe("https://gateway.example.com");
    expect(credentialInput().value).toBe("");
  });
});
