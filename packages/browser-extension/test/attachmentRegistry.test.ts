import { describe, expect, it } from "vitest";
import {
  findAttachmentByDebuggee,
  findAttachmentForTargetRef,
  matchesTargetRef,
  type AttachmentMap,
} from "../src/attachmentRegistry.js";
import type { NativeAttachment } from "../src/workerProtocol.js";

const attachment: NativeAttachment = {
  attachmentId: "attachment-42",
  browserId: "extension:profile-instance-1234567890",
  browserGeneration: 3,
  connectionId: "connection-1234567890",
  nativeTabId: 42,
  tabClass: "agent",
};

const targetRef = {
  browserId: attachment.browserId,
  browserGeneration: attachment.browserGeneration,
  connectionId: attachment.connectionId,
  nativeTabId: attachment.nativeTabId,
  attachmentId: attachment.attachmentId,
};

function registry(): AttachmentMap {
  return { [attachment.attachmentId]: { ...attachment } };
}

describe("attachment TargetRef validation", () => {
  it("accepts a fully matching TargetRef", () => {
    expect(matchesTargetRef(attachment, targetRef)).toBe(true);
    expect(findAttachmentForTargetRef(registry(), targetRef)?.attachmentId).toBe(
      attachment.attachmentId,
    );
  });

  it.each([
    ["browserId", { browserId: "extension:other-profile-1234567890" }],
    ["browserGeneration", { browserGeneration: 4 }],
    ["connectionId", { connectionId: "connection-other-123456" }],
    ["nativeTabId", { nativeTabId: 43 }],
    ["attachmentId", { attachmentId: "attachment-other" }],
  ])("rejects a mismatched %s", (_field, override) => {
    const mismatched = { ...targetRef, ...override };
    expect(matchesTargetRef(attachment, mismatched)).toBe(false);
    expect(findAttachmentForTargetRef(registry(), mismatched)).toBeUndefined();
  });

  it("finds attachments by tabId or child targetId for debugger events", () => {
    const attachments = registry();
    expect(findAttachmentByDebuggee(attachments, { tabId: 42 })?.attachmentId).toBe(
      attachment.attachmentId,
    );
    expect(findAttachmentByDebuggee(attachments, { tabId: 43 })).toBeUndefined();
    const child = { ...attachment, attachmentId: "attachment-child", targetId: "child-target" };
    attachments[child.attachmentId] = child;
    expect(findAttachmentByDebuggee(attachments, { targetId: "child-target" })?.attachmentId).toBe(
      "attachment-child",
    );
  });
});
