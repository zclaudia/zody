import {
  EXTENSION_BRIDGE_DEFAULT_PORT,
  EXTENSION_BRIDGE_EXTENSION_ID,
} from "@zcode/shared/browser-extension-transport";
import type {
  ExtensionBridgeRequestMessage,
  ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";
import { HostMessageTypes } from "@zcode/shared";
import { ExtensionBridgeServer } from "./server.js";
import { createExtensionPersistentStores } from "./persistentStores.js";
import { beginWindowPairing, cancelWindowPairing } from "./pairingActions.js";
import { createExtensionBridgePortSwitcher } from "./portSwitcher.js";
import { createWindowDefaultBackends } from "./windowDefaults.js";
import {
  bindingVisibility,
  buildBridgeStatus,
  isProfileVisibleToWindow,
} from "./settingsStatus.js";
import {
  type ExtensionBridgeController,
  type ExtensionHostEndpoint,
  type ExtensionTransportHostRequest,
  type ExtensionTransportHostResult,
} from "./controllerTypes.js";
import {
  ExtensionBridgeError,
  type ExtensionBridgeConnectionInfo,
  type ExtensionBridgeLogger,
} from "./types.js";

export type {
  ExtensionBridgeController,
  ExtensionConnectionSnapshot,
  ExtensionHostEndpoint,
  ExtensionTransportHostRequest,
  ExtensionTransportHostResult,
} from "./controllerTypes.js";

const NOOP_LOGGER: ExtensionBridgeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Main 的扩展连接控制器。
 *
 * 只持有：ExtensionBridgeServer、window→Host 投递句柄、当前连接快照。tab/session/workspace
 * 业务状态全部留在 Host；这里不解析浏览器命令。
 */
export function createExtensionBridgeController(input: {
  userDataPath: string;
  expectedExtensionId?: string;
  logger?: ExtensionBridgeLogger;
  port?: number;
}): ExtensionBridgeController {
  const logger = input.logger ?? NOOP_LOGGER;
  const stores = createExtensionPersistentStores({ userDataPath: input.userDataPath });
  const hosts = new Map<number, ExtensionHostEndpoint>();
  /** Host 退出后正在作废旧 generation；新 Host 注册/请求必须等它完成。 */
  const hostInvalidations = new Map<number, Promise<void>>();
  /** 只在 connectionId 仍为当前连接时才能清除绑定/发 disconnected。 */
  const currentConnectionByProfile = new Map<string, { windowId: string; connectionId: string }>();
  let started = false;
  let startError: string | undefined;
  let configuredPort = input.port ?? EXTENSION_BRIDGE_DEFAULT_PORT;

  const createServer = () =>
    new ExtensionBridgeServer({
      expectedExtensionId: input.expectedExtensionId ?? EXTENSION_BRIDGE_EXTENSION_ID,
      credentialStore: stores.credentialStore,
      generationStore: stores.generationStore,
      logger,
      port: configuredPort,
      onAuthenticated: (info) => handleAuthenticated(info),
      onDisconnected: (info) => handleDisconnected(info),
      onExtensionMessage: (profileInstanceId, message) => {
        const binding = currentConnectionByProfile.get(profileInstanceId);
        if (!binding) return;
        postToWindow(binding.windowId, {
          type: "extension-event",
          profileInstanceId,
          message,
        });
      },
    });

  let server = createServer();

  const postToWindow = (windowId: string, message: unknown): void => {
    const numeric = Number(windowId);
    if (!Number.isSafeInteger(numeric)) return;
    hosts.get(numeric)?.postMessage(message);
  };

  const windowDefaults = createWindowDefaultBackends({
    publish: (windowId, defaultBrowserId) => {
      hosts.get(windowId)?.postMessage({
        type: HostMessageTypes.ExtensionDefaultBrowserChanged,
        ...(defaultBrowserId ? { defaultBrowserId } : {}),
      });
    },
    getCredential: (profileInstanceId) => stores.credentialStore.get(profileInstanceId),
    isBoundToCurrentWindow: (credential, windowId) =>
      bindingVisibility(credential, windowId, { isHostRegistered: (id) => hosts.has(id) }) ===
      "current-window",
  });

  const connectionChanged = (info: ExtensionBridgeConnectionInfo, connected: boolean): void => {
    if (!info.windowId) return;
    postToWindow(info.windowId, {
      type: "extension-connection-changed",
      profileInstanceId: info.profileInstanceId,
      connected,
      browserId: info.browserId,
      generation: info.generation,
      connectionId: info.connectionId,
      windowId: info.windowId,
    });
  };

  const handleAuthenticated = (info: ExtensionBridgeConnectionInfo): void => {
    if (!info.windowId) {
      logger.warn("[extension-bridge] authenticated profile has no window binding", {
        profileInstanceId: info.profileInstanceId,
      });
      return;
    }
    currentConnectionByProfile.set(info.profileInstanceId, {
      windowId: info.windowId,
      connectionId: info.connectionId,
    });
    connectionChanged(info, true);
  };

  const handleDisconnected = (disconnected: {
    profileInstanceId: string;
    connectionId: string;
    reason: string;
  }): void => {
    const binding = currentConnectionByProfile.get(disconnected.profileInstanceId);
    if (!binding) return;
    // 新握手替换旧 socket 时，旧连接 finalize 会晚于当前绑定出现。只有当前
    // connectionId 的断开才能撤销绑定；replaced 本身由随后的 authenticated 事件覆盖。
    if (binding.connectionId !== disconnected.connectionId) return;
    if (disconnected.reason === "replaced") return;
    currentConnectionByProfile.delete(disconnected.profileInstanceId);
    postToWindow(binding.windowId, {
      type: "extension-connection-changed",
      profileInstanceId: disconnected.profileInstanceId,
      connected: false,
      browserId: `extension:${disconnected.profileInstanceId}`,
      windowId: binding.windowId,
    });
  };

  const authenticatedInfo = (): ExtensionBridgeConnectionInfo[] => {
    return server.listConnectedProfiles().filter((info) => info.windowId !== "");
  };

  const isBoundToWindow = (
    info: ExtensionBridgeConnectionInfo | undefined,
    windowId: number,
  ): boolean => info !== undefined && info.windowId === String(windowId);

  const statusSource = {
    isStarted: () => started,
    get configuredPort() {
      return configuredPort;
    },
    get startError() {
      return startError;
    },
    listeningPort: () => server.getListeningPort(),
    listCredentials: () => stores.credentialStore.list(),
    getCredential: (profileInstanceId: string) => stores.credentialStore.get(profileInstanceId),
    isHostRegistered: (windowId: number) => hosts.has(windowId),
    getConnectionInfo: (profileInstanceId: string) => server.getConnectionInfo(profileInstanceId),
    getActivePairingForWindow: (windowId: string) => server.getActivePairingForWindow(windowId),
    getDefaultBrowserId: (windowId: number) => windowDefaults.get(windowId),
  };

  const switchPort = createExtensionBridgePortSwitcher({
    getServer: () => server,
    setServer: (next) => {
      server = next;
    },
    createServer,
    getConfiguredPort: () => configuredPort,
    setConfiguredPort: (port) => {
      configuredPort = port;
    },
    isStarted: () => started,
    setStarted: (next) => {
      started = next;
    },
    setStartError: (error) => {
      startError = error;
    },
    clearConnectionBindings: () => currentConnectionByProfile.clear(),
    logger,
  });

  return {
    async start() {
      if (started) return { ok: true, port: server.getListeningPort() };
      try {
        const { port } = await server.start();
        started = true;
        startError = undefined;
        return { ok: true, port };
      } catch (error) {
        startError = error instanceof Error ? error.message : String(error);
        logger.warn("[extension-bridge] unavailable", { error: startError });
        return { ok: false, error: startError };
      }
    },

    async stop() {
      await Promise.allSettled(hostInvalidations.values());
      hostInvalidations.clear();
      await server.stop();
      hosts.clear();
      currentConnectionByProfile.clear();
      windowDefaults.clearAll();
      started = false;
    },

    setPort: switchPort,

    getConfiguredPort() {
      return configuredPort;
    },

    registerHost(windowId, host) {
      hosts.set(windowId, host);
      const sendSnapshot = () => {
        if (hosts.get(windowId) !== host) return;
        for (const info of authenticatedInfo()) {
          if (info.windowId !== String(windowId)) continue;
          connectionChanged(info, true);
        }
      };
      // 正常的首次注册同步补发快照；只有 Host 退出作废旧 generation 未完成时才延后，
      // 保证重启后的新 Host 看到的是新 generation。
      const invalidation = hostInvalidations.get(windowId);
      if (!invalidation) {
        sendSnapshot();
        windowDefaults.publishCurrent(windowId);
        return;
      }
      void invalidation.then(() => {
        sendSnapshot();
        windowDefaults.publishCurrent(windowId);
      });
    },

    unregisterHost(windowId) {
      // Host 退出但 socket 仍在：Main 通知扩展释放全部 debugger，并立即作废旧 generation。
      // Host 进程自己的 pending/claim/lease 由它的 dispose 路径 settle。
      const invalidation = server
        .invalidateHostBinding(String(windowId))
        .catch((error: unknown) => {
          logger.warn("[extension-bridge] Host 退出作废 generation 失败", {
            windowId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      hostInvalidations.set(windowId, invalidation);
      void invalidation.finally(() => {
        if (hostInvalidations.get(windowId) === invalidation) hostInvalidations.delete(windowId);
      });
      hosts.delete(windowId);
    },

    async handleHostRequest(windowId, request) {
      await hostInvalidations.get(windowId);
      if (!started) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: startError ?? "extension bridge is not running",
          },
        };
      }
      if (request.op === "list") {
        return {
          ok: true,
          connections: authenticatedInfo()
            .filter((info) => info.windowId === String(windowId))
            .map((info) => ({
              profileInstanceId: info.profileInstanceId,
              browserId: info.browserId,
              generation: info.generation,
              connectionId: info.connectionId,
              windowId: info.windowId,
            })),
        };
      }
      const profileInstanceId = request.profileInstanceId;
      if (!profileInstanceId || !request.message) {
        return {
          ok: false,
          error: { code: "invalid_message", message: "profileInstanceId and message are required" },
        };
      }
      const connection = authenticatedInfo().find(
        (info) => info.profileInstanceId === profileInstanceId,
      );
      // 窗口绑定是 Main 的授权事实：非绑定窗口不能借 profileInstanceId 控制该 Profile。
      if (!isBoundToWindow(connection, windowId)) {
        return {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "extension profile is not connected to this window",
          },
        };
      }
      try {
        if (request.op === "send") {
          const sent = server.send(
            profileInstanceId,
            request.message as ExtensionBridgeServerMessage,
          );
          return sent
            ? { ok: true }
            : {
                ok: false,
                error: { code: "backend_unavailable", message: "extension is not connected" },
              };
        }
        const message = await server.request(
          profileInstanceId,
          request.message as ExtensionBridgeRequestMessage,
        );
        return { ok: true, message };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof ExtensionBridgeError ? error.code : "internal_error",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },

    beginPairing(windowId) {
      return beginWindowPairing(server, windowId);
    },

    cancelPairing(windowId, pairingSessionId) {
      cancelWindowPairing(server, windowId, pairingSessionId);
    },

    async getStatus(windowId) {
      return await buildBridgeStatus(statusSource, windowId);
    },

    async setDefaultBrowserId(windowId, browserId) {
      return await windowDefaults.set(windowId, browserId);
    },

    async listCredentials() {
      return await stores.credentialStore.list();
    },

    async revokeProfile(profileInstanceId) {
      await server.revokeProfile(profileInstanceId);
      windowDefaults.clearProfile(profileInstanceId);
      await stores.flush();
    },

    async revokeProfileForWindow(profileInstanceId, windowId) {
      if (!(await isProfileVisibleToWindow(statusSource, profileInstanceId, windowId))) {
        return { ok: false, error: "profile is not visible to this window" };
      }
      await this.revokeProfile(profileInstanceId);
      return { ok: true };
    },

    async transferProfile(profileInstanceId, targetWindowId) {
      if (!started) {
        return { ok: false, error: "extension bridge is not running" };
      }
      await hostInvalidations.get(targetWindowId);
      if (!hosts.has(targetWindowId)) {
        return { ok: false, error: "target window Host is not registered" };
      }
      const previous = server.getConnectionInfo(profileInstanceId);
      try {
        if (!previous) {
          // 离线 Profile 没有可失效的旧连接；只改持久绑定，下一次重连握手读取新窗口。
          const credential = await stores.credentialStore.get(profileInstanceId);
          if (!credential) return { ok: false, error: "extension profile is not paired" };
          await stores.credentialStore.set({
            ...credential,
            windowId: String(targetWindowId),
          });
          windowDefaults.clearProfile(profileInstanceId);
          await stores.flush();
          return { ok: true };
        }
        const info = await server.transferBinding(profileInstanceId, String(targetWindowId));
        currentConnectionByProfile.set(profileInstanceId, {
          windowId: info.windowId,
          connectionId: info.connectionId,
        });
        // 先让旧窗口失效，再把新 binding 投递给目标窗口；顺序不能反转。
        if (previous.windowId && previous.windowId !== info.windowId) {
          postToWindow(previous.windowId, {
            type: "extension-connection-changed",
            profileInstanceId,
            connected: false,
            browserId: previous.browserId,
            generation: previous.generation,
            connectionId: previous.connectionId,
            windowId: previous.windowId,
          });
        }
        connectionChanged(info, true);
        // 旧窗口默认随绑定失效一起清除；目标窗口不继承，需要用户显式重选。
        windowDefaults.clearProfile(profileInstanceId);
        await stores.flush();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async transferProfileToWindow(profileInstanceId, targetWindowId) {
      if (!(await isProfileVisibleToWindow(statusSource, profileInstanceId, targetWindowId))) {
        return { ok: false, error: "profile is not visible to this window" };
      }
      return await this.transferProfile(profileInstanceId, targetWindowId);
    },

    disconnectProfile(profileInstanceId, reason) {
      server.disconnect(profileInstanceId, reason);
    },
  };
}
