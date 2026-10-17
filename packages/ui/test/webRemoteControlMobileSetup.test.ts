// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE } from "@zcode/shared";
import { WebRemoteControlMobileSettingsScreen } from "@/WebRemoteControlMobileSettingsScreen.js";
import { WebRemoteControlMobileBackendPicker } from "@/WebRemoteControlMobileBackendPicker.js";
import {
  WebRemoteControlMobileStartPage,
  WebRemoteControlRecentProjectsSection,
} from "@/WebRemoteControlRecentProjects.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", { type: "button", ...props }, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/components/ui/label.js", () => ({
  Label: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("label", props, children),
}));

vi.mock("@/WebRemoteControlThemeMenu.js", () => ({
  WebRemoteControlThemeMenu: () => null,
}));

/** 方案「验收」第 9 条：手机页面组件测试在 375px 视口下执行。 */
function setMobileViewport() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
}

beforeEach(setMobileViewport);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("mobile remote settings page (375px)", () => {
  it("validates required fields before saving", async () => {
    const onSubmit = vi.fn(async () => {});
    render(createElement(WebRemoteControlMobileSettingsScreen, { onSubmit }));

    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "webRemoteControl.mobileSetup.gatewayUrl.required",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("requires https outside development and a zgd_ credential", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      createElement(WebRemoteControlMobileSettingsScreen, {
        onSubmit,
        allowInsecureTransport: false,
      }),
    );

    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "http://gateway.example.com" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
      target: { value: "zgd_abc" },
    });
    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "webRemoteControl.mobileSetup.gatewayUrl.invalid",
    );

    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "https://gateway.example.com/" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
      target: { value: "zgb_wrong" },
    });
    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "webRemoteControl.mobileSetup.credential.invalid",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the normalized draft and exposes 44px touch targets", async () => {
    const onSubmit = vi.fn(async () => {});
    render(createElement(WebRemoteControlMobileSettingsScreen, { onSubmit }));

    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "https://gateway.example.com/" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.namespace.label"), {
      target: { value: "team" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
      target: { value: " zgd_abc " },
    });
    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        gatewayUrl: "https://gateway.example.com/",
        namespace: "team",
        credential: "zgd_abc",
      }),
    );
    const submit = document.querySelector<HTMLButtonElement>("button[type=submit]");
    expect(submit?.className).toContain("h-11");
    expect(window.innerWidth).toBe(375);
  });

  it("surfaces the release secure-storage refusal instead of silently falling back", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
    });
    render(createElement(WebRemoteControlMobileSettingsScreen, { onSubmit }));

    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "https://gateway.example.com" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
      target: { value: "zgd_abc" },
    });
    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "webRemoteControl.mobileSetup.storageUnavailable",
    );
  });

  it("keeps the saved credential when only the address changes", async () => {
    const onSubmit = vi.fn(async () => {});
    render(
      createElement(WebRemoteControlMobileSettingsScreen, {
        onSubmit,
        initial: {
          gatewayUrl: "https://gateway.example.com",
          namespace: "zcode",
          credentialConfigured: true,
        },
      }),
    );

    expect(
      screen.getByPlaceholderText("webRemoteControl.mobileSetup.credential.savedPlaceholder"),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "https://gateway.example.com" },
    });
    fireEvent.click(screen.getByText("webRemoteControl.mobileSetup.save"));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        gatewayUrl: "https://gateway.example.com",
        namespace: "zcode",
        credential: "",
      }),
    );
  });
});

describe("mobile remote backend picker (375px)", () => {
  const backends = [
    {
      backendId: "backend-a",
      name: "Studio Mac",
      online: true,
      supported: true,
      lastSeenAt: 1,
    },
    {
      backendId: "backend-b",
      name: "Old Laptop",
      online: true,
      supported: false,
      lastSeenAt: 1,
    },
    {
      backendId: "backend-c",
      name: "Office PC",
      online: false,
      supported: true,
      lastSeenAt: 2,
    },
  ];

  it("disables desktops without the remote-control capability", () => {
    render(
      createElement(WebRemoteControlMobileBackendPicker, {
        backends,
        loading: false,
        onSelect: async () => {},
        onBackToSettings: () => {},
      }),
    );

    const unsupported = screen
      .getByText("Old Laptop")
      .closest("button") as HTMLButtonElement | null;
    expect(unsupported?.disabled).toBe(true);
    expect(screen.getByText("webRemoteControl.mobileBackend.unsupportedHint")).toBeTruthy();
    // 离线但支持远控的电脑仍可选择，等 registry 恢复在线。
    const offline = screen.getByText("Office PC").closest("button") as HTMLButtonElement | null;
    expect(offline?.disabled).toBe(false);
  });

  it("selects a backend with a 44px confirm target", async () => {
    const onSelect = vi.fn(async () => {});
    render(
      createElement(WebRemoteControlMobileBackendPicker, {
        backends,
        loading: false,
        onSelect,
        onBackToSettings: () => {},
      }),
    );

    fireEvent.click(screen.getByText("Studio Mac").closest("button")!);
    const confirm = screen.getByText("webRemoteControl.mobileBackend.confirm");
    expect(confirm.className).toContain("h-11");
    fireEvent.click(confirm);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("backend-a"));
  });

  it("offers the way back to settings before choosing", () => {
    const onBackToSettings = vi.fn();
    render(
      createElement(WebRemoteControlMobileBackendPicker, {
        backends,
        loading: false,
        onSelect: async () => {},
        onBackToSettings,
      }),
    );

    fireEvent.click(screen.getByText("webRemoteControl.mobileBackend.backToSettings"));
    expect(onBackToSettings).toHaveBeenCalledOnce();
  });

  it("shows credential and gateway failures with refresh/back affordances", () => {
    render(
      createElement(WebRemoteControlMobileBackendPicker, {
        backends: [],
        loading: false,
        failure: { reason: "gateway-credential-invalid" },
        onSelect: async () => {},
        onBackToSettings: () => {},
        onRefresh: () => {},
      }),
    );

    expect(screen.getByText("webRemoteControl.mobileBackend.credentialInvalid")).toBeTruthy();
    expect(screen.getByLabelText("webRemoteControl.mobileBackend.refresh")).toBeTruthy();
  });
});

describe("mobile start page and recent projects (375px)", () => {
  const recentProjects = [{ id: "recent-1", label: "zcode", location: "/Users/dev/SourceCode" }];

  it("shows the no-window empty state and opens the desktop window", () => {
    const onOpenDesktopWindow = vi.fn();
    render(
      createElement(WebRemoteControlMobileStartPage, {
        desktopWindowState: "none",
        recentProjects,
        onOpenRecentProject: () => {},
        onOpenDesktopWindow,
        onOpenSettings: () => {},
      }),
    );

    expect(screen.getByText("webRemoteControl.mobileStart.noWindowTitle")).toBeTruthy();
    fireEvent.click(screen.getByText("webRemoteControl.mobileStart.openWindow"));
    expect(onOpenDesktopWindow).toHaveBeenCalledOnce();
  });

  it("asks the desktop to open a recent project by opaque id", () => {
    const onOpenRecentProject = vi.fn();
    render(
      createElement(WebRemoteControlRecentProjectsSection, {
        desktopWindowState: "open",
        recentProjects,
        onOpenRecentProject,
      }),
    );

    expect(screen.getByText("zcode")).toBeTruthy();
    fireEvent.click(screen.getByText("zcode"));
    expect(onOpenRecentProject).toHaveBeenCalledWith("recent-1");
  });

  it("shows the open-workspace empty state when the desktop window exists", () => {
    render(
      createElement(WebRemoteControlMobileStartPage, {
        desktopWindowState: "open",
        recentProjects: [],
        onOpenRecentProject: () => {},
        onOpenDesktopWindow: () => {},
        onOpenSettings: () => {},
      }),
    );

    expect(screen.getByText("webRemoteControl.mobileStart.noWorkspaceTitle")).toBeTruthy();
    expect(screen.getByText("webRemoteControl.mobileHome.recentProjectsEmpty")).toBeTruthy();
  });
});
