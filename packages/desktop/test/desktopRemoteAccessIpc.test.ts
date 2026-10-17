import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import { registerRemoteAccessIpcHandlers } from "../src/main/desktopRemoteAccessIpc.js";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  },
}));

function createDependencies() {
  return {
    getCredentialStatus: vi.fn(async () => ({ configured: true })),
    saveCredential: vi.fn(async () => {}),
    clearCredential: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({
      ok: true as const,
      status: { state: "online" as const },
    })),
  };
}

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = h.handlers.get(channel);
  if (!handler) {
    throw new Error(`missing handler for ${channel}`);
  }
  return handler({}, ...args);
}

describe("desktop remote access IPC", () => {
  beforeEach(() => {
    h.handlers.clear();
  });

  it("注册设置页需要的四个远程访问 channel", () => {
    registerRemoteAccessIpcHandlers(createDependencies());

    expect(Array.from(h.handlers.keys())).toEqual([
      PlatformChannels.GetRemoteAccessCredentialStatus,
      PlatformChannels.SaveRemoteAccessCredential,
      PlatformChannels.ClearRemoteAccessCredential,
      PlatformChannels.TestRemoteAccessConnection,
    ]);
  });

  it("凭证状态只返回 configured，不返回凭证本身", async () => {
    const dependencies = createDependencies();
    registerRemoteAccessIpcHandlers(dependencies);

    await expect(invoke(PlatformChannels.GetRemoteAccessCredentialStatus)).resolves.toEqual({
      configured: true,
    });
  });

  it("保存凭证前 trim，并拒绝空载荷", async () => {
    const dependencies = createDependencies();
    registerRemoteAccessIpcHandlers(dependencies);

    await invoke(PlatformChannels.SaveRemoteAccessCredential, "  zgb_test  ");
    expect(dependencies.saveCredential).toHaveBeenCalledWith("zgb_test");

    await expect(invoke(PlatformChannels.SaveRemoteAccessCredential, "   ")).rejects.toThrow();
    await expect(invoke(PlatformChannels.SaveRemoteAccessCredential, 42)).rejects.toThrow();
    expect(dependencies.saveCredential).toHaveBeenCalledTimes(1);
  });

  it("清除凭证转交 Main 凭据服务", async () => {
    const dependencies = createDependencies();
    registerRemoteAccessIpcHandlers(dependencies);

    await invoke(PlatformChannels.ClearRemoteAccessCredential);
    expect(dependencies.clearCredential).toHaveBeenCalledOnce();
  });

  it("测试连接校验表单字段并省略空凭证", async () => {
    const dependencies = createDependencies();
    registerRemoteAccessIpcHandlers(dependencies);

    await invoke(PlatformChannels.TestRemoteAccessConnection, {
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
      credential: "  ",
    });
    expect(dependencies.testConnection).toHaveBeenCalledWith({
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
    });

    await expect(
      invoke(PlatformChannels.TestRemoteAccessConnection, { gatewayUrl: 1 }),
    ).rejects.toThrow();
    await expect(invoke(PlatformChannels.TestRemoteAccessConnection, null)).rejects.toThrow();
  });
});
