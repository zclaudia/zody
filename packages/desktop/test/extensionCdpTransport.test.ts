import { describe, expect, it } from "vitest";
import { ExtensionCdpTransport } from "../src/browser-core/extensionCdpTransport.js";
import type { ExtensionTargetRef } from "@zcode/shared/browser-extension-transport";

const targetRef: ExtensionTargetRef = {
  browserId: "extension:profile-instance-1234567890",
  browserGeneration: 1,
  connectionId: "connection-1234567890",
  nativeTabId: 42,
  attachmentId: "attachment-42",
};

describe("ExtensionCdpTransport lifecycle", () => {
  it("drops events from an attachment that was already invalidated", () => {
    const transport = new ExtensionCdpTransport({
      request: async () => {
        throw new Error("not used");
      },
    });
    const events: string[] = [];
    transport.subscribe((event) => events.push(event.method));
    transport.registerTarget(targetRef);
    transport.dispatchEvent({
      attachmentId: targetRef.attachmentId,
      nativeTabId: targetRef.nativeTabId,
      method: "Page.loadEventFired",
      params: {},
    });
    transport.unregisterAttachment(targetRef.attachmentId);
    transport.dispatchEvent({
      attachmentId: targetRef.attachmentId,
      nativeTabId: targetRef.nativeTabId,
      method: "Page.javascriptDialogOpening",
      params: {},
    });
    expect(events).toEqual(["Page.loadEventFired"]);
  });

  it("rejects immediately once the command signal aborts and still emits wire cancel", async () => {
    const canceled: string[] = [];
    let rejectWire!: (error: Error) => void;
    let wireRequestId = "";
    const transport = new ExtensionCdpTransport({
      request: (message) => {
        wireRequestId = message.requestId;
        return new Promise((_resolve, reject) => {
          rejectWire = (error) => reject(error);
        });
      },
      cancel: (requestId) => canceled.push(requestId),
    });
    transport.registerTarget(targetRef);
    const controller = new AbortController();
    const pending = transport.send(
      "Runtime.evaluate",
      { expression: "long()" },
      { attachmentId: targetRef.attachmentId, nativeTabId: targetRef.nativeTabId },
      { commandRequestId: "command-1", signal: controller.signal },
    );
    transport.cancelRequests([wireRequestId]);
    expect(canceled).toEqual([wireRequestId]);
    const abort = Object.assign(new Error("cancelled"), {
      code: "cancelled",
      sideEffect: "uncertain",
    });
    controller.abort(abort);
    await expect(pending).rejects.toMatchObject({ code: "cancelled", sideEffect: "uncertain" });
    rejectWire(abort);
  });
});
