import { describe, expect, it } from "vitest";
import {
  parseExtensionBridgeClientMessage,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
} from "@zcode/shared/browser-extension-transport";
import {
  isClaimableUserTabUrl,
  parseUserTabId,
  sanitizeUserTabUrl,
} from "../src/host/extensionBrowserBackend.js";

describe("Chrome extension user tab projection", () => {
  it("strips userinfo, query and hash from openTabs URLs", () => {
    expect(sanitizeUserTabUrl("https://user:secret@example.com:8443/path?token=1#frag")).toBe(
      "https://example.com:8443/path",
    );
  });

  it("only allows plain http(s) pages outside the Chrome Web Store", () => {
    expect(isClaimableUserTabUrl("https://example.com/app")).toBe(true);
    expect(isClaimableUserTabUrl("http://127.0.0.1:8080/")).toBe(true);
    expect(isClaimableUserTabUrl("chrome://settings")).toBe(false);
    expect(isClaimableUserTabUrl("chrome-extension://abc/popup.html")).toBe(false);
    expect(isClaimableUserTabUrl("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isClaimableUserTabUrl("file:///tmp/page.html")).toBe(false);
    expect(isClaimableUserTabUrl("https://chromewebstore.google.com/detail/x")).toBe(false);
    expect(isClaimableUserTabUrl("https://chrome.google.com/webstore/detail/x")).toBe(false);
  });

  it("parses only backend-scoped user tab ids", () => {
    expect(parseUserTabId("extuser:42")).toBe(42);
    expect(parseUserTabId("42")).toBe(42);
    expect(parseUserTabId("extuser:not-a-number")).toBeUndefined();
    expect(parseUserTabId("extab:42")).toBeUndefined();
    expect(parseUserTabId("-1")).toBeUndefined();
  });
});

describe("claim transport schema", () => {
  it("round-trips claim.request/cancel on the server wire", () => {
    const request = {
      type: "claim.request" as const,
      claimId: "claim-1",
      nativeTabId: 42,
      expiresAt: 1_700_000_000_000,
    };
    expect(parseExtensionBridgeServerMessage(serializeExtensionBridgeMessage(request))).toEqual(
      request,
    );
    const cancel = { type: "claim.cancel" as const, claimId: "claim-1" };
    expect(parseExtensionBridgeServerMessage(serializeExtensionBridgeMessage(cancel))).toEqual(
      cancel,
    );
  });

  it("round-trips claim.decision and rejects unknown fields", () => {
    const decision = {
      type: "claim.decision" as const,
      claimId: "claim-1",
      nativeTabId: 42,
      decision: "granted" as const,
    };
    expect(parseExtensionBridgeClientMessage(serializeExtensionBridgeMessage(decision))).toEqual(
      decision,
    );
    expect(() =>
      parseExtensionBridgeClientMessage({ ...decision, sessionId: "cdp-session" }),
    ).toThrow();
  });

  it("accepts native tab debuggerAttached only as an optional boolean", () => {
    expect(() =>
      parseExtensionBridgeClientMessage({
        type: "tabs.list.result",
        requestId: "r1",
        ok: true,
        tabs: [
          {
            nativeTabId: 1,
            active: true,
            url: "https://example.com",
            title: "Example",
            debuggerAttached: true,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseExtensionBridgeClientMessage({
        type: "tabs.list.result",
        requestId: "r1",
        ok: true,
        tabs: [
          {
            nativeTabId: 1,
            active: true,
            url: "https://example.com",
            title: "Example",
            debuggerAttached: "yes",
          },
        ],
      }),
    ).toThrow();
  });
});
