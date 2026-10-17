import { ipcMain } from "electron";
import {
  PlatformChannels,
  type RemoteAccessCredentialStatus,
  type RemoteAccessTestConnectionRequest,
  type RemoteAccessTestConnectionResult,
} from "@zcode/shared";

/**
 * T4.1：桌面设置页的远程访问 IPC 边界。
 *
 * 凭证「只写不读」：这里只暴露 `configured` 布尔状态，凭证本身只在 Main 的凭据服务
 * 与 gateway SDK 之间流转，不经过 renderer、IPC 返回值或日志。
 */
export interface RemoteAccessIpcDependencies {
  getCredentialStatus(): Promise<RemoteAccessCredentialStatus>;
  saveCredential(credential: string): Promise<void>;
  clearCredential(): Promise<void>;
  testConnection(
    input: RemoteAccessTestConnectionRequest,
  ): Promise<RemoteAccessTestConnectionResult>;
}

function parseTestConnectionRequest(value: unknown): RemoteAccessTestConnectionRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.gatewayUrl !== "string" || typeof record.namespace !== "string") {
    return null;
  }
  if (record.credential !== undefined && typeof record.credential !== "string") {
    return null;
  }
  const credential = typeof record.credential === "string" ? record.credential.trim() : "";
  return {
    gatewayUrl: record.gatewayUrl,
    namespace: record.namespace,
    ...(credential ? { credential } : {}),
  };
}

export function registerRemoteAccessIpcHandlers(dependencies: RemoteAccessIpcDependencies): void {
  ipcMain.handle(PlatformChannels.GetRemoteAccessCredentialStatus, () =>
    dependencies.getCredentialStatus(),
  );

  ipcMain.handle(PlatformChannels.SaveRemoteAccessCredential, async (_event, value: unknown) => {
    // 格式校验（`zgb_`/`zga_`）在凭据存储里统一执行；这里只拦掉明显非法的 IPC 载荷。
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("SaveRemoteAccessCredential expects a non-empty credential string");
    }
    await dependencies.saveCredential(value.trim());
  });

  ipcMain.handle(PlatformChannels.ClearRemoteAccessCredential, () =>
    dependencies.clearCredential(),
  );

  ipcMain.handle(PlatformChannels.TestRemoteAccessConnection, async (_event, value: unknown) => {
    const request = parseTestConnectionRequest(value);
    if (!request) {
      throw new Error("TestRemoteAccessConnection expects gatewayUrl and namespace strings");
    }
    return dependencies.testConnection(request);
  });
}
