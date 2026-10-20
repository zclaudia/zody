// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessStatus } from "@zcode/shared";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  DialogContent: ({
    children,
    className,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
    showCloseButton?: boolean;
    [key: string]: unknown;
  }) => createElement("section", { className, ...props }, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
  DialogHeader: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement("header", { className }, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
}));

vi.mock("@/components/ui/switch.js", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    [key: string]: unknown;
  }) =>
    createElement("input", {
      ...props,
      type: "checkbox",
      checked,
      disabled,
      onChange: () => onCheckedChange?.(!checked),
    }),
}));

const feedbackMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: feedbackMocks.toast }));

const platformMock = vi.hoisted(() => ({
  setRemoteAccessEnabled: vi.fn(async () => {}),
  disconnectRemoteClient: vi.fn(async () => {}),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platformMock,
}));

const remoteAccessStatusMock = vi.hoisted(() => ({
  status: null as RemoteAccessStatus | null,
  refresh: vi.fn(async () => {}),
}));

vi.mock("@/hooks/useRemoteAccessStatus.js", () => ({
  useRemoteAccessStatus: () => ({
    status: remoteAccessStatusMock.status,
    loading: false,
    refresh: remoteAccessStatusMock.refresh,
  }),
}));

const intlMock = vi.hoisted(() => ({
  intl: {
    formatMessage: ({ id }: { id: string }) => id,
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => intlMock,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: feedbackMocks.error,
    info: feedbackMocks.info,
  },
}));

function readDialogSource() {
  return readFileSync("packages/ui/src/WebRemoteControlDialog.tsx", "utf8");
}

function makeStatus(overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
  return {
    enabled: true,
    status: { status: "running" },
    gateway: { state: "online", backendId: "backend-1", epoch: 1 },
    ...overrides,
  };
}

function renderDialog() {
  return render(
    createElement(WebRemoteControlDialog, {
      open: true,
      onOpenChange: vi.fn(),
      workspacePath: "/tmp/project",
    }),
  );
}

describe("WebRemoteControlDialog", () => {
  afterEach(() => {
    cleanup();
    platformMock.setRemoteAccessEnabled.mockClear();
    platformMock.disconnectRemoteClient.mockClear();
    remoteAccessStatusMock.status = null;
    remoteAccessStatusMock.refresh.mockClear();
    feedbackMocks.error.mockClear();
    feedbackMocks.info.mockClear();
    feedbackMocks.toast.mockClear();
  });

  it("只展示 App 级远程访问状态，不再生成二维码", () => {
    remoteAccessStatusMock.status = makeStatus({ enabled: false, gateway: { state: "disabled" } });

    const view = renderDialog();

    expect(view.container.textContent).toContain("webRemoteControl.remoteAccess.title");
    expect(view.container.textContent).toContain("settings.remoteAccess.gateway.disabled");
    expect(view.container.textContent).toContain("settings.remoteAccess.phone.waiting");
    expect(view.container.textContent).not.toContain("webRemoteControl.qrAlt");
    expect(view.container.querySelector('img[alt="webRemoteControl.qrAlt"]')).toBeNull();
  });

  it("展示 gateway 与手机的全局连接状态", () => {
    remoteAccessStatusMock.status = makeStatus({
      status: {
        status: "active",
        mobileConnected: true,
        mobileDeviceInfo: {
          platform: "android",
          version: "1.0.0",
          name: "Pixel 9",
          updatedAt: 1,
        },
      },
      gateway: { state: "online", backendId: "backend-1", epoch: 2 },
    });

    const view = renderDialog();

    expect(view.container.textContent).toContain("settings.remoteAccess.gateway.online");
    expect(view.container.textContent).toContain("Pixel 9");
    expect(
      view.container
        .querySelector('[data-testid="web-remote-control-gateway-status"]')
        ?.getAttribute("data-state"),
    ).toBe("online");
    expect(
      view.container
        .querySelector('[data-testid="web-remote-control-mobile-status"]')
        ?.getAttribute("data-connected"),
    ).toBe("true");
  });

  it("快捷开关调用 setRemoteAccessEnabled 并刷新状态", async () => {
    remoteAccessStatusMock.status = makeStatus({ enabled: false, gateway: { state: "disabled" } });

    const view = renderDialog();
    const toggle = (await view.findByTestId(
      "web-remote-control-remote-access-switch",
    )) as HTMLInputElement;

    fireEvent.click(toggle);

    await waitFor(() => expect(platformMock.setRemoteAccessEnabled).toHaveBeenCalledWith(true));
    expect(remoteAccessStatusMock.refresh).toHaveBeenCalled();
  });

  it("有手机连接时可以断开手机", async () => {
    remoteAccessStatusMock.status = makeStatus({
      status: {
        status: "active",
        mobileConnected: true,
        mobileDeviceInfo: {
          platform: "android",
          version: "1.0.0",
          name: "Pixel 9",
          updatedAt: 1,
        },
      },
    });

    const view = renderDialog();
    fireEvent.click(await view.findByTestId("web-remote-control-disconnect-client"));

    await waitFor(() => expect(platformMock.disconnectRemoteClient).toHaveBeenCalledOnce());
    expect(remoteAccessStatusMock.refresh).toHaveBeenCalled();
  });

  it("gateway 失败时显示可读状态并提示去设置页配置", () => {
    remoteAccessStatusMock.status = makeStatus({
      enabled: true,
      gateway: { state: "error", reason: "credential-invalid" },
    });

    const view = renderDialog();

    expect(view.container.textContent).toContain("settings.remoteAccess.gateway.credentialInvalid");
    expect(view.container.textContent).toContain("webRemoteControl.remoteAccess.settingsHint");
  });

  it("源码不再包含二维码、链接和窗口级启动/停止路径", () => {
    const source = readDialogSource();

    expect(source).not.toContain("QRCode");
    expect(source).not.toContain("startWebRemoteControl");
    expect(source).not.toContain("refreshWebRemoteControlPairing");
    expect(source).not.toContain("stopWebRemoteControl");
    expect(source).toContain("useRemoteAccessStatus");
    expect(source).toContain("setRemoteAccessEnabled");
    expect(source).toContain("disconnectRemoteClient");
  });

  // fork（bot-channels 移除）：原双列 max-w-4xl 布局随右列 Bots 入口卡删除回归单列
  // （specs/bot-channels-removal.md），弹层收窄为 max-w-xl 并去掉等高 min-h-[360px]。
  it("renders single column without the removed bots entry", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    expect(html).toContain('data-testid="web-remote-control-main-grid"');
    expect(html).toContain('data-testid="web-remote-control-status-card"');
    expect(html).not.toContain("md:grid-cols-");
    expect(html).not.toContain("min-h-[360px]");
    expect(html).not.toContain('data-testid="web-remote-control-open-bots"');
    expect(html).not.toContain("webRemoteControl.botChannel.title");
  });

  it("uses Remote Connect width without forcing the lighter dialog to full height", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    expect(html).toContain("max-h-[calc(100vh-6rem)]");
    expect(html).toContain("max-w-xl");
    expect(html).not.toContain("max-w-4xl");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain('data-testid="web-remote-control-dialog-scroll"');
    expect(html).not.toContain('class="h-[calc(100vh-6rem)]');
    expect(html).toContain("overflow-y-auto");
  });
});
