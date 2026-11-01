import type { ExtensionBridgeServer } from "./server.js";
import type { ExtensionBridgeLogger } from "./types.js";

export interface ExtensionBridgePortRuntime {
  getServer(): ExtensionBridgeServer;
  setServer(server: ExtensionBridgeServer): void;
  createServer(): ExtensionBridgeServer;
  getConfiguredPort(): number;
  setConfiguredPort(port: number): void;
  isStarted(): boolean;
  setStarted(started: boolean): void;
  setStartError(error: string | undefined): void;
  clearConnectionBindings(): void;
  logger: ExtensionBridgeLogger;
}

/**
 * 端口切换的唯一实现：先停旧监听，再在新端口启动；失败时恢复旧端口。
 * 不扫描其他端口，也不在失败时保留半切换状态。
 */
export function createExtensionBridgePortSwitcher(runtime: ExtensionBridgePortRuntime) {
  return async function setPort(
    port: number,
  ): Promise<{ ok: boolean; port?: number; error?: string }> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, error: "invalid_bridge_port" };
    }
    if (port === runtime.getConfiguredPort() && runtime.isStarted()) {
      return { ok: true, port: runtime.getServer().getListeningPort() };
    }
    const previousPort = runtime.getConfiguredPort();
    // 先停旧监听，端口切换不能同时监听两个端口；连接被关闭时扩展按新端口重连。
    await runtime.getServer().stop();
    runtime.clearConnectionBindings();
    runtime.setConfiguredPort(port);
    runtime.setServer(runtime.createServer());
    try {
      const result = await runtime.getServer().start();
      runtime.setStarted(true);
      runtime.setStartError(undefined);
      runtime.logger.info("[extension-bridge] port changed", { port: result.port });
      return { ok: true, port: result.port };
    } catch (error) {
      const startError = error instanceof Error ? error.message : String(error);
      runtime.setStartError(startError);
      runtime.logger.warn("[extension-bridge] port change failed", { port, error: startError });
      // 新端口占用时恢复旧监听，避免一次错误配置让整个 backend 永久不可用。
      runtime.setConfiguredPort(previousPort);
      runtime.setServer(runtime.createServer());
      try {
        await runtime.getServer().start();
        runtime.setStarted(true);
      } catch (restoreError) {
        runtime.setStarted(false);
        runtime.logger.error("[extension-bridge] failed to restore previous port", {
          port: previousPort,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }
      return { ok: false, error: startError };
    }
  };
}
