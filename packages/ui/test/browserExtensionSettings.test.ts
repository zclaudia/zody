// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const status = {
    available: true,
    port: 39731,
    configuredPort: 39731,
    profiles: [
      {
        profileInstanceId: "profile-aaaa-1111",
        browserId: "extension:profile-aaaa-1111",
        extensionId: "extension-id",
        pairedAt: "2026-10-31T00:00:00.000Z",
        connected: true,
        generation: 3,
        boundWindowId: "1",
        binding: "current-window" as const,
      },
    ],
    installDirectory: "/tmp/browser-extension/dist",
    installDirectoryAvailable: true,
  };
  const setBrowserExtensionDefaultBackend = vi.fn(async () => ({ ok: true as const }));
  const beginBrowserExtensionPairing = vi.fn(async () => ({
    pairingSessionId: "pairing-session-id",
    pairingCode: "1234567890abcdef",
    expiresAt: Date.now() + 60_000,
  }));
  const setBrowserExtensionBridgePort = vi.fn(async (port: number) =>
    port === 39999 ? { ok: false as const, error: "port_in_use" } : { ok: true as const },
  );
  const revokeBrowserExtensionProfile = vi.fn(async () => ({ ok: true as const }));
  const transferBrowserExtensionProfile = vi.fn(async () => ({ ok: true as const }));
  const cancelBrowserExtensionPairing = vi.fn(async () => {});
  const openInFileManager = vi.fn(async () => ({ success: true }));
  return {
    status,
    beginBrowserExtensionPairing,
    cancelBrowserExtensionPairing,
    getBrowserExtensionStatus: vi.fn(async () => status),
    openInFileManager,
    revokeBrowserExtensionProfile,
    setBrowserExtensionBridgePort,
    setBrowserExtensionDefaultBackend,
    transferBrowserExtensionProfile,
  };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    getBrowserExtensionStatus: h.getBrowserExtensionStatus,
    beginBrowserExtensionPairing: h.beginBrowserExtensionPairing,
    cancelBrowserExtensionPairing: h.cancelBrowserExtensionPairing,
    revokeBrowserExtensionProfile: h.revokeBrowserExtensionProfile,
    transferBrowserExtensionProfile: h.transferBrowserExtensionProfile,
    setBrowserExtensionBridgePort: h.setBrowserExtensionBridgePort,
    setBrowserExtensionDefaultBackend: h.setBrowserExtensionDefaultBackend,
    openInFileManager: h.openInFileManager,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (message: { id: string }, values?: Record<string, string | number>) =>
        values
          ? Object.entries(values).reduce(
              (text, [key, value]) => text.replace(`{${key}}`, String(value)),
              message.id,
            )
          : message.id,
    },
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { BrowserExtensionSettingsSection } from "@/settings/BrowserExtensionSettingsSection.js";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BrowserExtensionSettingsSection", () => {
  it("手机/Web 只读提示，不提供配对、转移或撤销", () => {
    render(createElement(BrowserExtensionSettingsSection, { isDesktop: false }));

    expect(screen.getByText("settings.browser.extension.desktopOnly")).toBeTruthy();
    expect(screen.queryByTestId("browser-extension-begin-pairing")).toBeNull();
    expect(screen.queryByTestId("browser-extension-revoke")).toBeNull();
    expect(h.getBrowserExtensionStatus).not.toHaveBeenCalled();
  });

  it("桌面展示安装指引、端口、Profile 和默认 backend 选择", async () => {
    render(createElement(BrowserExtensionSettingsSection, { isDesktop: true }));

    expect(screen.getByText("pnpm --filter @zcode/browser-extension build")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId("browser-extension-install-directory").textContent).toBe(
        "/tmp/browser-extension/dist",
      );
      expect(screen.getByTestId("browser-extension-status").textContent).toContain(
        "settings.browser.extension.status.listening",
      );
    });
    expect(screen.getByTestId("browser-extension-profile-profile-aaaa-1111").textContent).toContain(
      "settings.browser.extension.profile.connected",
    );

    fireEvent.click(screen.getByTestId("browser-extension-open-install-directory"));
    expect(h.openInFileManager).toHaveBeenCalledWith("/tmp/browser-extension/dist");
  });

  it("发起配对只展示当前窗口 ticket 与 hello 信息", async () => {
    render(createElement(BrowserExtensionSettingsSection, { isDesktop: true }));

    fireEvent.click(screen.getByTestId("browser-extension-begin-pairing"));
    await waitFor(() => {
      expect(screen.getByTestId("browser-extension-pairing-code").textContent).toBe(
        "1234567890abcdef",
      );
    });
    expect(screen.getByTestId("browser-extension-pairing-extension-id").textContent).toBe(
      "settings.browser.extension.pairing.waiting",
    );
    expect(h.beginBrowserExtensionPairing).toHaveBeenCalledTimes(1);
  });

  it("端口占用时展示失败提示且保留输入", async () => {
    render(createElement(BrowserExtensionSettingsSection, { isDesktop: true }));
    await waitFor(() => {
      expect(screen.getByTestId("browser-extension-port-input")).toHaveProperty("value", "39731");
    });

    const input = screen.getByTestId("browser-extension-port-input");
    fireEvent.change(input, { target: { value: "39999" } });
    fireEvent.click(screen.getByTestId("browser-extension-port-save"));

    await waitFor(() => {
      expect(h.setBrowserExtensionBridgePort).toHaveBeenCalledWith(39999);
    });
    expect(input).toHaveProperty("value", "39999");
  });

  it("撤销需要确认，并在成功后刷新列表", async () => {
    render(createElement(BrowserExtensionSettingsSection, { isDesktop: true }));
    await waitFor(() => {
      expect(screen.getByTestId("browser-extension-revoke")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("browser-extension-revoke"));
    fireEvent.click(screen.getByTestId("browser-extension-revoke-confirm"));

    await waitFor(() => {
      expect(h.revokeBrowserExtensionProfile).toHaveBeenCalledWith("profile-aaaa-1111");
    });
  });
});
