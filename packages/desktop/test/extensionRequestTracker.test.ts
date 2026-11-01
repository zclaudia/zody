import { describe, expect, it, vi } from "vitest";
import { ExtensionRequestTracker } from "../src/host/extensionRequestTracker.js";

const BROWSER_ID = "extension:profile-instance-1234567890";

function context(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    workspaceKey: "workspace-1",
    clientMode: "desktop-continuous" as const,
    sessionContext: "live" as const,
    ...overrides,
  };
}

function reasonOf(signal: AbortSignal): { code?: unknown; sideEffect?: unknown } {
  return signal.reason as { code?: unknown; sideEffect?: unknown };
}

describe("ExtensionRequestTracker", () => {
  it("cancels only the target request and never settles a later same-key entry", () => {
    const cancelWire = vi.fn();
    const tracker = new ExtensionRequestTracker({ cancelWire });
    const first = tracker.begin({
      requestId: "r1",
      command: "navigate",
      browserId: BROWSER_ID,
      context: context(),
      tabId: "tab-1",
    });
    const second = tracker.begin({
      requestId: "r2",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context({ requestId: "r2" }),
      tabId: "tab-2",
    });
    if (!first || !second) throw new Error("entries were not created");
    tracker.markDispatched("r1", "wire-1", "Page.navigate");
    tracker.markDispatched("r2", "wire-2", "Runtime.evaluate");

    expect(tracker.cancel("r1", context())).toBe(true);
    expect(first.controller.signal.aborted).toBe(true);
    expect(reasonOf(first.controller.signal)).toMatchObject({
      code: "cancelled",
      sideEffect: "uncertain",
    });
    expect(second.controller.signal.aborted).toBe(false);
    expect(cancelWire).toHaveBeenCalledWith(["wire-1"]);

    // 重复取消同一目标不再产生第二次 wire cancel。
    expect(tracker.cancel("r1", context())).toBe(false);
    expect(cancelWire).toHaveBeenCalledTimes(1);

    tracker.complete("r1");
    const later = tracker.begin({
      requestId: "r1",
      command: "getState",
      browserId: BROWSER_ID,
      context: context(),
      tabId: "tab-1",
    });
    expect(later?.controller.signal.aborted).toBe(false);
    tracker.dispose();
  });

  it("returns sideEffect none when cancelled before any CDP dispatch", () => {
    const tracker = new ExtensionRequestTracker();
    const entry = tracker.begin({
      requestId: "r1",
      command: "navigate",
      browserId: BROWSER_ID,
      context: context(),
      tabId: "tab-1",
    });
    if (!entry) throw new Error("entry was not created");
    expect(tracker.cancel("r1", context())).toBe(true);
    expect(reasonOf(entry.controller.signal)).toMatchObject({
      code: "cancelled",
      sideEffect: "none",
    });
    tracker.dispose();
  });

  it("times out dispatched side-effecting commands as uncertain and releases wire requests", async () => {
    const cancelWire = vi.fn();
    const tracker = new ExtensionRequestTracker({ cancelWire, timeoutMs: 5 });
    const entry = tracker.begin({
      requestId: "r1",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context(),
      tabId: "tab-1",
    });
    if (!entry) throw new Error("entry was not created");
    tracker.markDispatched("r1", "wire-1", "Runtime.evaluate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reasonOf(entry.controller.signal)).toMatchObject({
      code: "timeout",
      sideEffect: "uncertain",
    });
    expect(cancelWire).toHaveBeenCalledWith(["wire-1"]);
    tracker.dispose();
  });

  it("does not treat pure reads as side effects after dispatch", () => {
    const tracker = new ExtensionRequestTracker({ timeoutMs: 5 });
    const entry = tracker.begin({
      requestId: "r1",
      command: "getState",
      browserId: BROWSER_ID,
      context: context(),
      tabId: "tab-1",
    });
    if (!entry) throw new Error("entry was not created");
    tracker.markDispatched("r1", "wire-1", "Page.captureScreenshot");
    tracker.markDispatched("r1", "wire-2", "Runtime.evaluate");
    expect(tracker.dispatchedSideEffectFor("r1")).toBe(true);
    tracker.dispose();

    const readTracker = new ExtensionRequestTracker({ timeoutMs: 5 });
    readTracker.begin({
      requestId: "r2",
      command: "screenshot",
      browserId: BROWSER_ID,
      context: context({ requestId: "r2" }),
    });
    readTracker.markDispatched("r2", "wire-3", "Page.captureScreenshot");
    expect(readTracker.dispatchedSideEffectFor("r2")).toBe(false);
    readTracker.dispose();
  });

  it("scopes turn/session cancellation to the matching owner", () => {
    const tracker = new ExtensionRequestTracker();
    const turnEntry = tracker.begin({
      requestId: "r1",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context({ turnId: "turn-1" }),
    });
    const otherTurn = tracker.begin({
      requestId: "r2",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context({ requestId: "r2", turnId: "turn-2" }),
    });
    const otherSession = tracker.begin({
      requestId: "r3",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context({ requestId: "r3", sessionId: "session-2" }),
    });
    if (!turnEntry || !otherTurn || !otherSession) throw new Error("entries were not created");

    expect(tracker.cancelScope(context(), "turn-1")).toBe(1);
    expect(turnEntry.controller.signal.aborted).toBe(true);
    expect(reasonOf(turnEntry.controller.signal).code).toBe("cancelled");
    expect(otherTurn.controller.signal.aborted).toBe(false);
    expect(otherSession.controller.signal.aborted).toBe(false);
    tracker.dispose();
  });

  it("settles all requests for a disconnected profile as backend_unavailable", () => {
    const tracker = new ExtensionRequestTracker();
    const entry = tracker.begin({
      requestId: "r1",
      command: "evaluate",
      browserId: BROWSER_ID,
      context: context(),
    });
    if (!entry) throw new Error("entry was not created");
    tracker.markDispatched("r1", "wire-1", "Runtime.evaluate");
    expect(tracker.cancelProfile("profile-instance-1234567890")).toBe(1);
    expect(reasonOf(entry.controller.signal)).toMatchObject({
      code: "backend_unavailable",
      sideEffect: "uncertain",
    });
    tracker.dispose();
  });

  it("rejects a duplicate requestId while the first entry is running", () => {
    const tracker = new ExtensionRequestTracker();
    expect(
      tracker.begin({
        requestId: "r1",
        command: "evaluate",
        browserId: BROWSER_ID,
        context: context(),
      }),
    ).toBeDefined();
    expect(
      tracker.begin({
        requestId: "r1",
        command: "getState",
        browserId: BROWSER_ID,
        context: context(),
      }),
    ).toBeUndefined();
    tracker.dispose();
  });
});
