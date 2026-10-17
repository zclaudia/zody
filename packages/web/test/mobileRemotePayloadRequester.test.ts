import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import { createWebRemoteControlAppPayloadRequester } from "../src/mobile-remote/payloadRequester.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createWebRemoteControlAppPayloadRequester", () => {
  it("rejects matching pending requests on app errors only", async () => {
    const sent: WebRemoteControlAppPayload[] = [];
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 100,
    });
    const promise = requester.requestAppPayload(
      { zcode_type: "bootstrap-request", requestId: "req-1" },
      (payload): payload is WebRemoteControlAppPayload & { zcode_type: "bootstrap-response" } =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === "req-1",
    );

    requester.acceptPayload({
      zcode_type: "app-error",
      requestId: "other",
      reason: "unexpected-error",
      error: "unrelated",
    });
    requester.acceptPayload({
      zcode_type: "app-error",
      requestId: "req-1",
      reason: "desktop-disconnected",
      error: "closed",
    });

    await expect(promise).rejects.toMatchObject({ reason: "desktop-disconnected" });
    expect(sent).toEqual([{ zcode_type: "bootstrap-request", requestId: "req-1" }]);
  });

  it("does not consume unmatched workspace bridge errors", () => {
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: () => true,
      timeoutMs: 100,
    });

    expect(
      requester.acceptPayload({
        zcode_type: "workspace-bridge-error",
        requestId: "remote-session-closed:remote-1",
        bridgeSessionId: "bridge-1",
        reason: "desktop-disconnected",
        error: "remote session closed",
      }),
    ).toBe(false);
  });

  it("rejects a pending request immediately when the transport cannot send it", async () => {
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: () => false,
      timeoutMs: 100,
    });

    const promise = requester.requestAppPayload(
      { zcode_type: "bootstrap-request", requestId: "req-unsent" },
      (payload): payload is WebRemoteControlAppPayload & { zcode_type: "bootstrap-response" } =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === "req-unsent",
    );

    await expect(promise).rejects.toMatchObject({
      reason: "gateway-unreachable",
    });
  });

  it("allows long-running workspace reconnect requests to override the default timeout", async () => {
    vi.useFakeTimers();
    const sent: WebRemoteControlAppPayload[] = [];
    const requester = createWebRemoteControlAppPayloadRequester({
      sendPayload: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 10,
    });
    const promise = requester.requestAppPayload(
      {
        zcode_type: "workspace-reconnect-request",
        requestId: "reconnect-1",
        workspaceKey: "remote:docker:demo:/root",
      },
      (
        payload,
      ): payload is Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "workspace-reconnect-response" }
      > =>
        payload.zcode_type === "workspace-reconnect-response" &&
        payload.requestId === "reconnect-1" &&
        payload.workspaceKey === "remote:docker:demo:/root",
      { timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS },
    );

    await vi.advanceTimersByTimeAsync(11);
    requester.acceptPayload({
      zcode_type: "workspace-reconnect-response",
      requestId: "reconnect-1",
      workspaceKey: "remote:docker:demo:/root",
      success: true,
    });

    await expect(promise).resolves.toMatchObject({ success: true });
    expect(sent).toHaveLength(1);
  });
});
