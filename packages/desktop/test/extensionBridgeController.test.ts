import { createECDH, createHmac, hkdfSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_BRIDGE_EXTENSION_ID,
  EXTENSION_BRIDGE_HKDF_INFO,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
} from "@zcode/shared/browser-extension-transport";
import {
  createExtensionBridgeController,
  type ExtensionBridgeController,
} from "../src/main/extensionBridge/index.js";

interface Received {
  type: string;
}

class TestClient {
  readonly received: ExtensionBridgeServerMessage[] = [];
  private readonly socket: WebSocket;
  private readonly waiters: Array<{
    type: string;
    resolve: (message: ExtensionBridgeServerMessage) => void;
  }> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url, {
      headers: { origin: `chrome-extension://${EXTENSION_BRIDGE_EXTENSION_ID}` },
    });
    this.socket.on("message", (data) => {
      const message = parseExtensionBridgeServerMessage(data.toString());
      this.received.push(message);
      if (message.type === "tabs.list") {
        this.send({
          type: "tabs.list.result",
          requestId: message.requestId,
          ok: true,
          tabs: [{ nativeTabId: 7, active: false, url: "https://example.com/", title: "" }],
        });
      }
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) this.waiters.splice(index, 1)[0]?.resolve(message);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  send(message: ExtensionBridgeClientMessage): void {
    this.socket.send(serializeExtensionBridgeMessage(message));
  }

  async next<T extends ExtensionBridgeServerMessage["type"]>(
    type: T,
  ): Promise<Extract<ExtensionBridgeServerMessage, { type: T }>> {
    const existing = this.received.find((message) => message.type === type);
    if (existing) {
      this.received.splice(this.received.indexOf(existing), 1);
      return existing as Extract<ExtensionBridgeServerMessage, { type: T }>;
    }
    return new Promise((resolve) => {
      this.waiters.push({
        type,
        resolve: (message) =>
          resolve(message as Extract<ExtensionBridgeServerMessage, { type: T }>),
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

function hmacBase64Url(key: string | Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

async function pairProfile(
  controller: ExtensionBridgeController,
  port: number,
  windowId: number,
  profileInstanceId: string,
): Promise<{ client: TestClient; sharedSecret: string }> {
  const ticket = controller.beginPairing(windowId);
  if (!ticket) throw new Error("pairing unavailable");
  const client = new TestClient(`ws://127.0.0.1:${port}`);
  await client.open();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  client.send({
    type: "hello",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    extensionId: EXTENSION_BRIDGE_EXTENSION_ID,
    extensionVersion: "0.1.0",
    profileInstanceId,
    clientPublicKey: ecdh.getPublicKey("base64url", "uncompressed"),
  });
  const required = await client.next("pairing.required");
  expect(required.pairingSessionId).toBe(ticket.pairingSessionId);
  const shared = ecdh.computeSecret(Buffer.from(required.serverPublicKey, "base64url"));
  const sharedSecret = Buffer.from(
    hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(EXTENSION_BRIDGE_HKDF_INFO), 32),
  ).toString("base64url");
  expect(sharedSecret).toBeTruthy();
  client.send({
    type: "pairing.proof",
    pairingSessionId: required.pairingSessionId,
    nonce: required.nonce,
    proof: hmacBase64Url(ticket.pairingCode, required.nonce),
  });
  await client.next("welcome");
  // pairProfile 的 waiter 之外，历史消息仍留在 received；后续 next 只看新消息。
  client.received.length = 0;
  return { client, sharedSecret };
}

async function resumeProfile(
  port: number,
  profileInstanceId: string,
  sharedSecret: string,
): Promise<TestClient> {
  const client = new TestClient(`ws://127.0.0.1:${port}`);
  await client.open();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  client.send({
    type: "hello",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    extensionId: EXTENSION_BRIDGE_EXTENSION_ID,
    extensionVersion: "0.1.0",
    profileInstanceId,
    clientPublicKey: ecdh.getPublicKey("base64url", "uncompressed"),
  });
  const challenge = await client.next("resume.challenge");
  const proof = hmacBase64Url(
    Buffer.from(sharedSecret, "base64url"),
    `client|${challenge.nonce}|${challenge.connectionId}`,
  );
  client.send({ type: "resume.proof", connectionId: challenge.connectionId, proof });
  await client.next("welcome");
  return client;
}

class HostSink {
  readonly messages: Array<Received & Record<string, unknown>> = [];
  readonly postMessage = (message: unknown): void => {
    this.messages.push(message as Received & Record<string, unknown>);
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ExtensionBridgeController window binding", () => {
  it("delivers connections and commands only to the bound window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-controller-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port: 0 });
    cleanups.push(async () => {
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    const port = started.port;
    const profileA = "profile-a-1234567890";
    const profileB = "profile-b-1234567890";
    const { client: first } = await pairProfile(controller, port, 101, profileA);

    const host1 = new HostSink();
    controller.registerHost(101, host1);
    expect(host1.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "extension-connection-changed",
          connected: true,
          profileInstanceId: profileA,
          windowId: "101",
        }),
      ]),
    );

    const { client: second } = await pairProfile(controller, port, 202, profileB);
    const host2 = new HostSink();
    controller.registerHost(202, host2);
    cleanups.push(async () => {
      first.close();
      second.close();
    });
    // profileB 只投递到绑定窗口 202。
    expect(host1.messages.some((message) => message.profileInstanceId === profileB)).toBe(false);
    expect(host2.messages.some((message) => message.profileInstanceId === profileB)).toBe(true);

    const list1 = await controller.handleHostRequest(101, { op: "list" });
    const list2 = await controller.handleHostRequest(202, { op: "list" });
    expect(list1.connections?.map((connection) => connection.profileInstanceId)).toEqual([
      profileA,
    ]);
    expect(list2.connections?.map((connection) => connection.profileInstanceId)).toEqual([
      profileB,
    ]);

    const crossed = await controller.handleHostRequest(101, {
      op: "request",
      profileInstanceId: profileB,
      message: { type: "tabs.list", requestId: "cross-window" },
    });
    expect(crossed).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });

    const allowed = await controller.handleHostRequest(101, {
      op: "request",
      profileInstanceId: profileA,
      message: { type: "tabs.list", requestId: "own-window" },
    });
    expect(allowed).toMatchObject({
      ok: true,
      message: { type: "tabs.list.result", ok: true },
    });
  });

  it("transfers the profile to another window with a larger generation and invalidates the old binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-controller-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port: 0 });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    const profile = "profile-transfer-123456";
    const { client } = await pairProfile(controller, started.port, 101, profile);
    const oldHost = new HostSink();
    const newHost = new HostSink();
    controller.registerHost(101, oldHost);
    controller.registerHost(202, newHost);
    cleanups.push(async () => {
      client.close();
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const before = await controller.handleHostRequest(101, { op: "list" });
    expect(before.connections?.[0]?.generation).toBe(1);

    const transfer = await controller.transferProfile(profile, 202);
    expect(transfer).toEqual({ ok: true });
    await client.next("session.detachAll");
    const welcome = await client.next("welcome");
    expect(welcome.generation).toBe(2);

    // 旧窗口先失效，新窗口再接管；旧 generation 不能再 list/request。
    expect(oldHost.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "extension-connection-changed",
          profileInstanceId: profile,
          connected: false,
          generation: 1,
        }),
      ]),
    );
    expect(newHost.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "extension-connection-changed",
          profileInstanceId: profile,
          connected: true,
          generation: 2,
          windowId: "202",
        }),
      ]),
    );
    const oldList = await controller.handleHostRequest(101, { op: "list" });
    expect(oldList.connections).toEqual([]);
    const oldRequest = await controller.handleHostRequest(101, {
      op: "request",
      profileInstanceId: profile,
      message: { type: "tabs.list", requestId: "old-window" },
    });
    expect(oldRequest).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });

    const newList = await controller.handleHostRequest(202, { op: "list" });
    expect(newList.connections).toEqual([
      expect.objectContaining({ profileInstanceId: profile, generation: 2, windowId: "202" }),
    ]);
    const newRequest = await controller.handleHostRequest(202, {
      op: "request",
      profileInstanceId: profile,
      message: { type: "tabs.list", requestId: "new-window" },
    });
    expect(newRequest).toMatchObject({ ok: true, message: { type: "tabs.list.result" } });
  });

  it("orders transfer as old-window invalidation before new-window binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-controller-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port: 0 });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    const profile = "profile-transfer-order-12345";
    const { client } = await pairProfile(controller, started.port, 101, profile);
    const order: string[] = [];
    controller.registerHost(101, {
      postMessage: (message) => {
        const event = message as { type?: string; connected?: boolean };
        if (event.type === "extension-connection-changed") {
          order.push(`old:${String(event.connected)}`);
        }
      },
    });
    controller.registerHost(202, {
      postMessage: (message) => {
        const event = message as { type?: string; connected?: boolean };
        if (event.type === "extension-connection-changed") {
          order.push(`new:${String(event.connected)}`);
        }
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.length = 0;
    cleanups.push(async () => {
      client.close();
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const transfer = await controller.transferProfile(profile, 202);
    expect(transfer).toEqual({ ok: true });
    expect(order).toEqual(["old:false", "new:true"]);
  });

  it("invalidates the old generation when the Host exits and restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-controller-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port: 0 });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    const profile = "profile-host-exit-123456";
    const { client } = await pairProfile(controller, started.port, 101, profile);
    const oldHost = new HostSink();
    controller.registerHost(101, oldHost);
    cleanups.push(async () => {
      client.close();
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const before = await controller.handleHostRequest(101, { op: "list" });
    expect(before.connections?.[0]?.generation).toBe(1);

    controller.unregisterHost(101);
    const detachAll = await client.next("session.detachAll");
    expect(detachAll.reason).toBe("host_exit");
    const welcome = await client.next("welcome");
    expect(welcome.generation).toBe(2);

    // 同窗口 Host 重启必须拿到新 generation；旧 CLI 持久 generation 不能再匹配。
    await waitFor(async () => {
      const result = await controller.handleHostRequest(101, { op: "list" });
      return result.connections?.[0]?.generation === 2;
    });
    const restartedHost = new HostSink();
    controller.registerHost(101, restartedHost);
    await waitFor(async () => {
      return restartedHost.messages.some(
        (message) =>
          message.type === "extension-connection-changed" &&
          message.connected === true &&
          message.generation === 2,
      );
    });
    const restarted = await controller.handleHostRequest(101, { op: "list" });
    expect(restarted.connections).toEqual([
      expect.objectContaining({ profileInstanceId: profile, generation: 2, windowId: "101" }),
    ]);
  });

  it("keeps the new generation when a replaced connection finalizes late", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-controller-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port: 0 });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    const port = started.port;
    const profile = "profile-replace-123456";
    const { client: first, sharedSecret } = await pairProfile(controller, port, 101, profile);
    const host = new HostSink();
    controller.registerHost(101, host);
    cleanups.push(async () => {
      first.close();
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const replacement = await resumeProfile(port, profile, sharedSecret);
    cleanups.push(async () => replacement.close());
    await waitFor(async () => {
      const current = await controller.handleHostRequest(101, { op: "list" });
      return current.connections?.[0]?.generation === 2;
    });

    // 旧 socket 的 close 可能晚于新连接认证；不得删除新绑定或通知 Host disconnected。
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const disconnects = host.messages.filter(
      (message) => message.profileInstanceId === profile && message.connected === false,
    );
    expect(disconnects).toEqual([]);
    expect(host.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "extension-connection-changed",
          connected: true,
          profileInstanceId: profile,
          generation: 2,
        }),
      ]),
    );

    const current = await controller.handleHostRequest(101, { op: "list" });
    expect(current.connections).toEqual([
      expect.objectContaining({ profileInstanceId: profile, generation: 2 }),
    ]);
    const request = await controller.handleHostRequest(101, {
      op: "request",
      profileInstanceId: profile,
      message: { type: "tabs.list", requestId: "after-replace" },
    });
    expect(request).toMatchObject({ ok: true, message: { type: "tabs.list.result", ok: true } });
  });
});

describe("ExtensionBridgeController settings productization", () => {
  async function createController(port = 0) {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-settings-"));
    const controller = createExtensionBridgeController({ userDataPath: directory, port });
    cleanups.push(async () => {
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    return { controller, port: started.port };
  }

  async function reserveFreePort(): Promise<number> {
    const server = createNetServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it("exposes pairing details only to the initiating window and clears them after pairing", async () => {
    const { controller, port } = await createController();
    const ticket = controller.beginPairing(101);
    expect(ticket).not.toBeNull();
    expect(ticket?.pairingCode).toBeTruthy();
    expect(await controller.getStatus(101)).toMatchObject({
      available: true,
      port,
      pairing: { pairingSessionId: ticket?.pairingSessionId },
    });
    // 其他窗口看不到配对码/会话，也不能取消它。
    expect((await controller.getStatus(202)).pairing).toBeUndefined();
    controller.cancelPairing(202, ticket!.pairingSessionId);
    expect((await controller.getStatus(101)).pairing).toBeDefined();

    const client = new TestClient(`ws://127.0.0.1:${port}`);
    await client.open();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    client.send({
      type: "hello",
      protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      extensionId: EXTENSION_BRIDGE_EXTENSION_ID,
      extensionVersion: "0.1.0",
      profileInstanceId: "profile-settings-hello-1",
      clientPublicKey: ecdh.getPublicKey("base64url", "uncompressed"),
    });
    const required = await client.next("pairing.required");
    expect(required.pairingSessionId).toBe(ticket!.pairingSessionId);
    await waitFor(async () => {
      const status = await controller.getStatus(101);
      return status.pairing?.extensionId === EXTENSION_BRIDGE_EXTENSION_ID;
    });
    expect(await controller.getStatus(101)).toMatchObject({
      pairing: {
        extensionId: EXTENSION_BRIDGE_EXTENSION_ID,
        profileInstanceId: "profile-settings-hello-1",
      },
    });
    client.close();
  });

  it("hides profiles bound to another live window and exposes orphan profiles for takeover", async () => {
    const { controller, port } = await createController();
    const profile = "profile-settings-orphan-1";
    const { client } = await pairProfile(controller, port, 101, profile);
    controller.registerHost(101, new HostSink());
    const targetHost = new HostSink();
    controller.registerHost(202, targetHost);
    cleanups.push(async () => client.close());

    expect((await controller.getStatus(202)).profiles).toEqual([]);
    await expect(
      controller.revokeProfileForWindow(profile, 202),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      controller.transferProfileToWindow(profile, 202),
    ).resolves.toMatchObject({ ok: false });

    // Host 退出后原绑定窗口不再活跃，Profile 成为可被当前窗口接管的孤儿。
    controller.unregisterHost(101);
    await waitFor(async () => (await controller.getStatus(202)).profiles.length === 1);
    expect((await controller.getStatus(202)).profiles[0]).toMatchObject({
      profileInstanceId: profile,
      binding: "unbound",
      connected: true,
    });
    await expect(
      controller.transferProfileToWindow(profile, 202),
    ).resolves.toEqual({ ok: true });
    await client.next("session.detachAll");
    const welcome = await client.next("welcome");
    expect(welcome.generation).toBeGreaterThan(1);
  });

  it("revokes only visible profiles and removes pairing credentials", async () => {
    const { controller, port } = await createController();
    const profile = "profile-settings-revoke-1";
    const { client } = await pairProfile(controller, port, 101, profile);
    controller.registerHost(101, new HostSink());
    cleanups.push(async () => client.close());

    await expect(controller.revokeProfileForWindow(profile, 202)).resolves.toMatchObject({
      ok: false,
    });
    await expect(controller.revokeProfileForWindow(profile, 101)).resolves.toEqual({ ok: true });
    expect((await controller.getStatus(101)).profiles).toEqual([]);
    await expect(
      controller.handleHostRequest(101, {
        op: "request",
        profileInstanceId: profile,
        message: { type: "tabs.list", requestId: "after-revoke" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
  });

  it("changes ports only after the new listener succeeds and rolls back on collision", async () => {
    const { controller, port } = await createController();
    const nextPort = await reserveFreePort();
    await expect(controller.setPort(nextPort)).resolves.toEqual({ ok: true, port: nextPort });
    expect(controller.getConfiguredPort()).toBe(nextPort);

    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockedPort = (blocker.address() as { port: number }).port;
    const blocked = await controller.setPort(blockedPort);
    expect(blocked).toMatchObject({ ok: false });
    // 旧端口恢复监听，配置端点也恢复，不能被一次失败改坏。
    expect(controller.getConfiguredPort()).toBe(nextPort);
    const status = await controller.getStatus(101);
    expect(status.available).toBe(true);
    expect(status.port).toBe(nextPort);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(port).toBeGreaterThan(0);
  });
});

describe("ExtensionBridgeController window-scoped default backend", () => {
  async function createController(directory: string, port = 0) {
    const controller = createExtensionBridgeController({ userDataPath: directory, port });
    const started = await controller.start();
    if (!started.ok || started.port === undefined) throw new Error("controller did not start");
    return { controller, port: started.port };
  }

  it("isolates defaults per window and rejects defaults for profiles not bound here", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-default-"));
    const { controller, port } = await createController(directory);
    cleanups.push(async () => {
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const profileA = "profile-default-window-a-1";
    const profileB = "profile-default-window-b-1";
    const { client: clientA } = await pairProfile(controller, port, 101, profileA);
    const { client: clientB } = await pairProfile(controller, port, 202, profileB);
    cleanups.push(async () => {
      clientA.close();
      clientB.close();
    });
    controller.registerHost(101, new HostSink());
    controller.registerHost(202, new HostSink());

    await expect(
      controller.setDefaultBrowserId(101, `extension:${profileA}`),
    ).resolves.toEqual({ ok: true });
    await expect(
      controller.setDefaultBrowserId(202, `extension:${profileA}`),
    ).resolves.toMatchObject({ ok: false });

    // renderer 重新读取 status 时仍由 Main 的窗口 owner 给出同一个值。
    expect((await controller.getStatus(101)).defaultBrowserId).toBe(`extension:${profileA}`);
    expect((await controller.getStatus(202)).defaultBrowserId).toBeUndefined();

    await expect(
      controller.setDefaultBrowserId(202, `extension:${profileB}`),
    ).resolves.toEqual({ ok: true });
    expect((await controller.getStatus(101)).defaultBrowserId).toBe(`extension:${profileA}`);
    expect((await controller.getStatus(202)).defaultBrowserId).toBe(`extension:${profileB}`);

    await expect(controller.setDefaultBrowserId(101, null)).resolves.toEqual({ ok: true });
    expect((await controller.getStatus(101)).defaultBrowserId).toBeUndefined();
    expect((await controller.getStatus(202)).defaultBrowserId).toBe(`extension:${profileB}`);
  });

  it("falls back to IAB after an app restart instead of persisting a numeric window id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-default-restart-"));
    const first = await createController(directory);
    const profile = "profile-default-restart-1";
    const { client } = await pairProfile(first.controller, first.port, 101, profile);
    first.controller.registerHost(101, new HostSink());
    await first.controller.setDefaultBrowserId(101, `extension:${profile}`);
    expect((await first.controller.getStatus(101)).defaultBrowserId).toBe(`extension:${profile}`);

    client.close();
    await first.controller.stop();
    // 新进程启动后 window id 不能作为跨重启身份；默认安全回落 IAB，但配对凭据仍在。
    const second = await createController(directory);
    cleanups.push(async () => {
      await second.controller.stop();
      await rm(directory, { recursive: true, force: true });
    });
    second.controller.registerHost(101, new HostSink());
    const status = await second.controller.getStatus(101);
    expect(status.profiles).toHaveLength(1);
    expect(status.defaultBrowserId).toBeUndefined();
  });

  it("clears a window default when its profile is transferred or revoked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-default-clear-"));
    const { controller, port } = await createController(directory);
    cleanups.push(async () => {
      await controller.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const profile = "profile-default-transfer-1";
    const { client } = await pairProfile(controller, port, 101, profile);
    cleanups.push(async () => client.close());
    controller.registerHost(101, new HostSink());
    controller.registerHost(202, new HostSink());
    await controller.setDefaultBrowserId(101, `extension:${profile}`);

    // 活动绑定窗口的 Profile 不能被其他窗口枚举/转移；旧窗口退出后成为可接管的孤儿。
    await expect(controller.transferProfileToWindow(profile, 202)).resolves.toMatchObject({
      ok: false,
    });
    controller.unregisterHost(101);
    await waitFor(async () => (await controller.getStatus(202)).profiles.length === 1);
    await expect(controller.transferProfileToWindow(profile, 202)).resolves.toEqual({ ok: true });
    await client.next("session.detachAll");
    await client.next("welcome");
    expect((await controller.getStatus(101)).defaultBrowserId).toBeUndefined();
    expect((await controller.getStatus(202)).defaultBrowserId).toBeUndefined();

    await controller.revokeProfileForWindow(profile, 202);
    expect((await controller.getStatus(202)).profiles).toEqual([]);
  });
});
