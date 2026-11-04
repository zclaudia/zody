import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zody/services";
import { createHostCapabilityStore } from "../src/server-core/hostCapability.js";
import { createCoreHttpServer } from "../src/server-core/http.js";

async function expectWebSocketOpens(url: string): Promise<void> {
  const socket = new WebSocket(url, "zody-generation-2");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, "zody-generation-2");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
  return socket;
}

describe("standalone Server Core ingress", () => {
  const servers: Array<{ close: () => Promise<void>; port: number }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  // fork（bot channels 移除）：原「isolates reverse resource requests between Desktop peers
  // and excludes normal WebSocket clients」用例验证的 TOPIC_RESOURCE_RELAY_CHANNEL 隔离路由
  // 是第三方 IM bot 资源回传链，随 bot channels 整体删除（core.ts/server-core http 的
  // topicResourcePeers 注册已摘除）。

  it("serves server-info on loopback and gates desktop continuous WS", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    const info = await fetch(`http://${server.host}:${server.port}/api/server-info`);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      protocolVersion: 1,
      authRequired: false,
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });

    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zody-generation": "2" },
    });
    expect(rejected.status).toBe(401);

    const capabilityResponse = await fetch(
      `http://${server.host}:${server.port}/api/rpc-host-capability`,
      { method: "POST", headers: { "x-zody-generation": "2" } },
    );
    const capability = (await capabilityResponse.json()) as { capability: string };
    const socket = new WebSocket(`ws://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zody-generation": "2", "x-zody-rpc-host-capability": capability.capability },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.close();
        resolve();
      });
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`unexpected ${response.statusCode}`)),
      );
      socket.once("error", reject);
    });

    // 一次性 ticket：同一 capability 重放必须被拒绝。
    const replayed = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zody-generation": "2", "x-zody-rpc-host-capability": capability.capability },
    });
    expect(replayed.status).toBe(401);
  });

  it("rejects wrong generations without consuming capability and selects the requested protocol", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    expect((await fetch(`${base}/api/rpc-host-capability`, { method: "POST" })).status).toBe(426);
    const response = await fetch(`${base}/api/rpc-host-capability`, {
      method: "POST",
      headers: { "x-zody-generation": "2" },
    });
    const { capability } = (await response.json()) as { capability: string };
    const old = await fetch(`${base}/ws/host`, {
      headers: {
        "x-zody-generation": "1",
        "x-zody-rpc-host-capability": capability,
      },
    });
    expect(old.status).toBe(426);
    const socket = new WebSocket(`ws://${server.host}:${server.port}/ws/host`, {
      headers: {
        "x-zody-generation": "2",
        "x-zody-rpc-host-capability": capability,
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.close();
    const browser = new WebSocket(`ws://${server.host}:${server.port}/ws`, [
      "other",
      "zody-generation-2",
    ]);
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    expect(browser.protocol).toBe("zody-generation-2");
    browser.close();
  });

  it("publishes the installation-scoped server identity supplied by Supervisor", async () => {
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
    });
    servers.push(server);

    await expect(
      fetch(`http://${server.host}:${server.port}/api/server-info`).then((response) =>
        response.json(),
      ),
    ).resolves.toMatchObject({ serverId: "server-installation-id" });
  });

  it("accepts web replayable clients on /ws without a capability", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    await expectWebSocketOpens(`ws://${server.host}:${server.port}/ws`);
  });

  it("closes the HTTP server while an upgraded WebSocket remains open", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    const socket = await openWebSocket(`ws://${server.host}:${server.port}/ws`);
    servers.push(server);

    const completed = await Promise.race([
      server.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);

    socket.terminate();
    servers.splice(servers.indexOf(server), 1);
    expect(completed).toBe(true);
  });

  it("rejects expired host capabilities", async () => {
    let now = 0;
    const server = await createCoreHttpServer(new ServiceCollection(), {
      hostCapabilityStore: createHostCapabilityStore({ ttlMs: 100, now: () => now }),
    });
    servers.push(server);
    const issued = await fetch(`http://${server.host}:${server.port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { "x-zody-generation": "2" },
    });
    const { capability, expiresAt } = (await issued.json()) as {
      capability: string;
      expiresAt: number;
    };
    expect(expiresAt).toBe(100);
    now = 101;
    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zody-generation": "2", "x-zody-rpc-host-capability": capability },
    });
    expect(rejected.status).toBe(401);
  });

  it("rejects an old browser subprotocol before upgrade", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    const socket = new WebSocket(`ws://${server.host}:${server.port}/ws`, "old-protocol");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      socket.once("open", () => reject(new Error("unexpected upgrade")));
      socket.once("error", reject);
    });
    expect(status).toBe(426);
  });

  it("rejects non-loopback listeners until authenticated ingress is implemented", async () => {
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0" }),
    ).rejects.toThrow(/non-loopback.*authentication|loopback/i);
  });
});
