import { describe, expect, it } from "vitest";
import type { ExtensionBridgeClientMessage } from "@zcode/shared/browser-extension-transport";
import { routeHostCommand, type HostCommandRouterDeps } from "../src/hostCommandRouter.js";
import type { WorkerRequest, WorkerResponse } from "../src/workerProtocol.js";

const targetRef = {
  browserId: "extension:profile-instance-1234567890",
  browserGeneration: 1,
  connectionId: "connection-1234567890",
  nativeTabId: 42,
  attachmentId: "attachment-42",
};

const cdpRequest = {
  type: "cdp.request" as const,
  requestId: "r1",
  targetRef,
  method: "Runtime.evaluate",
  params: { expression: "1+1" },
};

function capture(response: WorkerResponse): {
  deps: HostCommandRouterDeps;
  sent: ExtensionBridgeClientMessage[];
} {
  const sent: ExtensionBridgeClientMessage[] = [];
  return {
    sent,
    deps: {
      callWorker: async () => response,
      sendClient: (message) => sent.push(message),
    },
  };
}

describe("routeHostCommand tab lifecycle", () => {
  it("creates background tabs and forwards the native tab identity", async () => {
    const { deps, sent } = capture({
      ok: true,
      data: {
        tab: { nativeTabId: 43, active: false, url: "about:blank", title: "" },
      },
    });
    await routeHostCommand(deps, {
      type: "tabs.create",
      requestId: "create-1",
      active: false,
      url: "about:blank",
    });
    expect(sent).toEqual([
      {
        type: "tabs.create.result",
        requestId: "create-1",
        ok: true,
        tab: { nativeTabId: 43, active: false, url: "about:blank", title: "" },
      },
    ]);
  });

  it("closes native tabs and reports target_unavailable failures", async () => {
    const { deps, sent } = capture({
      ok: false,
      error: { message: "could not close the tab", failureCode: "target_unavailable" },
    });
    await routeHostCommand(deps, {
      type: "tabs.close",
      requestId: "close-1",
      nativeTabId: 43,
    });
    expect(sent).toEqual([
      {
        type: "tabs.close.result",
        requestId: "close-1",
        ok: false,
        failure: { code: "target_unavailable", message: "could not close the tab" },
      },
    ]);
  });
});

describe("routeHostCommand lifecycle payloads", () => {
  it("passes the wire requestId to the worker and forwards request.cancel", async () => {
    const calls: WorkerRequest[] = [];
    const sent: ExtensionBridgeClientMessage[] = [];
    const deps: HostCommandRouterDeps = {
      callWorker: async (request) => {
        calls.push(request);
        return { ok: true, data: { result: {} } };
      },
      sendClient: (message) => sent.push(message),
    };
    await routeHostCommand(deps, cdpRequest);
    expect(calls[0]).toMatchObject({
      op: "cdp.request",
      payload: { requestId: "r1", method: "Runtime.evaluate" },
    });
    expect(sent[0]).toMatchObject({ type: "cdp.result", requestId: "r1", ok: true });

    await routeHostCommand(deps, { type: "request.cancel", targetRequestId: "r1" });
    expect(calls[1]).toMatchObject({
      op: "request.cancel",
      payload: { targetRequestId: "r1" },
    });
  });

  it("awaits session.detachAll so later commands cannot overtake cleanup", async () => {
    const order: string[] = [];
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps: HostCommandRouterDeps = {
      callWorker: async (request) => {
        order.push(`${request.op}:start`);
        if (request.op === "detachAll") {
          await cleanup;
          order.push("detachAll:done");
        }
        return { ok: true };
      },
      sendClient: () => undefined,
    };
    let routed = false;
    const route = routeHostCommand(deps, {
      type: "session.detachAll",
      reason: "window_transfer",
    }).then(() => {
      routed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(routed).toBe(false);
    expect(order).toEqual(["detachAll:start"]);

    release();
    await route;
    expect(order).toEqual(["detachAll:start", "detachAll:done"]);
  });

  it("forwards Host-declared tabClass on debugger.attach", async () => {
    const calls: WorkerRequest[] = [];
    const deps: HostCommandRouterDeps = {
      callWorker: async (request) => {
        calls.push(request);
        return { ok: true, data: { attachmentId: "a1", nativeTabId: 42 } };
      },
      sendClient: () => undefined,
    };
    await routeHostCommand(deps, {
      type: "debugger.attach",
      requestId: "attach-1",
      target: { ...targetRef, tabClass: "user" },
    });
    expect(calls[0]).toMatchObject({
      op: "debugger.attach",
      payload: { target: { tabClass: "user", nativeTabId: 42 } },
    });
  });
});

describe("routeHostCommand CDP error handling", () => {
  it("preserves CDP method/code/message instead of converting it to a transport failure", async () => {
    const { deps, sent } = capture({
      ok: false,
      data: { error: { code: -32000, message: "Cannot find context" } },
      error: { code: -32000, message: "Cannot find context" },
    });
    await routeHostCommand(deps, cdpRequest);
    expect(sent).toEqual([
      {
        type: "cdp.result",
        requestId: "r1",
        attachmentId: "attachment-42",
        nativeTabId: 42,
        ok: false,
        error: {
          method: "Runtime.evaluate",
          code: -32000,
          message: "Cannot find context",
        },
      },
    ]);
  });

  it("keeps transport failures distinct from CDP errors", async () => {
    const { deps, sent } = capture({
      ok: false,
      data: { error: { message: "stale" } },
      error: { message: "attachment is not active", failureCode: "target_unavailable" },
    });
    await routeHostCommand(deps, cdpRequest);
    expect(sent).toEqual([
      {
        type: "cdp.result",
        requestId: "r1",
        attachmentId: "attachment-42",
        nativeTabId: 42,
        ok: false,
        failure: {
          code: "target_unavailable",
          message: "attachment is not active",
        },
      },
    ]);
  });
});
