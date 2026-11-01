import { randomUUID } from "node:crypto";
import { HostResponseTypes } from "@zcode/shared";
import type {
  ExtensionBridgeClientMessage,
  ExtensionBridgeRequestMessage,
  ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";

export interface ExtensionHostConnection {
  profileInstanceId: string;
  browserId: string;
  generation: number;
  connectionId: string;
  windowId: string;
}

export interface ExtensionConnectionChange {
  connected: boolean;
  connection: ExtensionHostConnection;
}

export interface ExtensionHostEvent {
  profileInstanceId: string;
  message: ExtensionBridgeClientMessage;
}

export interface ExtensionTransportResultMessage {
  requestId: string;
  ok: boolean;
  connections?: ExtensionHostConnection[];
  message?: ExtensionBridgeClientMessage;
  error?: { code: string; message: string };
}

export interface ExtensionTransportClient {
  listConnections(): Promise<ExtensionHostConnection[]>;
  request(
    profileInstanceId: string,
    message: ExtensionBridgeRequestMessage,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExtensionBridgeClientMessage>;
  send(profileInstanceId: string, message: ExtensionBridgeServerMessage): Promise<boolean>;
  handleResult(message: ExtensionTransportResultMessage): void;
  handleConnectionChanged(input: {
    profileInstanceId: string;
    connected: boolean;
    browserId: string;
    generation?: number;
    connectionId?: string;
    windowId?: string;
  }): void;
  handleEvent(event: ExtensionHostEvent): void;
  onConnectionChange(listener: (change: ExtensionConnectionChange) => void): () => void;
  onEvent(listener: (event: ExtensionHostEvent) => void): () => void;
  getConnection(profileInstanceId: string): ExtensionHostConnection | undefined;
  dispose(): void;
}

interface PendingEntry {
  profileInstanceId: string;
  resolve: (result: ExtensionTransportResultMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

const DEFAULT_TRANSPORT_TIMEOUT_MS = 35_000;

class ExtensionTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionTransportError";
  }
}

/**
 * Host 侧的扩展传输客户端。
 *
 * 只负责 requestId 关联与连接快照；不解释 CDP、不持有 tab 归属。业务 owner 是
 * ExtensionBrowserBackend。
 */
export function createExtensionTransportClient(deps: {
  postToMain: (message: unknown) => void;
  timeoutMs?: number;
}): ExtensionTransportClient {
  const pending = new Map<string, PendingEntry>();
  const connections = new Map<string, ExtensionHostConnection>();
  const connectionListeners = new Set<(change: ExtensionConnectionChange) => void>();
  const eventListeners = new Set<(event: ExtensionHostEvent) => void>();
  let disposed = false;

  const requestTransport = (
    message: Record<string, unknown>,
    timeoutMs = deps.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS,
    signal?: AbortSignal,
    profileInstanceId = "",
  ): Promise<ExtensionTransportResultMessage> => {
    if (disposed) {
      return Promise.reject(new ExtensionTransportError("backend_unavailable", "host is disposed"));
    }
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const requestId = randomUUID();
    return new Promise<ExtensionTransportResultMessage>((resolve, reject) => {
      const entry: PendingEntry = {
        profileInstanceId,
        resolve,
        reject,
        timer: setTimeout(() => {
          // compare-and-delete：超时只结束当前 entry，不能删除后来同 key 的请求。
          if (pending.get(requestId) !== entry) return;
          pending.delete(requestId);
          entry.detachAbort?.();
          reject(
            new ExtensionTransportError(
              "request_timeout",
              `extension transport request timed out: ${String(message.op)}`,
            ),
          );
        }, timeoutMs),
      };
      entry.timer.unref?.();
      if (signal) {
        const onAbort = () => {
          if (pending.get(requestId) !== entry) return;
          pending.delete(requestId);
          clearTimeout(entry.timer);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }
      pending.set(requestId, entry);
      try {
        deps.postToMain({
          type: HostResponseTypes.ExtensionTransportRequest,
          requestId,
          ...message,
        });
      } catch (error) {
        if (pending.get(requestId) === entry) pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.detachAbort?.();
        reject(
          new ExtensionTransportError(
            "backend_unavailable",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    });
  };

  const rejectPendingForProfile = (profileInstanceId: string, error: Error): void => {
    for (const [requestId, entry] of pending) {
      if (entry.profileInstanceId !== profileInstanceId) continue;
      if (pending.get(requestId) !== entry) continue;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.detachAbort?.();
      entry.reject(error);
    }
  };

  return {
    async listConnections() {
      const result = await requestTransport({ op: "list" });
      if (!result.ok) {
        throw new ExtensionTransportError(
          result.error?.code ?? "backend_unavailable",
          result.error?.message ?? "extension bridge is unavailable",
        );
      }
      connections.clear();
      for (const connection of result.connections ?? []) {
        connections.set(connection.profileInstanceId, connection);
      }
      return [...connections.values()];
    },

    async request(profileInstanceId, message, timeoutMs, signal) {
      const result = await requestTransport(
        { op: "request", profileInstanceId, message },
        timeoutMs,
        signal,
        profileInstanceId,
      );
      if (!result.ok) {
        throw new ExtensionTransportError(
          result.error?.code ?? "backend_unavailable",
          result.error?.message ?? "extension request failed",
        );
      }
      if (!result.message) {
        throw new ExtensionTransportError(
          "internal_error",
          "extension request returned no result message",
        );
      }
      return result.message;
    },

    async send(profileInstanceId, message) {
      const result = await requestTransport(
        {
          op: "send",
          profileInstanceId,
          message,
        },
        undefined,
        undefined,
        profileInstanceId,
      );
      if (!result.ok) {
        throw new ExtensionTransportError(
          result.error?.code ?? "backend_unavailable",
          result.error?.message ?? "extension send failed",
        );
      }
      return true;
    },

    handleResult(message) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      // compare-and-delete：超时后迟到的结果不能结算后来的同 key 请求。
      if (pending.get(message.requestId) !== entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      entry.detachAbort?.();
      if (!message.ok) {
        entry.reject(
          new ExtensionTransportError(
            message.error?.code ?? "backend_unavailable",
            message.error?.message ?? "extension transport failed",
          ),
        );
        return;
      }
      entry.resolve(message);
    },

    handleConnectionChanged(input) {
      const previous = connections.get(input.profileInstanceId);
      const connection: ExtensionHostConnection = {
        profileInstanceId: input.profileInstanceId,
        browserId: input.browserId,
        generation: input.generation ?? previous?.generation ?? 0,
        connectionId: input.connectionId ?? previous?.connectionId ?? "",
        windowId: input.windowId ?? previous?.windowId ?? "",
      };
      if (input.connected) {
        // 同一 Profile 的新 generation/connection 是新的授权事实；旧 in-flight 请求
        // 不能被迟到结果结算。
        const replaced =
          previous !== undefined &&
          (previous.connectionId !== connection.connectionId ||
            previous.generation !== connection.generation);
        connections.set(input.profileInstanceId, connection);
        if (replaced) {
          rejectPendingForProfile(
            input.profileInstanceId,
            new ExtensionTransportError(
              "backend_unavailable",
              "extension connection was replaced before the request settled",
            ),
          );
        }
      } else {
        connections.delete(input.profileInstanceId);
        rejectPendingForProfile(
          input.profileInstanceId,
          new ExtensionTransportError(
            "backend_unavailable",
            "extension connection closed before the request settled",
          ),
        );
      }
      for (const listener of connectionListeners) {
        listener({ connected: input.connected, connection });
      }
    },

    handleEvent(event) {
      for (const listener of eventListeners) listener(event);
    },

    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },

    getConnection(profileInstanceId) {
      return connections.get(profileInstanceId);
    },

    dispose() {
      disposed = true;
      for (const [requestId, entry] of pending) {
        if (pending.get(requestId) !== entry) continue;
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.detachAbort?.();
        entry.reject(new ExtensionTransportError("backend_unavailable", "host is disposed"));
      }
      connectionListeners.clear();
      eventListeners.clear();
    },
  };
}

/** abort 可能来自 Host cancel 或 timeout；保留 tracker 写入的稳定 code/sideEffect。 */
function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("extension transport request aborted"), {
    code: "cancelled",
    sideEffect: "none",
  });
}

export { ExtensionTransportError };
