import { describe, expect, it } from "vitest";
import { createExtensionTransportClient } from "../src/host/extensionTransportClient.js";

const PROFILE = "profile-instance-1234567890";

function createClient() {
  const posted: Array<Record<string, unknown>> = [];
  const client = createExtensionTransportClient({
    postToMain: (message) => posted.push(message as Record<string, unknown>),
    timeoutMs: 60_000,
  });
  return { client, posted };
}

describe("ExtensionTransportClient lifecycle", () => {
  it("rejects pending requests immediately when the connection closes", async () => {
    const { client, posted } = createClient();
    client.handleConnectionChanged({
      connected: true,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 1,
      connectionId: "connection-1",
    });
    const pending = client.request(PROFILE, { type: "tabs.list", requestId: "r1" });
    const hostRequest = posted[0];
    if (!hostRequest) throw new Error("request was not posted");

    client.handleConnectionChanged({
      connected: false,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 1,
      connectionId: "connection-1",
    });
    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    // 迟到的传输结果不能再结算已清理的 entry。
    client.handleResult({
      requestId: String(hostRequest.requestId),
      ok: true,
      message: { type: "tabs.list.result", requestId: "r1", ok: true, tabs: [] },
    });
    expect(client.getConnection(PROFILE)).toBeUndefined();
  });

  it("rejects old pending requests when a new generation replaces the binding", async () => {
    const { client } = createClient();
    client.handleConnectionChanged({
      connected: true,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 1,
      connectionId: "connection-1",
    });
    const pending = client.request(PROFILE, { type: "tabs.list", requestId: "r1" });
    client.handleConnectionChanged({
      connected: true,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 2,
      connectionId: "connection-2",
    });
    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(client.getConnection(PROFILE)).toMatchObject({ generation: 2 });
  });

  it("aborts a pending request via signal without settling a later same-key request", async () => {
    const { client } = createClient();
    client.handleConnectionChanged({
      connected: true,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 1,
      connectionId: "connection-1",
    });
    const controller = new AbortController();
    const pending = client.request(
      PROFILE,
      { type: "tabs.list", requestId: "r1" },
      undefined,
      controller.signal,
    );
    controller.abort(
      Object.assign(new Error("cancelled"), { code: "cancelled", sideEffect: "none" }),
    );
    await expect(pending).rejects.toMatchObject({ code: "cancelled", sideEffect: "none" });

    const fresh = client.request(PROFILE, { type: "tabs.list", requestId: "r2" });
    expect(client.getConnection(PROFILE)?.generation).toBe(1);
    // cleanup
    client.handleConnectionChanged({
      connected: false,
      profileInstanceId: PROFILE,
      browserId: `extension:${PROFILE}`,
      generation: 1,
      connectionId: "connection-1",
    });
    await expect(fresh).rejects.toMatchObject({ code: "backend_unavailable" });
  });
});
