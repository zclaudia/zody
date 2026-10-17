import { GatewayClient, type GatewayDiscoveryBackend } from "@zclaudia/gateway-client";
import type { BackendPresenceV4 } from "@zclaudia/gateway-protocol";
import {
  WEB_REMOTE_CONTROL_BACKEND_CAPABILITY,
  type RemoteAccessMobileBackendOption,
  type WebRemoteControlFailure,
} from "@zcode/shared";

/**
 * 选电脑页的数据源（T4.2）。
 *
 * 方案「产品规则 · 手机」：先用 `discoverBackends` 列出设备凭证可见的电脑，再结合 registry
 * 的 `capabilities` 判断是否支持 ZCode 远控。discovery 不返回 capabilities，registry 是
 * liveness 视图（离线电脑不在里面），所以：
 * - 在线且 registry 明确缺少 `zcode-remote-control` → `supported: false`，列表置灰；
 * - 离线电脑保留可选项，等它上线后由 registry 更新能力位；
 * - `channel_reject` 不作为终态依据，交给 transport。
 *
 * 控制连接只用于拿到 registry；选中电脑后由 `GatewayTerminalTransport` 自己建连。
 */

export type MobileRemoteBackendDiscoveryFailureReason =
  | "gateway-unreachable"
  | "gateway-credential-invalid";

export type MobileRemoteBackendOption = RemoteAccessMobileBackendOption;

export interface MobileRemoteBackendDiscoverySnapshot {
  loading: boolean;
  backends: MobileRemoteBackendOption[];
  failure?: WebRemoteControlFailure;
}

/** 生产实现只需要 SDK 的这几个成员，fake 不必实现完整 GatewayClient。 */
export interface MobileRemoteDiscoveryClientLike {
  readonly registry: BackendPresenceV4[];
  onRegistry(handler: (items: BackendPresenceV4[]) => void): () => void;
  connect(): Promise<void>;
  close(): void;
  discoverBackends(): Promise<GatewayDiscoveryBackend[]>;
}

export interface MobileRemoteBackendDiscoveryOptions {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  createClient?: (options: {
    url: string;
    namespace: string;
    credential: string;
    reconnect: boolean;
  }) => MobileRemoteDiscoveryClientLike;
  onUpdate(snapshot: MobileRemoteBackendDiscoverySnapshot): void;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCredentialError(error: unknown): boolean {
  return /UNAUTHORIZED|FORBIDDEN|HTTP 40[13]|\b40[13]\b/i.test(readErrorMessage(error));
}

function createFailure(
  reason: MobileRemoteBackendDiscoveryFailureReason,
  message: string,
): WebRemoteControlFailure {
  return { reason, message };
}

/** registry 里在线且带能力位才认为支持远控；discovery 单独返回时能力未知，先按支持处理。 */
function mergeBackends(
  discovered: GatewayDiscoveryBackend[],
  registry: BackendPresenceV4[],
): MobileRemoteBackendOption[] {
  const merged = new Map<string, MobileRemoteBackendOption>();
  for (const backend of discovered) {
    merged.set(backend.backendId, {
      backendId: backend.backendId,
      name: backend.name?.trim() || backend.backendId,
      online: backend.online,
      supported: true,
      lastSeenAt: backend.lastSeenAt,
    });
  }
  for (const presence of registry) {
    const existing = merged.get(presence.backendId);
    merged.set(presence.backendId, {
      backendId: presence.backendId,
      name: presence.name?.trim() || existing?.name || presence.backendId,
      online: true,
      supported: presence.capabilities.includes(WEB_REMOTE_CONTROL_BACKEND_CAPABILITY),
      lastSeenAt: presence.lastSeenAt ?? existing?.lastSeenAt ?? null,
    });
  }
  return [...merged.values()].sort((left, right) => {
    if (left.supported !== right.supported) {
      return left.supported ? -1 : 1;
    }
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * 启动一次选电脑页的发现流程。返回的 disposer 会关闭控制连接。
 * 控制连接断开不影响已拿到的 discovery 列表；registry 更新会继续合并。
 */
export function startMobileRemoteBackendDiscovery(
  options: MobileRemoteBackendDiscoveryOptions,
): () => void {
  let disposed = false;
  let discovered: GatewayDiscoveryBackend[] = [];
  let registry: BackendPresenceV4[] = [];
  // discovery 与 registry 控制连接是两条独立通道：一条成功不能清掉另一条的失败。
  // 凭证无效优先于网络错误，因为它是终态且需要用户改设置。
  let discoveryFailure: WebRemoteControlFailure | undefined;
  let connectionFailure: WebRemoteControlFailure | undefined;
  let loading = true;

  const currentFailure = (): WebRemoteControlFailure | undefined => {
    if (
      discoveryFailure?.reason === "gateway-credential-invalid" ||
      connectionFailure?.reason === "gateway-credential-invalid"
    ) {
      return discoveryFailure?.reason === "gateway-credential-invalid"
        ? discoveryFailure
        : connectionFailure;
    }
    return connectionFailure ?? discoveryFailure;
  };

  const emit = () => {
    if (disposed) {
      return;
    }
    const failure = currentFailure();
    options.onUpdate({
      loading,
      backends: mergeBackends(discovered, registry),
      ...(failure ? { failure } : {}),
    });
  };

  let client: MobileRemoteDiscoveryClientLike;
  try {
    client =
      options.createClient?.({
        url: options.gatewayUrl,
        namespace: options.namespace,
        credential: options.credential,
        reconnect: true,
      }) ??
      new GatewayClient({
        url: options.gatewayUrl,
        namespace: options.namespace,
        credential: options.credential,
        reconnect: true,
        reconnectMinMs: 1_000,
        reconnectMaxMs: 30_000,
      });
  } catch (error) {
    options.onUpdate({
      loading: false,
      backends: [],
      failure: createFailure("gateway-unreachable", readErrorMessage(error)),
    });
    return () => {};
  }

  const unsubscribeRegistry = client.onRegistry((items) => {
    registry = items;
    emit();
  });

  /**
   * 控制连接只负责 registry。连接失败时 discovery 列表仍然可用；
   * 只有凭证确实被拒（401/403/UNAUTHORIZED）才进入终态。
   */
  const connectForRegistry = async () => {
    try {
      await client.connect();
      connectionFailure = undefined;
    } catch (error) {
      if (disposed) {
        return;
      }
      connectionFailure = createFailure(
        isCredentialError(error) ? "gateway-credential-invalid" : "gateway-unreachable",
        readErrorMessage(error),
      );
      emit();
    }
  };

  const discover = async () => {
    try {
      discovered = await client.discoverBackends();
      discoveryFailure = undefined;
    } catch (error) {
      if (disposed) {
        return;
      }
      discoveryFailure = createFailure(
        isCredentialError(error) ? "gateway-credential-invalid" : "gateway-unreachable",
        readErrorMessage(error),
      );
    } finally {
      if (!disposed) {
        loading = false;
        emit();
      }
    }
  };

  void discover();
  void connectForRegistry();

  return () => {
    disposed = true;
    unsubscribeRegistry();
    client.close();
  };
}
