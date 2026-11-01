import { describe, expect, it } from "vitest";
import { ExtensionBridgeClient, type BridgeSocketLike } from "../src/bridgeClient.js";
import type { BridgeClientStorage, BridgeStatus } from "../src/storage.js";
import type { WorkerRequest, WorkerResponse } from "../src/workerProtocol.js";

class FakeSocket implements BridgeSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  onopen: BridgeSocketLike["onopen"] = null;
  onmessage: BridgeSocketLike["onmessage"] = null;
  onclose: BridgeSocketLike["onclose"] = null;
  onerror: BridgeSocketLike["onerror"] = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.onopen?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function createStorage(): BridgeClientStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for test condition");
}

const targetRef = {
  browserId: "extension:profile-instance-1234567890",
  browserGeneration: 1,
  connectionId: "connection-1234567890",
  nativeTabId: 42,
  attachmentId: "attachment-42",
};

function welcome(connectionId: string, generation: number) {
  return {
    type: "welcome" as const,
    connectionId,
    protocolVersion: 1,
    browserId: "extension:profile-instance-1234567890",
    profileInstanceId: "profile-instance-1234567890",
    generation,
    capabilitiesVersion: 1,
  };
}

describe("ExtensionBridgeClient socket identity", () => {
  it("ignores old socket messages/close after a replacement connection is established", async () => {
    const storage = createStorage();
    const sockets: FakeSocket[] = [];
    const workerCalls: WorkerRequest[] = [];
    const statuses: BridgeStatus[] = [];
    const client = new ExtensionBridgeClient({
      storage,
      extensionId: "test-extension",
      extensionVersion: "0.1.0",
      defaultPort: 45678,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      sendToWorker: async (message): Promise<WorkerResponse> => {
        workerCalls.push(message);
        return { ok: true };
      },
      onStatus: (status) => statuses.push(status),
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
    });

    await client.start();
    expect(sockets).toHaveLength(1);
    const oldSocket = sockets[0];
    if (!oldSocket) throw new Error("missing initial socket");
    oldSocket.open();
    await flush();
    expect(oldSocket.sent.map((raw) => JSON.parse(raw).type)).toContain("hello");
    oldSocket.emit(welcome("connection-1234567890", 1));
    await waitFor(() => statuses[statuses.length - 1]?.state === "connected");

    client.forceReconnect();
    await waitFor(() => sockets.length === 2);
    const freshSocket = sockets[1];
    if (!freshSocket) throw new Error("missing replacement socket");
    expect(workerCalls.some((call) => call.op === "detachAll")).toBe(false);
    expect(statuses[statuses.length - 1]?.state).toBe("connecting");

    // 旧 socket 迟到的 host command 不得进入 worker。
    oldSocket.emit({ type: "session.detachAll", reason: "host_exit" });
    oldSocket.emit({
      type: "cdp.request",
      requestId: "old-request",
      targetRef,
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    });
    // 旧 socket 迟到的 close/onopen 也不得清理/重连新连接。
    const sentBefore = oldSocket.sent.length;
    oldSocket.open();
    oldSocket.onclose?.({ code: 1006, reason: "old socket" });
    await flush();

    expect(sockets).toHaveLength(2);
    expect(oldSocket.sent.length).toBe(sentBefore);
    expect(workerCalls.some((call) => call.op === "detachAll")).toBe(false);
    expect(workerCalls.some((call) => call.op === "cdp.request")).toBe(false);
    expect(statuses[statuses.length - 1]?.state).toBe("connecting");

    // 新连接认证后，只有 current socket close 才 detachAll/改状态/重连。
    freshSocket.open();
    await flush();
    freshSocket.emit(welcome("connection-abcdefghijkl", 2));
    await waitFor(() => statuses[statuses.length - 1]?.state === "connected");

    freshSocket.close(1006, "gone");
    await waitFor(
      () =>
        workerCalls.filter((call) => call.op === "detachAll").length === 1 &&
        statuses[statuses.length - 1]?.state === "disconnected",
    );

    client.stop();
  });

  it("awaits session.detachAll before processing subsequent host commands", async () => {
    const storage = createStorage();
    const sockets: FakeSocket[] = [];
    const order: string[] = [];
    let releaseDetach!: () => void;
    const detachGate = new Promise<void>((resolve) => {
      releaseDetach = resolve;
    });
    const client = new ExtensionBridgeClient({
      storage,
      extensionId: "test-extension",
      extensionVersion: "0.1.0",
      defaultPort: 45678,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      sendToWorker: async (message): Promise<WorkerResponse> => {
        order.push(`${message.op}:start`);
        if (message.op === "detachAll") {
          await detachGate;
          order.push("detachAll:done");
        }
        if (message.op === "tabs.create") {
          return {
            ok: true,
            data: { tab: { nativeTabId: 43, active: false, url: "about:blank", title: "" } },
          };
        }
        return { ok: true };
      },
      onStatus: () => undefined,
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
    });

    await client.start();
    const socket = sockets[0];
    if (!socket) throw new Error("missing socket");
    socket.open();
    await flush();
    socket.emit(welcome("connection-1234567890", 1));
    await waitFor(() => socket.sent.some((raw) => JSON.parse(raw).type === "hello"));

    socket.emit({ type: "session.detachAll", reason: "window_transfer" });
    socket.emit({ type: "tabs.create", requestId: "new-tab", active: false });
    await flush();
    // detachAll 未完成时，后续 tabs.create 不能进入 worker。
    expect(order).toEqual(["detachAll:start"]);

    releaseDetach();
    await waitFor(() => order.includes("tabs.create:start"));
    expect(order).toEqual(["detachAll:start", "detachAll:done", "tabs.create:start"]);
    client.stop();
  });

  it("does not create a second socket when connect is called concurrently", async () => {
    const storage = createStorage();
    const sockets: FakeSocket[] = [];
    const client = new ExtensionBridgeClient({
      storage,
      extensionId: "test-extension",
      extensionVersion: "0.1.0",
      defaultPort: 45678,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      sendToWorker: async () => ({ ok: true }),
      onStatus: () => undefined,
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
    });

    const startPromise = client.start();
    client.forceReconnect();
    await startPromise;
    await waitFor(() => sockets.length === 1);
    await flush();
    expect(sockets).toHaveLength(1);
    client.stop();
  });
});
