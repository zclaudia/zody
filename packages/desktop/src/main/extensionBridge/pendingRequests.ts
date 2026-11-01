import {
  EXTENSION_BRIDGE_MAX_RESULT_BYTES,
  isExtensionBridgeResultMessage,
  type ExtensionBridgeClientMessage,
} from "@zcode/shared/browser-extension-transport";
import {
  EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS,
  ExtensionBridgeError,
  type ExtensionBridgeRequestMessage,
} from "./types.js";

interface PendingRequest {
  requestId: string;
  expectedResultType: string;
  expectedAttachmentId?: string;
  expectedNativeTabId?: number;
  timer: NodeJS.Timeout;
  resolve: (message: ExtensionBridgeClientMessage) => void;
  reject: (error: Error) => void;
}

function expectedResultTypeFor(requestType: ExtensionBridgeRequestMessage["type"]): string {
  switch (requestType) {
    case "tabs.list":
      return "tabs.list.result";
    case "tabs.create":
      return "tabs.create.result";
    case "tabs.close":
      return "tabs.close.result";
    case "debugger.attach":
      return "debugger.attach.result";
    case "debugger.detach":
      return "debugger.detach.result";
    case "cdp.request":
      return "cdp.result";
  }
}

/**
 * 单连接的 requestId 关联表。
 *
 * - 同一连接内 requestId 永不复用：超时后的迟到结果不会命中后续请求。
 * - 结果类型、attachmentId、nativeTabId 必须与发出请求匹配，否则不 settle。
 * - pending 删除使用 compare-and-delete；超时只结束当前 entry。
 */
export class PendingRequestRegistry {
  private readonly entries = new Map<string, PendingRequest>();
  private readonly usedRequestIds = new Set<string>();

  request(
    message: ExtensionBridgeRequestMessage,
    send: (message: ExtensionBridgeRequestMessage) => boolean,
    timeoutMs = EXTENSION_BRIDGE_REQUEST_TIMEOUT_MS,
  ): Promise<ExtensionBridgeClientMessage> {
    if (this.usedRequestIds.has(message.requestId)) {
      return Promise.reject(
        new ExtensionBridgeError(
          "duplicate_request_id",
          "requestId already used on this connection",
        ),
      );
    }
    this.usedRequestIds.add(message.requestId);

    return new Promise<ExtensionBridgeClientMessage>((resolve, reject) => {
      const entry: PendingRequest = {
        requestId: message.requestId,
        expectedResultType: expectedResultTypeFor(message.type),
        expectedAttachmentId:
          message.type === "cdp.request" ? message.targetRef.attachmentId : undefined,
        expectedNativeTabId:
          message.type === "debugger.attach" ? message.target.nativeTabId : undefined,
        timer: setTimeout(() => {
          if (this.entries.get(message.requestId) !== entry) return;
          this.entries.delete(message.requestId);
          reject(
            new ExtensionBridgeError(
              "request_timeout",
              `extension request timed out: ${message.type}`,
            ),
          );
        }, timeoutMs),
        resolve,
        reject,
      };
      entry.timer.unref?.();
      this.entries.set(message.requestId, entry);
      if (!send(message)) {
        if (this.entries.get(message.requestId) === entry) {
          this.entries.delete(message.requestId);
        }
        clearTimeout(entry.timer);
        reject(new ExtensionBridgeError("socket_closed", "extension socket is not open"));
      }
    });
  }

  /** 迟到或类型不匹配的结果一律忽略，不能影响任何 pending/后续请求。 */
  settle(message: ExtensionBridgeClientMessage, byteLength: number): void {
    if (!isExtensionBridgeResultMessage(message)) return;
    const entry = this.entries.get(message.requestId);
    if (!entry) return;
    if (message.type !== entry.expectedResultType) return;
    if (
      message.type === "cdp.result" &&
      entry.expectedAttachmentId &&
      message.attachmentId !== entry.expectedAttachmentId
    ) {
      return;
    }
    if (
      message.type === "debugger.attach.result" &&
      entry.expectedNativeTabId !== undefined &&
      message.nativeTabId !== undefined &&
      message.nativeTabId !== entry.expectedNativeTabId
    ) {
      return;
    }
    if (this.entries.get(message.requestId) !== entry) return;
    if (message.type === "cdp.result" && byteLength > EXTENSION_BRIDGE_MAX_RESULT_BYTES) {
      this.entries.delete(message.requestId);
      clearTimeout(entry.timer);
      entry.reject(
        new ExtensionBridgeError("result_too_large", "CDP result exceeds the 4 MiB limit"),
      );
      return;
    }
    this.entries.delete(message.requestId);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }

  rejectAll(error: Error): void {
    for (const [requestId, entry] of this.entries) {
      if (this.entries.get(requestId) !== entry) continue;
      this.entries.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
