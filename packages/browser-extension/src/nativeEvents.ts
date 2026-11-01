import type { ExtensionBridgeClientMessage } from "@zcode/shared/browser-extension-transport";
import type { NativeBridgeMessage } from "./workerProtocol.js";

/** service worker 的 Chrome 事件投影转成 transport 消息；不保存任何业务状态。 */
export function projectNativeMessage(message: NativeBridgeMessage): ExtensionBridgeClientMessage {
  if (message.type === "native.claimDecision") {
    return {
      type: "claim.decision",
      claimId: message.claimId,
      nativeTabId: message.nativeTabId,
      decision: message.decision,
    };
  }
  if (message.type === "native.event") {
    return {
      type: "cdp.event",
      attachmentId: message.attachment.attachmentId,
      nativeTabId: message.attachment.nativeTabId,
      ...(message.attachment.targetId ? { targetId: message.attachment.targetId } : {}),
      method: message.method,
      params: message.params,
    };
  }
  const targetRef = {
    browserId: message.attachment.browserId,
    browserGeneration: message.attachment.browserGeneration,
    connectionId: message.attachment.connectionId,
    nativeTabId: message.attachment.nativeTabId,
    attachmentId: message.attachment.attachmentId,
  };
  if (message.type === "native.detached") {
    return { type: "target.detached", targetRef, reason: message.reason };
  }
  return { type: "target.closed", targetRef };
}
