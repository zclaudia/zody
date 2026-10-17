import type { GatewayBackendOptions, GatewayBackendState } from "@zclaudia/gateway-backend";
import {
  WEB_REMOTE_CONTROL_BACKEND_CAPABILITY,
  type RemoteAccessGatewayConnectionStatus,
} from "@zcode/shared";
import type {
  RemoteGatewayBackend,
  RemoteGatewayBackendConfig,
  RemoteGatewayBackendDependencies,
  RemoteGatewayBackendSdkLike,
  RemoteGatewayTestConnectionResult,
} from "./remoteGatewayBackendTypes.js";
import { createRemoteGatewayChannelHub } from "./remoteGatewayChannelHub.js";
import {
  defaultCreateBackend,
  isSameStatus,
  mapBackendError,
  resolveConfig,
} from "./remoteGatewayBackendSupport.js";

export type * from "./remoteGatewayBackendTypes.js";
export { sendRemoteGatewayChannelClose } from "./remoteGatewayBackendSupport.js";

/**
 * RemoteGatewayBackend —— 桌面 Main 中唯一的 gateway backend 连接所有者（T3.2）。
 *
 * 职责边界：
 * - 封装 `@zclaudia/gateway-backend`，自报 `zcode-remote-control` 能力位；
 * - 在 `connect()` 之前注册 `zcode-remote` kind handler（SDK 收到 channel_offer 时按 kind 查表，
 *   未注册会直接回 `channel_reject{no_handler}`）；
 * - 维护 `disabled | connecting | online | error(...)` 状态机，错误码映射自 SDK `lastError`；
 * - 配置变更走串行队列，连续变更合并为最新值；
 * - 「测试连接」的三条规则（复用、暂停后测试再恢复、有手机连接时禁用）；
 * - 从 backend `onMessage` 读取 `channel_closed.reason` 并转交上层。
 *
 * 不负责 channel 内的帧协议：`hello` 校验、版本协商、心跳和背压属于 T3.3 的
 * `GatewayDeviceTransport`。这里通过 `setChannelHandler` 同步转交 channel，transport 必须在
 * 第一个 `await` 之前注册 `onMessage` / `onClose`（SDK 不缓存帧）。
 */
export function createRemoteGatewayBackend(
  dependencies: RemoteGatewayBackendDependencies,
): RemoteGatewayBackend {
  const createBackend = dependencies.createBackend ?? defaultCreateBackend;
  const logger = dependencies.logger;

  let status: RemoteAccessGatewayConnectionStatus = { state: "disabled" };
  let disposed = false;
  let activeSdk: RemoteGatewayBackendSdkLike | undefined;
  let activeConfig: RemoteGatewayBackendConfig | undefined;
  let activeSignature: string | undefined;
  let pendingConfig: RemoteGatewayBackendConfig | undefined;
  let flushScheduled = false;
  const channelHub = createRemoteGatewayChannelHub(logger);
  const statusListeners = new Set<(status: RemoteAccessGatewayConnectionStatus) => void>();
  let queueTail: Promise<void> = Promise.resolve();

  function runSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = queueTail.then(task, task);
    queueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function setStatus(next: RemoteAccessGatewayConnectionStatus): void {
    if (isSameStatus(status, next)) {
      return;
    }
    status = next;
    // Array.from 快照：监听者在回调里取消订阅时不能影响本轮通知。
    for (const listener of Array.from(statusListeners)) {
      try {
        listener(next);
      } catch (error) {
        logger.warn("[remote-access] gateway status listener failed", error);
      }
    }
  }

  function handleSdkState(sdk: RemoteGatewayBackendSdkLike, state: GatewayBackendState): void {
    if (activeSdk !== sdk) {
      return;
    }
    switch (state) {
      case "connecting":
        if (status.state === "online") {
          logger.warn("[remote-access] gateway reconnecting", {
            backendId: sdk.id,
            epoch: sdk.currentEpoch,
          });
        }
        setStatus({ state: "connecting" });
        break;
      case "connected":
        setStatus({ state: "online", backendId: sdk.id, epoch: sdk.currentEpoch });
        logger.info("[remote-access] gateway connected", {
          backendId: sdk.id,
          epoch: sdk.currentEpoch,
        });
        break;
      case "closed": {
        const reason = mapBackendError(sdk.lastError);
        activeSdk = undefined;
        channelHub.clear();
        if (reason === "replaced") {
          logger.info("[remote-access] gateway backend replaced", {
            backendId: sdk.id,
            epoch: sdk.currentEpoch,
          });
          setStatus({ state: "error", reason });
        } else if (reason === "credential-invalid") {
          logger.info("[remote-access] gateway credential invalid", {
            code: sdk.lastError?.code,
          });
          setStatus({ state: "error", reason });
        } else if (reason) {
          logger.error("[remote-access] gateway connection closed", {
            code: sdk.lastError?.code,
          });
          setStatus({ state: "error", reason });
        } else {
          setStatus({ state: "disabled" });
        }
        sdk.close();
        break;
      }
      case "idle":
        setStatus({ state: "disabled" });
        break;
    }
  }

  function createSdk(config: ReturnType<typeof resolveConfig>): RemoteGatewayBackendSdkLike {
    const options: GatewayBackendOptions = {
      url: config.baseUrl,
      credential: config.credential ?? "",
      namespace: config.namespace,
      capabilities: [WEB_REMOTE_CONTROL_BACKEND_CAPABILITY],
      reconnect: true,
      // T3.3：transport 需要扣住数据 socket 读 bufferedAmount 做背压。
      ...(dependencies.socketFactory ? { socketFactory: dependencies.socketFactory } : {}),
    };
    const sdk = createBackend(options);
    sdk.onState((state) => handleSdkState(sdk, state));
    sdk.onMessage(channelHub.handleControlMessage);
    // 必须在拿到 channel_offer 之前注册（这里在 connect() 之前），且只注册这一个 kind：
    // 其余 kind 由 SDK 自动回 channel_reject{no_handler}。
    channelHub.registerKindHandler(sdk);
    return sdk;
  }

  function waitForClosed(sdk: RemoteGatewayBackendSdkLike): Promise<void> {
    if (sdk.connectionState === "closed") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const off = sdk.onState((state) => {
        if (state === "closed") {
          off();
          resolve();
        }
      });
    });
  }

  async function teardownActive(reason: string): Promise<void> {
    const sdk = activeSdk;
    activeSdk = undefined;
    // 配置变更/退出前先让手机看到 desktop-stopping，而不是一次「无故关闭」。
    channelHub.closeAllWithDesktopStopping();

    if (!sdk) {
      return;
    }
    const closed = waitForClosed(sdk);
    sdk.close();
    await closed;
    logger.info("[remote-access] gateway connection closed", { reason });
  }

  async function applyConfigNow(config: RemoteGatewayBackendConfig): Promise<void> {
    if (disposed) {
      return;
    }
    const resolved = resolveConfig(config, dependencies.allowInsecureTransport === true);
    if (activeSignature === resolved.signature) {
      // 只有 enabled/gatewayUrl/namespace/凭证真正变化才重连；其他设置保存不触发。
      return;
    }

    await teardownActive("config-change");
    activeConfig = config;
    activeSignature = resolved.signature;

    if (!resolved.complete) {
      if (resolved.enabled) {
        logger.warn(
          "[remote-access] remote access enabled but gateway configuration is incomplete",
        );
        setStatus({ state: "error", reason: "unconfigured" });
      } else {
        setStatus({ state: "disabled" });
      }
      return;
    }

    if (!resolved.enabled) {
      logger.info("[remote-access] remote access disabled");
      setStatus({ state: "disabled" });
      return;
    }

    const sdk = createSdk(resolved);
    activeSdk = sdk;
    setStatus({ state: "connecting" });
    try {
      const connection = await sdk.connect();
      if (activeSdk !== sdk) {
        return;
      }
      // 正常路径由 onState("connected") 写入并记录 info；这里兜底 fake/异常实现。
      setStatus({ state: "online", backendId: connection.backendId, epoch: connection.epoch });
    } catch {
      if (activeSdk !== sdk) {
        return;
      }
      const reason = mapBackendError(sdk.lastError) ?? "unreachable";
      activeSdk = undefined;
      setStatus({ state: "error", reason });
      if (reason === "credential-invalid") {
        logger.info("[remote-access] gateway credential invalid", { code: sdk.lastError?.code });
      } else if (reason === "replaced") {
        logger.info("[remote-access] gateway backend replaced", {
          backendId: sdk.id,
          epoch: sdk.currentEpoch,
        });
      } else {
        // 首次握手失败后 SDK 不会自动重连；这里对应方案里的 error 级别。
        logger.error("[remote-access] gateway connect failed", { code: sdk.lastError?.code });
      }
      sdk.close();
    }
  }

  function requestApply(config: RemoteGatewayBackendConfig): Promise<void> {
    pendingConfig = config;
    if (!flushScheduled) {
      flushScheduled = true;
      void runSerial(async () => {
        try {
          while (pendingConfig !== undefined) {
            const next = pendingConfig;
            pendingConfig = undefined;
            await applyConfigNow(next);
          }
        } finally {
          flushScheduled = false;
        }
      }).catch((error) => {
        logger.error("[remote-access] gateway configuration apply failed", error);
      });
    }
    return queueTail;
  }

  return {
    async reloadConfig(): Promise<void> {
      if (disposed) {
        return;
      }
      let config: RemoteGatewayBackendConfig;
      try {
        config = await dependencies.loadConfig();
      } catch (error) {
        // 设置/凭据读取失败是旁路故障：保留现有连接状态，不能让 void reload 变成未处理 rejection。
        logger.warn("[remote-access] failed to load gateway configuration", error);
        return;
      }
      if (disposed) {
        return;
      }
      await requestApply(config);
    },

    async applyConfig(config: RemoteGatewayBackendConfig): Promise<void> {
      if (disposed) {
        return;
      }
      await requestApply(config);
    },

    getStatus() {
      return status;
    },

    onStatusChanged(handler) {
      statusListeners.add(handler);
      return () => {
        statusListeners.delete(handler);
      };
    },

    setChannelHandler(handler) {
      channelHub.setHandler(handler);
    },

    hasConnectedClient() {
      return channelHub.hasConnectedClient();
    },

    onChannelClosed(handler) {
      return channelHub.onClosed(handler);
    },

    async testConnection(input): Promise<RemoteGatewayTestConnectionResult> {
      return runSerial(async () => {
        if (disposed) {
          return { ok: false, reason: "unconfigured" };
        }
        if (channelHub.hasConnectedClient()) {
          // 同一张 zgb_ 只允许一个进程在线；测试必然把手机正在用的 channel 拆掉。
          logger.warn("[remote-access] test connection rejected: mobile client is connected");
          return { ok: false, reason: "mobile-connected" };
        }

        const effectiveCredential = activeConfig?.credential?.trim() || undefined;
        const resolved = resolveConfig(
          {
            enabled: true,
            gatewayUrl: input.gatewayUrl,
            namespace: input.namespace,
            credential: input.credential?.trim() || effectiveCredential,
          },
          dependencies.allowInsecureTransport === true,
        );
        if (!resolved.complete) {
          return { ok: false, reason: "unconfigured" };
        }

        // 规则一：表单值与生效值完全一致且当前在线时，直接复用，不做任何重连（避免 epoch 换代）。
        if (
          activeConfig?.enabled === true &&
          activeSignature === resolved.signature &&
          activeSdk?.connectionState === "connected"
        ) {
          logger.info("[remote-access] test connection reused the active gateway connection");
          return { ok: true, status };
        }

        // 规则二：先暂停现有连接；测试连接必须先关闭，不能把它的 epoch 残留到恢复之后。
        await teardownActive("test-connection");
        const testSdk = createSdk(resolved);
        let result: RemoteGatewayTestConnectionResult;
        try {
          const connection = await testSdk.connect();
          result = {
            ok: true,
            status: { state: "online", backendId: connection.backendId, epoch: connection.epoch },
          };
          logger.info("[remote-access] test connection succeeded", {
            backendId: connection.backendId,
            epoch: connection.epoch,
          });
        } catch {
          const reason = mapBackendError(testSdk.lastError) ?? "unreachable";
          result = { ok: false, reason };
          logger.warn("[remote-access] test connection failed", {
            reason,
            code: testSdk.lastError?.code,
          });
        } finally {
          testSdk.close();
        }

        // 按上文第 3 步恢复：有排队中的新配置就用它，否则回到当前生效配置。
        const restore = pendingConfig ?? activeConfig;
        if (restore) {
          activeSignature = undefined;
          await applyConfigNow(restore);
        }
        return result;
      });
    },

    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      pendingConfig = undefined;

      // 退出屏障不能被进行中的握手拖住（SDK 握手超时是 10 秒）：先同步关闭当前 SDK，
      // 让 connect() 立刻以连接关闭失败返回，再走串行队列做一次幂等收尾。
      const sdk = activeSdk;
      activeSdk = undefined;
      channelHub.closeAllWithDesktopStopping();
      sdk?.close();

      try {
        await runSerial(async () => {
          await teardownActive("desktop-stopping");
          setStatus({ state: "disabled" });
        });
      } catch (error) {
        logger.warn("[remote-access] gateway dispose failed", error);
      }
    },
  };
}
