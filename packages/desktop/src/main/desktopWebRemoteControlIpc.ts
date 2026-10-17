import { ipcMain } from "electron";
import {
  PlatformChannels,
  type RemoteAccessStatus,
  type WebRemoteControlStatus,
} from "@zcode/shared";

export interface WebRemoteControlIpcManager {
  /** App 级状态（状态查询 IPC）。 */
  getStatus(): WebRemoteControlStatus;
  /** 新 IPC：设置远程访问总开关并启停唯一 runtime。 */
  setRemoteAccessEnabled(enabled: boolean): Promise<void>;
  /** 新 IPC：断开当前手机。 */
  disconnectRemoteClient(): void | Promise<void>;
  /** 新 IPC：查询 App 级远程访问状态。 */
  getRemoteAccessStatus(): Promise<RemoteAccessStatus>;
}

interface WebRemoteControlIpcDependencies {
  webRemoteControlManager: WebRemoteControlIpcManager;
}

export function registerWebRemoteControlIpcHandlers(
  dependencies: WebRemoteControlIpcDependencies,
): void {
  // 旧窗口级 Start/Stop/Refresh/Reset IPC 已随 relay 配对体系删除（T5.1）；
  // 启停统一走远程访问开关，状态由 Main 广播给所有窗口。
  ipcMain.handle(PlatformChannels.GetWebRemoteControlStatus, () =>
    dependencies.webRemoteControlManager.getStatus(),
  );

  ipcMain.handle(PlatformChannels.SetRemoteAccessEnabled, async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("SetRemoteAccessEnabled expects a boolean");
    }
    await dependencies.webRemoteControlManager.setRemoteAccessEnabled(enabled);
  });

  ipcMain.handle(PlatformChannels.DisconnectRemoteClient, async () => {
    await dependencies.webRemoteControlManager.disconnectRemoteClient();
  });

  ipcMain.handle(PlatformChannels.GetRemoteAccessStatus, () =>
    dependencies.webRemoteControlManager.getRemoteAccessStatus(),
  );
}
