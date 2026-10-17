import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  },
}));

function createManager(
  options: {
    getStatus?: () => unknown;
    setRemoteAccessEnabled?: (enabled: boolean) => Promise<void>;
    disconnectRemoteClient?: () => void;
    getRemoteAccessStatus?: () => Promise<unknown>;
  } = {},
) {
  return {
    getStatus: options.getStatus ?? vi.fn(() => ({ status: "idle" })),
    setRemoteAccessEnabled: options.setRemoteAccessEnabled ?? vi.fn(async () => {}),
    disconnectRemoteClient: options.disconnectRemoteClient ?? vi.fn(),
    getRemoteAccessStatus:
      options.getRemoteAccessStatus ??
      vi.fn(async () => ({ enabled: false, status: { status: "idle" } })),
  };
}

describe("Web Remote Control IPC", () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it("旧窗口级启停 IPC 已删除，只保留状态查询", async () => {
    const getStatus = vi.fn(() => ({ status: "active" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: createManager({ getStatus }),
    });

    expect(h.handlers.has("zcode:start-web-remote-control")).toBe(false);
    expect(h.handlers.has("zcode:reset-web-remote-control-pairing")).toBe(false);
    expect(h.handlers.has("zcode:stop-web-remote-control")).toBe(false);
    expect(
      h.handlers.get(PlatformChannels.GetWebRemoteControlStatus)?.({ sender: { id: 1 } }),
    ).toEqual({ status: "active" });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("设置远程访问开关并转调 App 级 runtime", async () => {
    const setRemoteAccessEnabled = vi.fn(async () => {});
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: createManager({ setRemoteAccessEnabled }),
    });

    await h.handlers.get(PlatformChannels.SetRemoteAccessEnabled)?.({ sender: { id: 80 } }, true);

    expect(setRemoteAccessEnabled).toHaveBeenCalledWith(true);
    // 布尔值之外的载荷必须拒绝，避免把任意 IPC 值当成开关。
    await expect(
      h.handlers.get(PlatformChannels.SetRemoteAccessEnabled)?.({ sender: { id: 80 } }, "true"),
    ).rejects.toThrow("boolean");
  });

  it("断开手机与查询 App 级状态不依赖发送窗口", async () => {
    const disconnectRemoteClient = vi.fn();
    const getRemoteAccessStatus = vi.fn(async () => ({
      enabled: true,
      status: { status: "active" as const },
    }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      webRemoteControlManager: createManager({
        disconnectRemoteClient,
        getRemoteAccessStatus,
      }),
    });

    await h.handlers.get(PlatformChannels.DisconnectRemoteClient)?.({ sender: { id: 81 } });
    await expect(
      h.handlers.get(PlatformChannels.GetRemoteAccessStatus)?.({ sender: { id: 81 } }),
    ).resolves.toEqual({ enabled: true, status: { status: "active" } });

    expect(disconnectRemoteClient).toHaveBeenCalledOnce();
    expect(getRemoteAccessStatus).toHaveBeenCalledOnce();
  });
});
