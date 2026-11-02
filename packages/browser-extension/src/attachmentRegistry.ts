import type { ExtensionTargetRef } from "@zody/shared/browser-extension-transport";
import type { NativeAttachment } from "./workerProtocol.js";

export type AttachmentMap = Record<string, NativeAttachment>;

/** chrome.debugger 事件只带 tabId/targetId；按 source 找回唯一的 attachment。 */
export function findAttachmentByDebuggee(
  attachments: AttachmentMap,
  source: ChromeDebuggee,
): NativeAttachment | undefined {
  return Object.values(attachments).find((attachment) =>
    source.targetId
      ? attachment.targetId === source.targetId
      : attachment.nativeTabId === source.tabId,
  );
}

/**
 * spec 要求 TargetRef 任一项不匹配都拒绝命令。
 * browserId / browserGeneration / connectionId / nativeTabId / attachmentId 全部参与比较。
 */
export function matchesTargetRef(
  attachment: NativeAttachment,
  targetRef: ExtensionTargetRef,
): boolean {
  return (
    attachment.attachmentId === targetRef.attachmentId &&
    attachment.nativeTabId === targetRef.nativeTabId &&
    attachment.connectionId === targetRef.connectionId &&
    attachment.browserId === targetRef.browserId &&
    attachment.browserGeneration === targetRef.browserGeneration
  );
}

export function findAttachmentForTargetRef(
  attachments: AttachmentMap,
  targetRef: ExtensionTargetRef,
): NativeAttachment | undefined {
  const attachment = attachments[targetRef.attachmentId];
  return attachment && matchesTargetRef(attachment, targetRef) ? attachment : undefined;
}
