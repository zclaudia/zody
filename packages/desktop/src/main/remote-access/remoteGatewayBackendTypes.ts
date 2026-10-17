import type {
  BackendErrorInfo,
  GatewayBackendOptions,
  GatewayBackendState,
} from "@zclaudia/gateway-backend";
import type {
  RemoteAccessGatewayConnectionErrorReason,
  RemoteAccessGatewayConnectionStatus,
} from "@zcode/shared";

/**
 * RemoteGatewayBackend 的公共契约与 SDK 抽象。
 *
 * 单独拆文件是为了让 `remoteGatewayBackend.ts` 只保留连接生命周期（lint max-lines），
 * 外部仍从 `remoteGatewayBackend.js` 导入这些类型（那边 `export type *` 转发）。
 */

/** 桌面侧生效配置的四要素；只有这几项真正变化才触发重连。 */
export interface RemoteGatewayBackendConfig {
  enabled: boolean;
  gatewayUrl: string;
  namespace: string;
  /** backend 凭证（`zgb_` / `zga_`）。只进 SDK，不进日志。 */
  credential?: string;
}

export interface RemoteGatewayChannelOffer {
  channelId: string;
  kind?: string;
  sourcePeerSessionId?: string;
}

/** SDK `GatewayChannel.onMessage` 的入站帧；binary 标志保持 gateway 的 text/binary 区分。 */
export interface RemoteGatewayChannelMessage {
  data: string | Uint8Array;
  binary: boolean;
}

/**
 * backend SDK 的 `GatewayChannel` 在本模块只使用这几个成员。
 * 用结构化类型让单测可以注入 fake channel，同时真实 SDK 的实例天然满足。
 */
export interface RemoteGatewayChannel {
  readonly channelId: string;
  readonly kind?: string;
  readonly isOpen: boolean;
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(handler: (message: RemoteGatewayChannelMessage) => void): () => void;
  onClose(handler: () => void): () => void;
}

export type RemoteGatewayChannelHandler = (
  channel: RemoteGatewayChannel,
  offer: RemoteGatewayChannelOffer,
) => void;

export interface RemoteGatewayChannelClosedInfo {
  channelId: string;
  /** gateway 下发的原始 reason：closed / rejected / timeout / epoch_changed / backend_offline。 */
  reason: string;
}

/**
 * backend SDK 的最小结构面。单测注入 fake；生产用 `new GatewayBackend(options)`。
 * `onChannel` 的 handler 使用结构化 channel 类型，真实 SDK 的 `GatewayChannel` 满足它。
 */
export interface RemoteGatewayBackendSdkLike {
  readonly connectionState: GatewayBackendState;
  readonly lastError: BackendErrorInfo | null;
  readonly id: string;
  readonly currentEpoch: number;
  onState(handler: (state: GatewayBackendState) => void): () => void;
  onMessage(handler: (message: Record<string, unknown>) => void): () => void;
  onChannel(kind: string, handler: RemoteGatewayChannelHandler): void;
  connect(): Promise<{ backendId: string; epoch: number }>;
  close(): void;
}

export type RemoteGatewayBackendSdkFactory = (
  options: GatewayBackendOptions,
) => RemoteGatewayBackendSdkLike;

export interface RemoteGatewayBackendLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RemoteGatewayBackendDependencies {
  /** 读取生效配置（settings + 凭据存储）；凭证只在这个回调里出现。 */
  loadConfig: () => Promise<RemoteGatewayBackendConfig>;
  logger: RemoteGatewayBackendLogger;
  /** 单测注入 fake SDK。 */
  createBackend?: RemoteGatewayBackendSdkFactory;
  /** release 构建要求 https；本地开发运行形态由调用方传 true。 */
  allowInsecureTransport?: boolean;
  /**
   * T3.3：GatewayDeviceTransport 的 socketFactory。适配层在 socketFactory 里扣住数据
   * socket，才能读到 `bufferedAmount` 做背压（SDK 的 GatewayChannel 不暴露它）。
   */
  socketFactory?: GatewayBackendOptions["socketFactory"];
}

export interface RemoteGatewayTestConnectionInput {
  gatewayUrl: string;
  namespace: string;
  /** 省略表示沿用当前已保存的凭证。 */
  credential?: string;
}

export type RemoteGatewayTestConnectionResult =
  | { ok: true; status: RemoteAccessGatewayConnectionStatus }
  | {
      ok: false;
      reason: "mobile-connected" | RemoteAccessGatewayConnectionErrorReason;
    };

export interface RemoteGatewayBackend {
  /** 重新读取 settings + 凭证并串行应用；与当前生效值相同时不重连。 */
  reloadConfig(): Promise<void>;
  /** 直接应用一份配置（设置页在写入前后都可以调用；与当前生效值相同时不重连）。 */
  applyConfig(config: RemoteGatewayBackendConfig): Promise<void>;
  getStatus(): RemoteAccessGatewayConnectionStatus;
  onStatusChanged(handler: (status: RemoteAccessGatewayConnectionStatus) => void): () => void;
  /** T3.3 的 GatewayDeviceTransport 在这里接收 channel；handler 必须同步注册帧回调。 */
  setChannelHandler(handler: RemoteGatewayChannelHandler | undefined): void;
  /** 是否有手机通过当前 channel 连着（用于禁用「测试连接」/「断开手机」）。 */
  hasConnectedClient(): boolean;
  onChannelClosed(handler: (info: RemoteGatewayChannelClosedInfo) => void): () => void;
  /** 用表单值独立测试一次连接，结束后恢复生效配置。 */
  testConnection(
    input: RemoteGatewayTestConnectionInput,
  ): Promise<RemoteGatewayTestConnectionResult>;
  /** 关闭连接并进入 disabled；之后 reload/apply 都是 no-op。 */
  dispose(): Promise<void>;
}
