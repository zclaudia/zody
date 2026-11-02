// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE } from "@zody/shared";
import { WebRemoteControlMobileSettingsScreen } from "@/WebRemoteControlMobileSettingsScreen.js";
import { WebRemoteControlMobileBackendPicker } from "@/WebRemoteControlMobileBackendPicker.js";
import {
  setWebRemoteControlTerminalTransportState,
} from "@/webRemoteControlTerminalTransportState.js";
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

    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));
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
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "webRemoteControl.mobileSetup.gatewayUrl.invalid",
    );

    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.gatewayUrl.label"), {
      target: { value: "https://gateway.example.com/" },
    });
    fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
      target: { value: "zgb_wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));
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
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        gatewayUrl: "https://gateway.example.com/",
        namespace: "team",
        credential: "zgd_abc",
      }),
    );
    const submit = document.querySelector<HTMLButtonElement>("button[type=submit]");
    // 继续按钮按用户指定的形态改为圆形箭头：size-12（48px）不低于 44px 触摸目标下限。
    expect(submit?.className).toContain("size-12");
    expect(submit?.className).toContain("rounded-full");
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
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));

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
    fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        gatewayUrl: "https://gateway.example.com",
        namespace: "zcode",
        credential: "",
      }),
    );
  });

  it("keeps the page pinned to the dynamic viewport (no 100vh overflow)", () => {
    // settings-1/viewport-1：#root 是 100dvh + overflow:hidden，min-h-screen 会把提交按钮
    // 裁剪到 iOS 工具栏之下；这里锁定 min-h-dvh 且不再回归 min-h-screen。
    const { container } = render(
      createElement(WebRemoteControlMobileSettingsScreen, { onSubmit: async () => {} }),
    );
    const section = container.querySelector('section[data-mobile-remote-page="settings"]');
    expect(section?.className).toContain("min-h-dvh");
    expect(section?.className).not.toContain("min-h-screen");
  });

  it("declares mobile keyboard hints on the namespace input", () => {
    // keyboard-5：namespace 输入声明 inputMode/enterKeyHint，动作键不再显示通用「换行」。
    render(createElement(WebRemoteControlMobileSettingsScreen, { onSubmit: async () => {} }));
    const namespace = screen.getByLabelText(
      "webRemoteControl.mobileSetup.namespace.label",
    ) as HTMLInputElement;
    expect(namespace.getAttribute("inputmode")).toBe("text");
    expect(namespace.getAttribute("enterkeyhint")).toBe("done");
  });

  it("renders submit failures next to the submit button and scrolls them into view", async () => {
    // home-2/settings-3：错误必须出现在提交按钮附近（视口内），而不是滚动容器顶部。
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    // showError 的滚动定位经 requestAnimationFrame 调度；jsdom 真实帧回调在多 worker 重负载下
    // 可能 1s 内不触发（评审 flake 复现）。测试内接管 rAF，在断言前手动同步 flush，
    // 让该用例不依赖任何真实定时器/帧调度。
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    try {
      const onSubmit = vi.fn(async () => {
        throw new Error("persist failed");
      });
      render(
        createElement(WebRemoteControlMobileSettingsScreen, {
          onSubmit,
          initial: { gatewayUrl: "https://gateway.example.com" },
        }),
      );
      fireEvent.change(screen.getByLabelText("webRemoteControl.mobileSetup.credential.label"), {
        target: { value: "zgd_abc" },
      });
      fireEvent.click(screen.getByRole("button", { name: "webRemoteControl.mobileSetup.save" }));

      const alert = await screen.findByRole("alert");
      const submit = document.querySelector("button[type=submit]") as HTMLButtonElement;
      // 错误块与提交按钮同行相邻：按钮行的上一个兄弟节点就是 alert。
      expect(submit.parentElement?.previousElementSibling).toBe(alert);
      expect(alert.textContent).toContain("persist failed");
      // 按钮行在视口外时兜底滚动定位（jsdom 无原生 scrollIntoView，这里注入桩验证调用）。
      // 不锁定 rAF 回调总数（渲染期间其他调用方不受本用例约束），只对效果严格断言。
      expect(rafCallbacks.length).toBeGreaterThan(0);
      for (const callback of rafCallbacks.splice(0)) callback(0);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView.mock.calls[0]?.[0]).toMatchObject({ block: "nearest" });
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
    }
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

  it("pins the picker to the dynamic viewport and pads the footer for the home indicator", () => {
    // settings-1/home-10：footer 里是本页唯二主动作「连接/返回设置」，min-h-screen(100vh) 会把
    // 整段 footer 压到 iOS 工具栏之下；锁定 min-h-dvh，footer 内层消费 .zcode-safe-area-bottom
    // 垫高 home 指示条区域（spec §2.5，仅安全区场景）。
    const { container } = render(
      createElement(WebRemoteControlMobileBackendPicker, {
        backends,
        loading: false,
        onSelect: async () => {},
        onBackToSettings: () => {},
      }),
    );
    const section = container.querySelector('section[data-mobile-remote-page="backend-picker"]');
    expect(section?.className).toContain("min-h-dvh");
    expect(section?.className).not.toContain("min-h-screen");
    expect(container.querySelector("footer .zcode-safe-area-bottom")).toBeTruthy();
  });
});

describe("mobile start page and recent projects (375px)", () => {
  const recentProjects = [{ id: "recent-1", label: "zcode", location: "/Users/dev/SourceCode" }];

  // home-7 修复后 StartPage 订阅真实 transport 状态（仅 paired 视为已连接并启用打开动作）；
  // 模块级 store 默认 idle，本组用例在生产等价的 paired 状态下执行，结束后复位。
  beforeEach(() => {
    setWebRemoteControlTerminalTransportState("paired");
  });

  afterEach(() => {
    setWebRemoteControlTerminalTransportState("idle");
  });

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
    expect(screen.getByText("webRemoteControl.mobileStart.connected")).toBeTruthy();
    fireEvent.click(screen.getByText("webRemoteControl.mobileStart.openWindow"));
    expect(onOpenDesktopWindow).toHaveBeenCalledOnce();
  });

  it("reflects the real transport state in the subtitle and offers retry when disconnected", () => {
    // home-7：可恢复失败期间副标题不再固定显示「已连接」，并提供手动重试入口；
    // 打开动作禁用，避免点击后空转 12–15 秒才报超时。
    setWebRemoteControlTerminalTransportState("reconnecting");
    const onOpenDesktopWindow = vi.fn();
    const onRetryConnection = vi.fn();
    render(
      createElement(WebRemoteControlMobileStartPage, {
        desktopWindowState: "none",
        recentProjects,
        onOpenRecentProject: () => {},
        onOpenDesktopWindow,
        onRetryConnection,
        onOpenSettings: () => {},
      }),
    );

    expect(screen.getByText("webRemoteControl.mobileShell.reconnecting")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "common.retry" });
    expect(retry.className).toContain("min-h-11");
    fireEvent.click(retry);
    expect(onRetryConnection).toHaveBeenCalledOnce();
    const openWindow = screen.getByText("webRemoteControl.mobileStart.openWindow")
      .closest("button") as HTMLButtonElement | null;
    expect(openWindow?.disabled).toBe(true);
    expect(onOpenDesktopWindow).not.toHaveBeenCalled();
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

  it("renders an open failure inline in the failed row instead of above the list", () => {
    // home-9：打开失败的错误必须落在被点击的行内（视口内），
    // 不能渲染在列表上方——点列表中部行时那里很可能已在视口外。
    render(
      createElement(WebRemoteControlRecentProjectsSection, {
        desktopWindowState: "open",
        recentProjects,
        error: "desktop open failed",
        failedProjectId: "recent-1",
        onOpenRecentProject: () => {},
      }),
    );

    const row = screen.getByText("zcode").closest("button");
    expect(row?.textContent).toContain("desktop open failed");
    expect(row?.querySelector('[role="alert"]')?.textContent).toBe("desktop open failed");
  });

  it("falls back to the list-bottom alert when the failed project leaves the list", () => {
    render(
      createElement(WebRemoteControlMobileStartPage, {
        desktopWindowState: "open",
        recentProjects: [],
        error: "window open failed",
        onOpenRecentProject: () => {},
        onOpenDesktopWindow: () => {},
        onOpenSettings: () => {},
      }),
    );

    const alert = screen.getByRole("alert");
    // 全局提示在最近项目区之后（列表下方），而不是原先的列表上方。
    expect(
      alert.compareDocumentPosition(
        screen.getByText("webRemoteControl.mobileHome.recentProjectsEmpty"),
      ) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(alert.textContent).toBe("window open failed");
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
