import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  PlatformChannels,
  type BrowserExtensionActionResult,
  type BrowserExtensionBridgeStatus,
  type BrowserExtensionPairingTicket,
} from "@zody/shared";
import { EXTENSION_BRIDGE_DEFAULT_PORT } from "@zody/shared/browser-extension-transport";
import type { ExtensionBridgeController } from "./extensionBridge/index.js";

export interface DesktopBrowserExtensionIpcDeps {
  getController(): ExtensionBridgeController | null;
  /** Main 是端口运行时所有者：先重启成功，再持久化设置并广播。 */
  setBridgePort(port: number): Promise<BrowserExtensionActionResult>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/** 打包态用 resources/browser-extension；开发态指向仓库构建产物，绝不伪造安装成功。 */
export function resolveBrowserExtensionInstallDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "browser-extension")
    : resolve(app.getAppPath(), "..", "browser-extension", "dist");
}

async function installDirectoryStatus(): Promise<{
  installDirectory: string;
  installDirectoryAvailable: boolean;
}> {
  const installDirectory = resolveBrowserExtensionInstallDirectory();
  try {
    await access(installDirectory);
    return { installDirectory, installDirectoryAvailable: true };
  } catch {
    return { installDirectory, installDirectoryAvailable: false };
  }
}

function windowIdForSender(sender: WebContents): number | null {
  return BrowserWindow.fromWebContents(sender)?.id ?? null;
}

function emptyStatus(error: string): BrowserExtensionBridgeStatus {
  return {
    available: false,
    port: null,
    configuredPort: EXTENSION_BRIDGE_DEFAULT_PORT,
    profiles: [],
    error,
  };
}

export function registerDesktopBrowserExtensionIpc(deps: DesktopBrowserExtensionIpcDeps): void {
  ipcMain.handle(PlatformChannels.GetBrowserExtensionStatus, async (event) => {
    const controller = deps.getController();
    const install = await installDirectoryStatus();
    const windowId = windowIdForSender(event.sender);
    if (!controller) {
      return { ...emptyStatus("extension bridge is not initialized"), ...install };
    }
    if (windowId === null) {
      return { ...emptyStatus("no application window for the request"), ...install };
    }
    return { ...(await controller.getStatus(windowId)), ...install };
  });

  ipcMain.handle(
    PlatformChannels.BeginBrowserExtensionPairing,
    (event): BrowserExtensionPairingTicket | null => {
      const controller = deps.getController();
      const windowId = windowIdForSender(event.sender);
      if (!controller || windowId === null) return null;
      return controller.beginPairing(windowId);
    },
  );

  ipcMain.handle(
    PlatformChannels.CancelBrowserExtensionPairing,
    (event, pairingSessionId: unknown): void => {
      const controller = deps.getController();
      const windowId = windowIdForSender(event.sender);
      if (!controller || windowId === null || typeof pairingSessionId !== "string") return;
      controller.cancelPairing(windowId, pairingSessionId);
    },
  );

  ipcMain.handle(
    PlatformChannels.SetBrowserExtensionDefaultBackend,
    async (event, browserId: unknown): Promise<BrowserExtensionActionResult> => {
      const controller = deps.getController();
      const windowId = windowIdForSender(event.sender);
      if (!controller || windowId === null) {
        return { ok: false, error: "extension bridge is not initialized" };
      }
      if (browserId !== null && (typeof browserId !== "string" || !browserId.trim())) {
        return { ok: false, error: "invalid_browser_id" };
      }
      const result = await controller.setDefaultBrowserId(
        windowId,
        typeof browserId === "string" ? browserId.trim() : null,
      );
      if (result.ok) {
        deps.logger.info("[extension-bridge] window default backend updated", {
          windowId,
          defaultBrowserId: typeof browserId === "string" ? browserId.trim() : null,
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    PlatformChannels.RevokeBrowserExtensionProfile,
    async (event, profileInstanceId: unknown): Promise<BrowserExtensionActionResult> => {
      const controller = deps.getController();
      const windowId = windowIdForSender(event.sender);
      if (!controller || windowId === null) {
        return { ok: false, error: "extension bridge is not initialized" };
      }
      if (typeof profileInstanceId !== "string" || !profileInstanceId.trim()) {
        return { ok: false, error: "invalid_profile_instance_id" };
      }
      const result = await controller.revokeProfileForWindow(profileInstanceId, windowId);
      if (result.ok) {
        deps.logger.info("[extension-bridge] profile pairing revoked from settings", {
          profileInstanceId,
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    PlatformChannels.TransferBrowserExtensionProfile,
    async (event, profileInstanceId: unknown): Promise<BrowserExtensionActionResult> => {
      const controller = deps.getController();
      const windowId = windowIdForSender(event.sender);
      if (!controller || windowId === null) {
        return { ok: false, error: "extension bridge is not initialized" };
      }
      if (typeof profileInstanceId !== "string" || !profileInstanceId.trim()) {
        return { ok: false, error: "invalid_profile_instance_id" };
      }
      const result = await controller.transferProfileToWindow(profileInstanceId, windowId);
      if (result.ok) {
        deps.logger.info("[extension-bridge] profile transferred from settings", {
          profileInstanceId,
          windowId,
        });
      } else {
        deps.logger.warn("[extension-bridge] profile transfer rejected", {
          profileInstanceId,
          windowId,
          error: result.error,
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    PlatformChannels.SetBrowserExtensionBridgePort,
    async (_event, port: unknown): Promise<BrowserExtensionActionResult> => {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
        return { ok: false, error: "invalid_bridge_port" };
      }
      return await deps.setBridgePort(port);
    },
  );
}
