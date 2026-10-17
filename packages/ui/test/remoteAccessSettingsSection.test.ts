// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAccessStatus } from "@zcode/shared";
import { RemoteAccessSection } from "@/settings/RemoteAccessSection.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
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
  warn: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: feedbackMocks.toast }));

vi.mock("@/logger.js", () => ({
  logger: {
    error: feedbackMocks.error,
    warn: feedbackMocks.warn,
    info: vi.fn(),
  },
}));

const intlMock = vi.hoisted(() => ({
  intl: {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) =>
      values ? `${descriptor.id}:${JSON.stringify(values)}` : descriptor.id,
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => intlMock,
}));

const platformMock = vi.hoisted(() => ({
  isLocalDevelopmentRuntime: false,
  getRemoteAccessCredentialStatus: vi.fn(async () => ({ configured: false })),
  saveRemoteAccessCredential: vi.fn(async () => {}),
  clearRemoteAccessCredential: vi.fn(async () => {}),
  setRemoteAccessEnabled: vi.fn(async () => {}),
  testRemoteAccessConnection: vi.fn(async () => ({ ok: true, status: { state: "online" } })),
  disconnectRemoteClient: vi.fn(async () => {}),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platformMock,
}));

const settingsMock = vi.hoisted(() => ({
  update: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  settings: {
    remoteAccess: {
      enabled: true,
      gatewayUrl: "https://gateway.example.com/",
      namespace: "zcode",
    },
  },
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: settingsMock.settings,
    loading: false,
    error: null,
    update: settingsMock.update,
    refresh: settingsMock.refresh,
  }),
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

vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsGroupCard: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  SettingsRow: ({
    label,
    description,
    control,
  }: {
    label?: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) =>
    createElement(
      "div",
      null,
      createElement("div", null, label),
      createElement("div", null, description),
      createElement("div", null, control),
    ),
}));

function makeStatus(overrides: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus {
  return {
    enabled: true,
    status: { status: "running" },
    gateway: { state: "online", backendId: "backend-1", epoch: 1 },
    ...overrides,
  };
}

function renderSection() {
  return render(createElement(RemoteAccessSection, { isDesktop: true }));
}

describe("RemoteAccessSection", () => {
  beforeEach(() => {
    remoteAccessStatusMock.status = makeStatus();
  });

  afterEach(() => {
    cleanup();
    for (const mock of Object.values(platformMock)) {
      if (typeof mock === "function" && "mockClear" in mock) {
        mock.mockClear();
      }
    }
    settingsMock.update.mockClear();
    settingsMock.refresh.mockClear();
    remoteAccessStatusMock.refresh.mockClear();
    feedbackMocks.toast.mockClear();
    feedbackMocks.error.mockClear();
    feedbackMocks.warn.mockClear();
  });

  it("回填已保存的 gateway 地址和 namespace", async () => {
    const view = renderSection();

    await waitFor(() =>
      expect((view.getByTestId("remote-access-gateway-url") as HTMLInputElement).value).toBe(
        "https://gateway.example.com/",
      ),
    );
    expect((view.getByTestId("remote-access-namespace") as HTMLInputElement).value).toBe("zcode");
    expect(platformMock.getRemoteAccessCredentialStatus).toHaveBeenCalled();
  });

  it("保存配置时归一化地址并整对象写回 remoteAccess", async () => {
    const view = renderSection();
    const gatewayUrlInput = view.getByTestId("remote-access-gateway-url");
    fireEvent.change(gatewayUrlInput, { target: { value: "https://gateway.example.com/" } });

    fireEvent.click(view.getByTestId("remote-access-save-config"));

    await waitFor(() =>
      expect(settingsMock.update).toHaveBeenCalledWith({
        remoteAccess: {
          enabled: true,
          gatewayUrl: "https://gateway.example.com",
          namespace: "zcode",
        },
      }),
    );
  });

  it("拒绝非 http(s) 地址且不写设置", async () => {
    const view = renderSection();
    fireEvent.change(view.getByTestId("remote-access-gateway-url"), {
      target: { value: "not-a-url" },
    });

    fireEvent.click(view.getByTestId("remote-access-save-config"));

    expect(settingsMock.update).not.toHaveBeenCalled();
    expect(feedbackMocks.toast).toHaveBeenCalledWith("settings.remoteAccess.gatewayUrl.invalid");
  });

  it("保存凭证后清空输入并标记为已配置", async () => {
    const view = renderSection();
    await waitFor(() =>
      expect(
        view.getByTestId("remote-access-credential-status").getAttribute("data-configured"),
      ).toBe("false"),
    );
    fireEvent.change(view.getByTestId("remote-access-credential"), {
      target: { value: "zgb_test" },
    });

    fireEvent.click(view.getByTestId("remote-access-save-credential"));

    await waitFor(() =>
      expect(platformMock.saveRemoteAccessCredential).toHaveBeenCalledWith("zgb_test"),
    );
    await waitFor(() =>
      expect((view.getByTestId("remote-access-credential") as HTMLInputElement).value).toBe(""),
    );
    expect(
      view.getByTestId("remote-access-credential-status").getAttribute("data-configured"),
    ).toBe("true");
  });

  it("凭证格式错误时显示专门文案", async () => {
    platformMock.saveRemoteAccessCredential.mockRejectedValueOnce(
      new Error("Remote access gateway backend credential must be a zgb_ or zga_ token"),
    );
    const view = renderSection();
    fireEvent.change(view.getByTestId("remote-access-credential"), {
      target: { value: "zgd_wrong_kind" },
    });

    fireEvent.click(view.getByTestId("remote-access-save-credential"));

    await waitFor(() =>
      expect(feedbackMocks.toast).toHaveBeenCalledWith(
        expect.stringContaining("settings.remoteAccess.credential.invalid"),
      ),
    );
  });

  it("有手机连接时禁用测试连接并说明原因", () => {
    remoteAccessStatusMock.status = makeStatus({
      status: { status: "active", mobileConnected: true },
    });

    const view = renderSection();
    const testButton = view.getByTestId("remote-access-test-connection") as HTMLButtonElement;

    expect(testButton.disabled).toBe(true);
    expect(view.container.textContent).toContain("settings.remoteAccess.test.mobileConnected");
  });

  it("测试连接使用当前表单值和未保存的凭证", async () => {
    const view = renderSection();
    fireEvent.change(view.getByTestId("remote-access-gateway-url"), {
      target: { value: "https://other.example.com" },
    });
    fireEvent.change(view.getByTestId("remote-access-namespace"), {
      target: { value: "team" },
    });
    fireEvent.change(view.getByTestId("remote-access-credential"), {
      target: { value: "zgb_pending" },
    });

    fireEvent.click(view.getByTestId("remote-access-test-connection"));

    await waitFor(() =>
      expect(platformMock.testRemoteAccessConnection).toHaveBeenCalledWith({
        gatewayUrl: "https://other.example.com",
        namespace: "team",
        credential: "zgb_pending",
      }),
    );
    expect(remoteAccessStatusMock.refresh).toHaveBeenCalled();
  });

  it("测试连接失败时按原因显示文案", async () => {
    platformMock.testRemoteAccessConnection.mockResolvedValueOnce({
      ok: false,
      reason: "credential-invalid",
    });
    const view = renderSection();

    fireEvent.click(view.getByTestId("remote-access-test-connection"));

    await waitFor(() =>
      expect(feedbackMocks.toast).toHaveBeenCalledWith(
        "settings.remoteAccess.test.reason.credentialInvalid",
      ),
    );
  });

  it("开关调用 Main 的 setRemoteAccessEnabled", async () => {
    const view = renderSection();
    const toggle = view.getByTestId("remote-access-toggle") as HTMLInputElement;

    fireEvent.click(toggle);

    await waitFor(() => expect(platformMock.setRemoteAccessEnabled).toHaveBeenCalledWith(false));
    expect(settingsMock.refresh).toHaveBeenCalled();
  });

  it("已连接手机时可以断开", async () => {
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
    const view = renderSection();

    expect(view.container.textContent).toContain("Pixel 9");
    fireEvent.click(view.getByTestId("remote-access-disconnect-client"));

    await waitFor(() => expect(platformMock.disconnectRemoteClient).toHaveBeenCalledOnce());
    expect(remoteAccessStatusMock.refresh).toHaveBeenCalled();
  });
});
