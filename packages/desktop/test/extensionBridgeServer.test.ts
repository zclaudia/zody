import { createECDH, createHmac, hkdfSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_BRIDGE_HKDF_INFO,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
} from "@zody/shared/browser-extension-transport";
import {
  ExtensionBridgeServer,
  createExtensionPersistentStores,
  createInMemoryExtensionCredentialStore,
  createInMemoryExtensionGenerationStore,
  type ExtensionBridgeLogger,
  type ExtensionPairingTicket,
} from "../src/main/extensionBridge/index.js";

const EXTENSION_ID = "mgbbfehgciopncanakmloajgfomoeepp";
const PROFILE_ID = "profile-instance-1234567890";

function hmacBase64Url(key: string | Buffer, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("base64url");
}

function deriveSharedSecret(
  clientEcdh: ReturnType<typeof createECDH>,
  serverPublicKey: string,
): string {
  const shared = clientEcdh.computeSecret(Buffer.from(serverPublicKey, "base64url"));
  const derived = hkdfSync(
    "sha256",
    shared,
    Buffer.alloc(0),
    Buffer.from(EXTENSION_BRIDGE_HKDF_INFO, "utf8"),
    32,
  );
  return Buffer.from(derived).toString("base64url");
}

function createClientIdentity(): { clientEcdh: ReturnType<typeof createECDH>; publicKey: string } {
  const clientEcdh = createECDH("prime256v1");
  clientEcdh.generateKeys();
  return {
    clientEcdh,
    publicKey: clientEcdh.getPublicKey("base64url", "uncompressed"),
  };
}

interface Waiter {
  predicate: (message: ExtensionBridgeServerMessage) => boolean;
  resolve: (message: ExtensionBridgeServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class TestClient {
  readonly received: ExtensionBridgeServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly waiters: Waiter[] = [];

  private constructor(private readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.on("message", (data) => {
      const message = parseExtensionBridgeServerMessage(data.toString());
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return;
        }
      }
      this.received.push(message);
    });
  }

  static async connect(url: string, origin?: string): Promise<TestClient> {
    const socket = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(message: ExtensionBridgeClientMessage): void {
    this.socket.send(serializeExtensionBridgeMessage(message));
  }

  next<T extends ExtensionBridgeServerMessage["type"]>(
    type: T,
    timeoutMs = 3_000,
  ): Promise<Extract<ExtensionBridgeServerMessage, { type: T }>> {
    const existingIndex = this.received.findIndex((message) => message.type === type);
    if (existingIndex >= 0) {
      const [message] = this.received.splice(existingIndex, 1);
      return Promise.resolve(message as Extract<ExtensionBridgeServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({
        predicate: (message) => message.type === type,
        resolve: (message) =>
          resolve(message as Extract<ExtensionBridgeServerMessage, { type: T }>),
        reject,
        timer,
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

function captureLogger(): { logger: ExtensionBridgeLogger; lines: unknown[][] } {
  const lines: unknown[][] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args);
  };
  return {
    logger: { debug: capture, info: capture, warn: capture, error: capture },
    lines,
  };
}

interface Harness {
  server: ExtensionBridgeServer;
  port: number;
  profileInstanceId: string;
}

const active: Array<{ server: ExtensionBridgeServer; clients: TestClient[] }> = [];

afterEach(async () => {
  for (const entry of active.splice(0)) {
    for (const client of entry.clients) client.close();
    await entry.server.stop();
  }
});

async function startServer(
  overrides: Partial<ConstructorParameters<typeof ExtensionBridgeServer>[0]> = {},
): Promise<Harness> {
  const server = new ExtensionBridgeServer({
    port: 0,
    expectedExtensionId: EXTENSION_ID,
    credentialStore: createInMemoryExtensionCredentialStore(),
    generationStore: createInMemoryExtensionGenerationStore(),
    ...overrides,
  });
  const { port } = await server.start();
  const entry = { server, clients: [] as TestClient[] };
  active.push(entry);
  return { server, port, profileInstanceId: PROFILE_ID };
}

async function connectClient(
  port: number,
  origin = `chrome-extension://${EXTENSION_ID}`,
): Promise<TestClient> {
  const client = await TestClient.connect(`ws://127.0.0.1:${port}`, origin);
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const entry = active[index];
    if (entry && entry.server) {
      entry.clients.push(client);
      break;
    }
  }
  return client;
}

function sendHello(client: TestClient, publicKey: string, profileInstanceId = PROFILE_ID): void {
  client.send({
    type: "hello",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    extensionId: EXTENSION_ID,
    extensionVersion: "0.1.0",
    profileInstanceId,
    clientPublicKey: publicKey,
  });
}

async function pair(
  client: TestClient,
  ticket: ExtensionPairingTicket,
  identity = createClientIdentity(),
): Promise<{
  welcome: Extract<ExtensionBridgeServerMessage, { type: "welcome" }>;
  sharedSecret: string;
}> {
  sendHello(client, identity.publicKey);
  const required = await client.next("pairing.required");
  expect(required.pairingSessionId).toBe(ticket.pairingSessionId);
  const sharedSecret = deriveSharedSecret(identity.clientEcdh, required.serverPublicKey);
  const proof = hmacBase64Url(ticket.pairingCode, required.nonce);
  client.send({
    type: "pairing.proof",
    pairingSessionId: required.pairingSessionId,
    nonce: required.nonce,
    proof,
  });
  const welcome = await client.next("welcome");
  return { welcome, sharedSecret };
}

async function resume(
  client: TestClient,
  sharedSecret: string,
  publicKey: string,
): Promise<Extract<ExtensionBridgeServerMessage, { type: "welcome" }>> {
  sendHello(client, publicKey);
  const challenge = await client.next("resume.challenge");
  const proof = hmacBase64Url(
    Buffer.from(sharedSecret, "base64url"),
    `client|${challenge.nonce}|${challenge.connectionId}`,
  );
  client.send({ type: "resume.proof", connectionId: challenge.connectionId, proof });
  const welcome = await client.next("welcome");
  const expectedServerProof = hmacBase64Url(
    Buffer.from(sharedSecret, "base64url"),
    `server|${challenge.nonce}|${challenge.connectionId}`,
  );
  expect(welcome.serverProof).toBe(expectedServerProof);
  return welcome;
}

describe("ExtensionBridgeServer pairing", () => {
  it("pairs with an HMAC proof and issues monotonic generations across restarts", async () => {
    const credentialStore = createInMemoryExtensionCredentialStore();
    const generationStore = createInMemoryExtensionGenerationStore();
    const harness = await startServer({ credentialStore, generationStore });
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    const { welcome, sharedSecret } = await pair(client, ticket);
    expect(welcome.browserId).toBe(`extension:${PROFILE_ID}`);
    expect(welcome.generation).toBe(1);
    expect(harness.server.isConnected(PROFILE_ID)).toBe(true);
    client.close();
    await harness.server.stop();

    const restarted = await startServer({ credentialStore, generationStore });
    const resumedClient = await connectClient(restarted.port);
    const resumed = await resume(resumedClient, sharedSecret, createClientIdentity().publicKey);
    expect(resumed.generation).toBe(2);
  });

  it("uses the persistent generation cursor and window binding across Main restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zody-extension-generation-"));
    try {
      const firstStores = createExtensionPersistentStores({ userDataPath: directory });
      const first = await startServer({
        credentialStore: firstStores.credentialStore,
        generationStore: firstStores.generationStore,
      });
      const ticket = first.server.beginPairing({ windowId: "window-7" });
      const client = await connectClient(first.port);
      const { welcome, sharedSecret } = await pair(client, ticket);
      expect(welcome.generation).toBe(1);
      expect(first.server.getConnectionInfo(PROFILE_ID)).toMatchObject({ windowId: "window-7" });
      client.close();
      await first.server.stop();
      await firstStores.flush();

      const secondStores = createExtensionPersistentStores({ userDataPath: directory });
      const second = await startServer({
        credentialStore: secondStores.credentialStore,
        generationStore: secondStores.generationStore,
      });
      const resumedClient = await connectClient(second.port);
      const resumed = await resume(resumedClient, sharedSecret, createClientIdentity().publicKey);
      expect(resumed.generation).toBe(2);
      expect(second.server.getConnectionInfo(PROFILE_ID)).toMatchObject({ windowId: "window-7" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a wrong pairing proof and enforces the attempt limit", async () => {
    const harness = await startServer({ maxPairingAttempts: 1 });
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const identity = createClientIdentity();

    const first = await connectClient(harness.port);
    sendHello(first, identity.publicKey);
    const firstRequired = await first.next("pairing.required");
    first.send({
      type: "pairing.proof",
      pairingSessionId: firstRequired.pairingSessionId,
      nonce: firstRequired.nonce,
      proof: hmacBase64Url("wrong-code", firstRequired.nonce),
    });
    const firstFatal = await first.next("fatalError");
    expect(firstFatal.code).toBe("pairing_failed");
    await first.closed;

    const second = await connectClient(harness.port);
    sendHello(second, identity.publicKey);
    const secondRequired = await second.next("pairing.required");
    expect(secondRequired.pairingSessionId).toBe(ticket.pairingSessionId);
    second.send({
      type: "pairing.proof",
      pairingSessionId: secondRequired.pairingSessionId,
      nonce: secondRequired.nonce,
      proof: hmacBase64Url("still-wrong", secondRequired.nonce),
    });
    const secondFatal = await second.next("fatalError");
    expect(secondFatal.code).toBe("pairing_attempts_exceeded");
  });

  it("expires a pairing challenge by TTL", async () => {
    let clock = 1_000;
    const harness = await startServer({
      now: () => clock,
      pairingTtlMs: 1_000,
    });
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    const identity = createClientIdentity();
    sendHello(client, identity.publicKey);
    const required = await client.next("pairing.required");
    clock = 5_000;
    client.send({
      type: "pairing.proof",
      pairingSessionId: required.pairingSessionId,
      nonce: required.nonce,
      proof: hmacBase64Url(ticket.pairingCode, required.nonce),
    });
    const fatal = await client.next("fatalError");
    expect(fatal.code).toBe("pairing_expired");
  });

  it("rejects a connection that never sends a proof", async () => {
    const harness = await startServer({ handshakeTimeoutMs: 300 });
    harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    sendHello(client, createClientIdentity().publicKey);
    await client.next("pairing.required");
    const fatal = await client.next("fatalError", 2_000);
    expect(fatal.code).toBe("unauthorized");
    const closed = await client.closed;
    expect(closed.code).toBe(4002);
  });

  it("rejects resume proofs built from an old nonce", async () => {
    const harness = await startServer();
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const identity = createClientIdentity();
    const first = await connectClient(harness.port);
    const { sharedSecret } = await pair(first, ticket, identity);
    first.close();
    await first.closed;

    const second = await connectClient(harness.port);
    sendHello(second, identity.publicKey);
    const challenge = await second.next("resume.challenge");
    const replayedNonce = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const proof = hmacBase64Url(
      Buffer.from(sharedSecret, "base64url"),
      `client|${replayedNonce}|${challenge.connectionId}`,
    );
    second.send({ type: "resume.proof", connectionId: challenge.connectionId, proof });
    const fatal = await second.next("fatalError");
    expect(fatal.code).toBe("resume_failed");
  });

  it("serializes concurrent proof frames into one authentication and one generation", async () => {
    let generationCalls = 0;
    let authenticated = 0;
    const harness = await startServer({
      generationStore: {
        async next() {
          generationCalls += 1;
          return generationCalls;
        },
      },
      onAuthenticated: () => {
        authenticated += 1;
      },
    });
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const identity = createClientIdentity();
    const client = await connectClient(harness.port);
    sendHello(client, identity.publicKey);
    const required = await client.next("pairing.required");
    const proof = hmacBase64Url(ticket.pairingCode, required.nonce);
    const proofMessage = {
      type: "pairing.proof" as const,
      pairingSessionId: required.pairingSessionId,
      nonce: required.nonce,
      proof,
    };
    // 两帧不等待前帧完成；服务端必须串行推进，不能双重认证/领取两次 generation。
    client.send(proofMessage);
    client.send(proofMessage);

    const welcome = await client.next("welcome");
    expect(welcome.generation).toBe(1);
    const closed = await client.closed;
    expect(closed.code).toBe(4002);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generationCalls).toBe(1);
    expect(authenticated).toBe(1);
    expect(harness.server.isConnected(PROFILE_ID)).toBe(false);
  });

  it("serializes concurrent hello frames and rejects the duplicate", async () => {
    const harness = await startServer();
    harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    const identity = createClientIdentity();
    sendHello(client, identity.publicKey);
    sendHello(client, identity.publicKey);

    const required = await client.next("pairing.required");
    expect(required.pairingSessionId).toBeTruthy();
    const fatal = await client.next("fatalError");
    expect(fatal.code).toBe("unauthorized");
  });

  it("keeps only one authenticated socket per profile", async () => {
    const harness = await startServer();
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const identity = createClientIdentity();
    const first = await connectClient(harness.port);
    const { sharedSecret } = await pair(first, ticket, identity);

    const second = await connectClient(harness.port);
    const resumeWelcome = await resume(second, sharedSecret, identity.publicKey);
    expect(resumeWelcome.generation).toBe(2);
    const firstClose = await first.closed;
    expect(firstClose.code).toBe(4001);
    expect(harness.server.isConnected(PROFILE_ID)).toBe(true);
    expect(harness.server.getConnectionInfo(PROFILE_ID)?.connectionId).toBe(
      resumeWelcome.connectionId,
    );
  });
});

describe("ExtensionBridgeServer security boundaries", () => {
  it("fails clearly when the loopback port is already in use", async () => {
    const first = await startServer();
    const second = new ExtensionBridgeServer({
      port: first.port,
      expectedExtensionId: EXTENSION_ID,
      credentialStore: createInMemoryExtensionCredentialStore(),
      generationStore: createInMemoryExtensionGenerationStore(),
    });
    await expect(second.start()).rejects.toMatchObject({ code: "port_in_use" });
    await second.stop();
  });

  it("rejects an unexpected Origin before reading any message", async () => {
    const harness = await startServer();
    const client = await connectClient(harness.port, "chrome-extension://wrong-extension-id");
    const closed = await client.closed;
    expect(closed.code).toBe(4403);
  });

  it("does not log pairing codes, shared secrets, nonces or proofs", async () => {
    const { logger, lines } = captureLogger();
    const harness = await startServer({ logger });
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    const { sharedSecret } = await pair(client, ticket);
    client.close();
    await firstClosed(client);

    const serialized = JSON.stringify(lines);
    const identity = createClientIdentity();
    const probe = await connectClient(harness.port);
    sendHello(probe, identity.publicKey);
    const challenge = await probe.next("resume.challenge");
    expect(serialized).not.toContain(ticket.pairingCode);
    expect(serialized).not.toContain(sharedSecret);
    expect(serialized).not.toContain(challenge.nonce);
  });
});

async function firstClosed(client: TestClient): Promise<void> {
  await client.closed;
}

describe("ExtensionBridgeServer request correlation", () => {
  it("settles results, rejects reused request ids and ignores late results", async () => {
    const harness = await startServer();
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    await pair(client, ticket);

    const first = harness.server.request(PROFILE_ID, { type: "tabs.list", requestId: "r1" });
    const list = await client.next("tabs.list");
    client.send({
      type: "tabs.list.result",
      requestId: list.requestId,
      ok: true,
      tabs: [],
    });
    await expect(first).resolves.toMatchObject({ type: "tabs.list.result", requestId: "r1" });

    await expect(
      harness.server.request(PROFILE_ID, { type: "tabs.list", requestId: "r1" }),
    ).rejects.toMatchObject({ code: "duplicate_request_id" });

    const slow = harness.server.request(PROFILE_ID, { type: "tabs.list", requestId: "slow" }, 50);
    const slowList = await client.next("tabs.list");
    await expect(slow).rejects.toMatchObject({ code: "request_timeout" });
    // 扩展在超时后仍发回迟到结果；它不能被后续新请求消费。
    client.send({
      type: "tabs.list.result",
      requestId: slowList.requestId,
      ok: true,
      tabs: [],
    });

    const fresh = harness.server.request(PROFILE_ID, { type: "tabs.list", requestId: "fresh" });
    const freshList = await client.next("tabs.list");
    client.send({
      type: "tabs.list.result",
      requestId: freshList.requestId,
      ok: true,
      tabs: [],
    });
    await expect(fresh).resolves.toMatchObject({ type: "tabs.list.result", requestId: "fresh" });
  });

  it("rejects a CDP result larger than 4 MiB and releases the pending entry", async () => {
    const harness = await startServer();
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    await pair(client, ticket);

    const targetRef = {
      browserId: `extension:${PROFILE_ID}`,
      browserGeneration: 1,
      connectionId: harness.server.getConnectionInfo(PROFILE_ID)?.connectionId ?? "",
      nativeTabId: 9,
      attachmentId: "attachment-9",
    };
    const pending = harness.server.request(
      PROFILE_ID,
      {
        type: "cdp.request",
        requestId: "huge",
        targetRef,
        method: "Runtime.evaluate",
        params: { expression: "document.body.innerHTML" },
      },
      2_000,
    );
    const request = await client.next("cdp.request");
    client.send({
      type: "cdp.result",
      requestId: request.requestId,
      attachmentId: "attachment-9",
      nativeTabId: 9,
      ok: true,
      result: { payload: "x".repeat(4 * 1024 * 1024 + 1) },
    });
    await expect(pending).rejects.toMatchObject({ code: "result_too_large" });
    await expect(
      harness.server.request(PROFILE_ID, { type: "tabs.list", requestId: "huge" }),
    ).rejects.toMatchObject({ code: "duplicate_request_id" });
  });

  it("does not let a mismatched or stale attachment result settle a CDP request", async () => {
    const harness = await startServer();
    const ticket = harness.server.beginPairing({ windowId: "window-1" });
    const client = await connectClient(harness.port);
    await pair(client, ticket);

    const targetRef = {
      browserId: `extension:${PROFILE_ID}`,
      browserGeneration: 1,
      connectionId: harness.server.getConnectionInfo(PROFILE_ID)?.connectionId ?? "",
      nativeTabId: 7,
      attachmentId: "attachment-7",
    };
    const pending = harness.server.request(
      PROFILE_ID,
      {
        type: "cdp.request",
        requestId: "c1",
        targetRef,
        method: "Runtime.evaluate",
        params: { expression: "1+1" },
      },
      2_000,
    );
    await client.next("cdp.request");
    client.send({
      type: "cdp.result",
      requestId: "c1",
      attachmentId: "different-attachment",
      nativeTabId: 7,
      ok: true,
      result: { value: 2 },
    });
    client.send({
      type: "cdp.result",
      requestId: "c1",
      attachmentId: "attachment-7",
      nativeTabId: 7,
      ok: true,
      result: { value: 2 },
    });
    await expect(pending).resolves.toMatchObject({
      type: "cdp.result",
      attachmentId: "attachment-7",
    });
  });
});
