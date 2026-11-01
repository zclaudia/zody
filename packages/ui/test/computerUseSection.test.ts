// ComputerUseSection 能力驱动呈现的首个组件测试（specs/computer-use-settings-unification.md）：
// - 占位构建：整卡说明「此构建不含电脑控制」，不渲染总开关与权限行；
// - narrow 构建：渲染能力边界说明与总开关（插件启用态）。
// intl mock 直接回显 message id，断言用 id 字符串定位。
// @vitest-environment jsdom
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { CuaBuildCapability } from "@zcode/shared";

const h = vi.hoisted(() => {
  let capability: CuaBuildCapability = { kind: "placeholder" };
  const executeDesktopCommand = vi.fn((commandId: string) => {
    if (commandId === "getCuaCapability") return Promise.resolve(capability);
    if (commandId === "getCuaOsSupport") return Promise.resolve({ kind: "supported" });
    return Promise.resolve(undefined);
  });
  const pluginState = {
    plugins: [
      {
        id: "computer-use@zcode-plugins-official",
        name: "computer-use",
        enabled: true,
      },
    ],
    loading: false,
    error: null as string | null,
    togglingPluginId: null as string | null,
    initialize: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
  };
  return { capability, executeDesktopCommand, pluginState, setCapability: (next: CuaBuildCapability) => { capability = next; } };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: h.executeDesktopCommand,
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    pluginManagementService: {},
    cuaPermissionService: {},
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: {},
    loading: false,
    error: null,
    update: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: typeof h.pluginState) => unknown) =>
    selector(h.pluginState),
}));

import { ComputerUseSection } from "../src/settings/ComputerUseSection.js";

beforeEach(() => {
  cleanup();
  h.executeDesktopCommand.mockClear();
  h.pluginState.initialize.mockClear();
});

function renderSection() {
  return render(
    createElement(ComputerUseSection, {
      isMacDesktop: true,
      workspacePath: "/tmp/zody-workspace",
      workspaceIdentity: "/tmp/zody-workspace",
    }),
  );
}

describe("ComputerUseSection 能力驱动呈现", () => {
  it("占位构建：渲染构建不可用说明卡，不渲染总开关与输入框入口开关", async () => {
    h.setCapability({ kind: "placeholder" });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("settings.computerUse.buildUnavailable.title")).toBeTruthy();
    });
    expect(screen.getByText("settings.computerUse.buildUnavailable.description")).toBeTruthy();
    expect(screen.queryByText("settings.computerUse.toggleLabel")).toBeNull();
    expect(screen.queryByText("settings.computerUse.composerEntry.label")).toBeNull();
    // 占位构建不初始化插件列表、不查询 macOS 版本门槛与权限状态。
    expect(h.pluginState.initialize).not.toHaveBeenCalled();
    expect(h.executeDesktopCommand).not.toHaveBeenCalledWith("getCuaOsSupport");
  });

  it("narrow 构建：渲染能力边界说明与总开关，权限区为说明性信息而非状态行", async () => {
    h.setCapability({ kind: "narrow", capabilities: ["screenshot.single-window"] });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("settings.computerUse.narrowCapabilityDescription")).toBeTruthy();
    });
    expect(screen.getByText("settings.computerUse.toggleLabel")).toBeTruthy();
    expect(screen.getByText("settings.computerUse.composerEntry.label")).toBeTruthy();
    // narrow + macOS 查询版本门槛；权限区只剩「屏幕录制」说明行——旧 Helper 的
    // Accessibility 状态行、授权按钮与重启链已随占位实现移除（其底层恒 fail-closed）。
    await waitFor(() => {
      expect(h.executeDesktopCommand).toHaveBeenCalledWith("getCuaOsSupport");
    });
    expect(screen.getByText("settings.computerUse.narrowPermissionNote")).toBeTruthy();
    expect(screen.getByText("cuaPermission.perm.screenRecording")).toBeTruthy();
    expect(screen.queryByText("cuaPermission.perm.accessibility")).toBeNull();
  });

  it("能力信号在途时不渲染任何形态（宁空勿错）", () => {
    h.setCapability({ kind: "placeholder" });
    // 让 GetCuaCapability 永远 pending：首帧 capability 为 null。
    h.executeDesktopCommand.mockImplementation(
      (commandId: string) =>
        new Promise((resolve) => {
          if (commandId === "getCuaCapability") return;
          if (commandId === "getCuaOsSupport") resolve({ kind: "supported" });
          resolve(undefined);
        }),
    );
    renderSection();

    expect(screen.queryByText("settings.computerUse.buildUnavailable.title")).toBeNull();
    expect(screen.queryByText("settings.computerUse.toggleLabel")).toBeNull();
  });

  it("GetCuaCapability 查询失败按占位呈现（fail-closed）", async () => {
    h.executeDesktopCommand.mockImplementation((commandId: string) => {
      if (commandId === "getCuaCapability") return Promise.reject(new Error("ipc down"));
      return Promise.resolve({ kind: "supported" });
    });
    renderSection();

    await waitFor(() => {
      expect(screen.getByText("settings.computerUse.buildUnavailable.title")).toBeTruthy();
    });
    expect(screen.queryByText("settings.computerUse.toggleLabel")).toBeNull();
  });
});
