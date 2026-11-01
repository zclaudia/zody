import { describe, expect, it } from "vitest";
import {
  EXTENSION_BRIDGE_MAX_FRAME_BYTES,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  ExtensionBridgeProtocolError,
  extensionBridgeClientMessageSchema,
  extensionBridgeMessageByteLength,
  extensionBridgeServerMessageSchema,
  isExtensionBridgeResultMessage,
  parseExtensionBridgeClientMessage,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
} from "../src/browser-use/extension-transport.js";

const targetRef = {
  browserId: "extension:profile-1234567890",
  browserGeneration: 3,
  connectionId: "connection-1234567890",
  nativeTabId: 42,
  attachmentId: "attachment-123",
};

const clientMessages: ExtensionBridgeMessage[] = [
  {
    type: "hello",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    extensionId: "mgbbfehgciopncanakmloajgfomoeepp",
    extensionVersion: "0.1.0",
    profileInstanceId: "profile-1234567890",
    clientPublicKey: "AAECAwQ",
  },
  {
    type: "pairing.proof",
    pairingSessionId: "pairing-123",
    nonce: "bm9uY2U",
    proof: "cHJvb2Y",
  },
  {
    type: "resume.proof",
    connectionId: "connection-1234567890",
    proof: "cHJvb2Y",
  },
  { type: "tabs.list.result", requestId: "r1", ok: true, tabs: [] },
  {
    type: "tabs.create.result",
    requestId: "r-create",
    ok: true,
    tab: { nativeTabId: 43, active: false, url: "about:blank", title: "" },
  },
  { type: "tabs.close.result", requestId: "r-close", ok: true },
  {
    type: "debugger.attach.result",
    requestId: "r2",
    ok: true,
    attachmentId: "attachment-123",
    nativeTabId: 42,
  },
  { type: "debugger.detach.result", requestId: "r3", ok: true },
  {
    type: "cdp.result",
    requestId: "r4",
    attachmentId: "attachment-123",
    nativeTabId: 42,
    ok: true,
    result: { value: 1 },
  },
  {
    type: "cdp.event",
    attachmentId: "attachment-123",
    nativeTabId: 42,
    method: "Page.loadEventFired",
    params: { timestamp: 1 },
  },
  { type: "target.updated", targetRef, active: true },
  { type: "target.detached", targetRef, reason: "user_cancel" },
  { type: "target.closed", targetRef },
];

const serverMessages: ExtensionBridgeMessage[] = [
  {
    type: "pairing.required",
    pairingSessionId: "pairing-123",
    nonce: "bm9uY2U",
    serverPublicKey: "AAECAwQ",
    expiresAt: 1_700_000_000_000,
  },
  {
    type: "resume.challenge",
    connectionId: "connection-1234567890",
    nonce: "bm9uY2U",
    expiresAt: 1_700_000_000_000,
  },
  {
    type: "welcome",
    connectionId: "connection-1234567890",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    browserId: "extension:profile-1234567890",
    profileInstanceId: "profile-1234567890",
    generation: 2,
    capabilitiesVersion: 1,
    serverProof: "cHJvb2Y",
  },
  {
    type: "fatalError",
    code: "pairing_failed",
    message: "pairing proof rejected",
    retryable: true,
  },
  { type: "tabs.list", requestId: "r1" },
  { type: "tabs.create", requestId: "r-create", active: false, url: "about:blank" },
  { type: "tabs.close", requestId: "r-close", nativeTabId: 43 },
  {
    type: "debugger.attach",
    requestId: "r2",
    target: {
      browserId: "extension:profile-1234567890",
      browserGeneration: 3,
      connectionId: "connection-1234567890",
      nativeTabId: 42,
      tabClass: "agent",
    },
  },
  { type: "debugger.detach", requestId: "r3", targetRef },
  {
    type: "cdp.request",
    requestId: "r4",
    targetRef,
    method: "Runtime.evaluate",
    params: { expression: "1+1" },
  },
  { type: "request.cancel", targetRequestId: "r4" },
  { type: "session.detachAll", reason: "host_exit" },
];

type ExtensionBridgeMessage = ExtensionBridgeClientMessage | ExtensionBridgeServerMessage;

describe("extension bridge transport", () => {
  it("round-trips every client and server message", () => {
    for (const message of clientMessages) {
      const raw = serializeExtensionBridgeMessage(message);
      expect(parseExtensionBridgeClientMessage(raw)).toEqual(message);
    }
    for (const message of serverMessages) {
      const raw = serializeExtensionBridgeMessage(message);
      expect(parseExtensionBridgeServerMessage(raw)).toEqual(message);
    }
  });

  it("rejects extra fields on every message kind", () => {
    const hello = {
      ...clientMessages[0],
      pairingCode: "should-not-be-here",
    };
    expect(extensionBridgeClientMessageSchema.safeParse(hello).success).toBe(false);

    const welcome = {
      ...serverMessages[2],
      sharedSecret: "should-not-be-here",
    };
    expect(extensionBridgeServerMessageSchema.safeParse(welcome).success).toBe(false);
  });

  it("rejects foreground tab creation at the protocol boundary", () => {
    const active = { type: "tabs.create", requestId: "r-create", active: true };
    expect(extensionBridgeServerMessageSchema.safeParse(active).success).toBe(false);
  });

  it("requires a declared tabClass on attach and accepts window_transfer cleanup", () => {
    const attach = serverMessages.find((message) => message.type === "debugger.attach");
    if (!attach || attach.type !== "debugger.attach") throw new Error("attach fixture missing");
    const { tabClass: _tabClass, ...withoutClass } = attach.target;
    expect(
      extensionBridgeServerMessageSchema.safeParse({ ...attach, target: withoutClass }).success,
    ).toBe(false);
    expect(
      extensionBridgeServerMessageSchema.safeParse({
        ...attach,
        target: { ...attach.target, tabClass: "active" },
      }).success,
    ).toBe(false);
    const transfer = { type: "session.detachAll", reason: "window_transfer" };
    expect(extensionBridgeServerMessageSchema.safeParse(transfer).success).toBe(true);
  });

  it("rejects a CDP sessionId field", () => {
    const withSessionId = {
      type: "cdp.request",
      requestId: "r4",
      targetRef,
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      sessionId: "cdp-session",
    };
    expect(extensionBridgeClientMessageSchema.safeParse(withSessionId).success).toBe(false);
    expect(extensionBridgeServerMessageSchema.safeParse(withSessionId).success).toBe(false);
  });

  it("rejects wrong-direction and unknown messages", () => {
    expect(() => parseExtensionBridgeClientMessage(JSON.stringify(serverMessages[0]))).toThrow(
      ExtensionBridgeProtocolError,
    );
    expect(() => parseExtensionBridgeServerMessage(JSON.stringify(clientMessages[0]))).toThrow(
      ExtensionBridgeProtocolError,
    );
    expect(() =>
      parseExtensionBridgeClientMessage(JSON.stringify({ type: "not.a.message" })),
    ).toThrow(ExtensionBridgeProtocolError);
  });

  it("rejects invalid JSON and oversized frames", () => {
    expect(() => parseExtensionBridgeClientMessage("{")).toThrow(ExtensionBridgeProtocolError);
    const huge = JSON.stringify({
      type: "cdp.event",
      attachmentId: "attachment-123",
      nativeTabId: 42,
      method: "Runtime.consoleAPICalled",
      params: { payload: "x".repeat(EXTENSION_BRIDGE_MAX_FRAME_BYTES + 1) },
    });
    expect(extensionBridgeMessageByteLength(huge)).toBeGreaterThan(
      EXTENSION_BRIDGE_MAX_FRAME_BYTES,
    );
    expect(() => parseExtensionBridgeClientMessage(huge)).toThrow(/frame exceeds/);
  });

  it("identifies result messages for pending settlement", () => {
    expect(isExtensionBridgeResultMessage(clientMessages[3] as ExtensionBridgeClientMessage)).toBe(
      true,
    );
    const event = clientMessages.find((message) => message.type === "cdp.event");
    expect(isExtensionBridgeResultMessage(event as ExtensionBridgeClientMessage)).toBe(false);
  });
});
