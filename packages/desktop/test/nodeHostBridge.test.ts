import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL,
  isNodeHostBridgeFrame,
  normalizeNodeHostBridgeData,
  type NodeHostBridgeChannel,
  type NodeHostBridgeFrame,
} from "../src/common/nodeHostBridgeProtocol.js";
import {
  createLengthPrefixedV8Channel,
  createProcessIpcChannel,
} from "../src/common/nodeHostBridgeTransport.js";
import {
  createNodeHostBridge,
  type HostParentPortMessageEvent,
  type NodeHostBridge,
} from "../src/host/nodeHostBridge.js";
import {
  createInjectedNodeHostBridge,
  installNodeHostEntryConfig,
  readNodeHostEntryConfig,
} from "../src/host/nodeHostEntryConfig.js";
import { validateHostStorageResources } from "../src/host/hostStorageResources.js";
import { createCandidateNetworkTransportDependencies } from "../src/host/candidateNodeNetwork.js";
import { createHostApiNetworkTransport } from "@zody/services/node";
import {
  NATIVE_HOST_ENTRY_NAME,
  NodeHostProcess,
  assertNativeHostLaunchConfig,
  buildNativeHostLaunchArgs,
  spawnNativeHostProcess,
  type NodeHostChildLike,
} from "../src/main/nodeHostProcess.js";

function createChannelPair() {
  let frameListener: ((frame: NodeHostBridgeFrame) => void) | null = null;
  let closeListener: ((error?: Error) => void) | null = null;
  let closed = false;
  const sent: NodeHostBridgeFrame[] = [];
  const channel: NodeHostBridgeChannel = {
    send(frame) {
      if (closed) return;
      sent.push(frame);
    },
    onFrame(listener) {
      frameListener = listener;
      return () => {
        if (frameListener === listener) frameListener = null;
      };
    },
    onClose(listener) {
      closeListener = listener;
      return () => {
        if (closeListener === listener) closeListener = null;
      };
    },
    close() {
      fail();
    },
  };
  function fail(error?: Error) {
    if (closed) return;
    closed = true;
    closeListener?.(error);
  }
  return {
    channel,
    sent,
    get closed() {
      return closed;
    },
    receive(frame: unknown) {
      frameListener?.(frame as NodeHostBridgeFrame);
    },
    fail,
  };
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const value = fn();
      if (value !== undefined) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 5);
  });
}

class FakeElectronPort extends EventEmitter {
  readonly posted: unknown[] = [];
  started = false;
  closed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class FakeChild extends EventEmitter implements NodeHostChildLike {
  readonly pid = 4242;
  readonly stdout = null;
  readonly stderr = null;
  readonly kill = vi.fn(() => true);
}

const baseNativeConfig = {
  launcherPath: "/opt/zody/native/zody-native",
  cwd: "/opt/zody/runtime",
} as const;

describe("shared Node Host bridge protocol", () => {
  it("validates hello/control/port frames and normalizes binary views", () => {
    expect(isNodeHostBridgeFrame({ v: 1, kind: "hello", hostId: "host-1" })).toBe(true);
    expect(
      isNodeHostBridgeFrame({ v: 1, kind: "control", message: {}, portIds: [1, 2] }),
    ).toBe(true);
    expect(
      isNodeHostBridgeFrame({ v: 1, kind: "control", message: {}, portIds: [1, 1] }),
    ).toBe(false);
    expect(
      isNodeHostBridgeFrame({
        v: 1,
        kind: "control",
        message: {},
        portIds: Array.from({ length: MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL + 1 }, (_, i) => i),
      }),
    ).toBe(false);
    expect(normalizeNodeHostBridgeData(new Uint8Array([1]).buffer)).toEqual(new Uint8Array([1]));
    expect(normalizeNodeHostBridgeData({ flow: "pause" })).toEqual({ flow: "pause" });
  });
});

describe("Host-side Node bridge", () => {
  let bridge: NodeHostBridge | undefined;

  afterEach(() => {
    bridge?.dispose();
    bridge = undefined;
  });

  it("announces hostId, creates surrogate ports, and queues data FIFO until start", () => {
    const fake = createChannelPair();
    bridge = createNodeHostBridge({ channel: fake.channel, hostId: "host-1" });
    expect(fake.sent[0]).toEqual({ v: 1, kind: "hello", hostId: "host-1" });

    const events: HostParentPortMessageEvent[] = [];
    bridge.parentPort.on("message", (event) => events.push(event));
    fake.receive({ v: 1, kind: "control", message: { type: "init" }, portIds: [7] });
    expect(events[0]!.data).toEqual({ type: "init" });
    const port = events[0]!.ports[0]!;
    const received: unknown[] = [];
    port.on("message", (event) => received.push(event.data));

    fake.receive({ v: 1, kind: "port-data", portId: 7, data: "first" });
    fake.receive({ v: 1, kind: "port-data", portId: 7, data: "second" });
    expect(received).toEqual([]);
    port.start();
    expect(received).toEqual(["first", "second"]);
  });

  it("stops draining queued messages when a listener closes the port synchronously", () => {
    const fake = createChannelPair();
    bridge = createNodeHostBridge({ channel: fake.channel, hostId: "host-1" });
    const events: HostParentPortMessageEvent[] = [];
    bridge.parentPort.on("message", (event) => events.push(event));
    fake.receive({ v: 1, kind: "control", message: { type: "init" }, portIds: [1] });
    const port = events[0]!.ports[0]!;
    const received: unknown[] = [];
    port.on("message", (event) => {
      received.push(event.data);
      port.close();
    });
    fake.receive({ v: 1, kind: "port-data", portId: 1, data: "first" });
    fake.receive({ v: 1, kind: "port-data", portId: 1, data: "second" });
    port.start();
    expect(received).toEqual(["first"]);
  });

  it("closes the transport on duplicate portIds, unknown data, and invalid frames", () => {
    const duplicate = createChannelPair();
    bridge = createNodeHostBridge({ channel: duplicate.channel, hostId: "host-1" });
    duplicate.receive({ v: 1, kind: "control", message: {}, portIds: [1] });
    duplicate.receive({ v: 1, kind: "control", message: {}, portIds: [1] });
    expect(bridge.disposed).toBe(true);
    bridge = undefined;

    const unknown = createChannelPair();
    bridge = createNodeHostBridge({ channel: unknown.channel, hostId: "host-1" });
    unknown.receive({ v: 1, kind: "port-data", portId: 99, data: "late" });
    expect(bridge.disposed).toBe(true);
    expect(unknown.closed).toBe(true);
    bridge = undefined;

    const invalid = createChannelPair();
    bridge = createNodeHostBridge({ channel: invalid.channel, hostId: "host-1" });
    invalid.receive({ v: 1, kind: "nope" });
    expect(bridge.disposed).toBe(true);
    bridge = undefined;

    const malformedControl = createChannelPair();
    bridge = createNodeHostBridge({ channel: malformedControl.channel, hostId: "host-1" });
    malformedControl.receive({ v: 1, kind: "control", message: {}, portIds: [1, 1] });
    expect(bridge.disposed).toBe(true);
    expect(malformedControl.closed).toBe(true);
  });

  it("outbound port data/close are idempotent and transport close closes parent+ports", () => {
    const fake = createChannelPair();
    bridge = createNodeHostBridge({ channel: fake.channel, hostId: "host-1" });
    const events: HostParentPortMessageEvent[] = [];
    const parentCloses = vi.fn();
    bridge.parentPort.on("message", (event) => events.push(event));
    bridge.parentPort.once("close", parentCloses);
    fake.receive({ v: 1, kind: "control", message: {}, portIds: [2] });
    const port = events[0]!.ports[0]!;
    const portCloses = vi.fn();
    port.once("close", portCloses);

    port.postMessage({ nested: ["x"] });
    port.close();
    port.close();
    expect(fake.sent.filter((frame) => frame.kind === "port-close")).toEqual([
      { v: 1, kind: "port-close", portId: 2 },
    ]);
    expect(portCloses).toHaveBeenCalledTimes(1);

    fake.fail(new Error("ipc gone"));
    expect(parentCloses).toHaveBeenCalledTimes(1);
  });
});

describe("sealed Node Host entry config", () => {
  const snapshot = (source: string) => ({
    sha256: createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
    source,
  });
  const storageResources = {
    tasksStorageWorker: snapshot("export const kind = 'tasks';"),
    sessionStorageEntry: snapshot("export const kind = 'session';"),
  };

  it("requires embedded storage snapshots instead of reopenable resource paths", () => {
    const verified = validateHostStorageResources(storageResources);
    expect(verified.tasksStorageWorker.sha256).toBe(storageResources.tasksStorageWorker.sha256);
    expect(verified.tasksStorageWorker.workerUrl.protocol).toBe("data:");
    expect(verified.sessionStorageEntry.workerUrl.protocol).toBe("data:");
    expect(() =>
      validateHostStorageResources({
        tasksStorageWorker: {
          sha256: "0".repeat(64),
          source: storageResources.tasksStorageWorker.source,
        },
        sessionStorageEntry: storageResources.sessionStorageEntry,
      }),
    ).toThrow(/tasksStorageWorker digest mismatch/);
  });

  it("only activates through an explicit closure injection", () => {
    const fake = createChannelPair();
    expect(createInjectedNodeHostBridge(process)).toBeNull();
    installNodeHostEntryConfig({
      hostId: "sealed-host",
      storageResources,
      networkTransportDependencies: createCandidateNetworkTransportDependencies(),
      agentRuntime: {
        launcherPath: "/opt/zody/native/zody-native",
        entryName: "cli-entry.mjs",
        cliInFd: 6,
        cliOutFd: 7,
        launchMode: "workspace-relay",
      },
      createChannel: () => fake.channel,
    });
    const injected = createInjectedNodeHostBridge(process);
    expect(injected?.bridge.hostId).toBe("sealed-host");
    expect(injected?.agentRuntime?.cliInFd).toBe(6);
    expect(injected?.agentRuntime?.launchMode).toBe("workspace-relay");
    expect(injected?.storageResources.tasksStorageWorker.sha256).toBe(
      storageResources.tasksStorageWorker.sha256,
    );
    expect(injected?.networkTransportDependencies).toBeDefined();
    expect(fake.sent[0]).toEqual({ v: 1, kind: "hello", hostId: "sealed-host" });
    expect(() =>
      installNodeHostEntryConfig({
        hostId: "replacement-host",
        createChannel: () => createChannelPair().channel,
      }),
    ).toThrow(/already installed/);
    expect(readNodeHostEntryConfig()?.hostId).toBe("sealed-host");
    injected?.bridge.dispose();
  });
});

describe("candidate Node network boundary", () => {
  it("rejects proxy and custom CA explicitly instead of silently going direct", async () => {
    const directFetch = vi.spyOn(globalThis, "fetch");
    try {
      const proxyTransport = createHostApiNetworkTransport(
        async () => ({ httpProxy: "http://proxy.example.com:8080" }),
        createCandidateNetworkTransportDependencies(),
      );
      await expect(proxyTransport.fetch("https://api.example.com/v1")).rejects.toThrow(
        /Proxy and custom CA are not supported/,
      );

      const caTransport = createHostApiNetworkTransport(
        async () => ({ caCertPath: "/tmp/corporate-ca.pem" }),
        createCandidateNetworkTransportDependencies(),
      );
      await expect(caTransport.fetch("https://api.example.com/v1")).rejects.toThrow(
        /Proxy and custom CA are not supported/,
      );
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      directFetch.mockRestore();
    }
  });
});

describe("fd transport", () => {
  it("keeps length-prefixed v8 frames ordered across a duplex", async () => {
    // 根因：两个 PassThrough 互相 pipe 会把同一帧无限回写，测试进程会 OOM。
    // 用两组单向管道拼出真正的双工，避免读写形成环。
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const createPipeDuplex = (inbound: PassThrough, outbound: PassThrough) => {
      const duplex = new Duplex({
        read() {},
        write(chunk, encoding, callback) {
          outbound.write(chunk, encoding, callback);
        },
        destroy(error, callback) {
          inbound.destroy();
          outbound.destroy();
          callback(error);
        },
      });
      inbound.on("data", (chunk: Buffer) => {
        if (!duplex.push(chunk)) inbound.pause();
      });
      return duplex;
    };
    const a = createPipeDuplex(bToA, aToB);
    const b = createPipeDuplex(aToB, bToA);
    const sender = createLengthPrefixedV8Channel(a);
    const receiver = createLengthPrefixedV8Channel(b);
    const received: NodeHostBridgeFrame[] = [];
    receiver.onFrame((frame) => received.push(frame));
    sender.send({ v: 1, kind: "control", message: { type: "init" }, portIds: [1] });
    sender.send({ v: 1, kind: "port-data", portId: 1, data: new Uint8Array([9, 8]) });
    await waitFor(() => (received.length >= 2 ? true : undefined));
    expect(received).toEqual([
      { v: 1, kind: "control", message: { type: "init" }, portIds: [1] },
      { v: 1, kind: "port-data", portId: 1, data: new Uint8Array([9, 8]) },
    ]);
    sender.close();
    receiver.close();
  });

  it("fails closed when a duplex never drains and the send queue reaches its bound", () => {
    const neverDrains = new Duplex({
      highWaterMark: 1,
      read() {},
      write(_chunk, _encoding, _callback) {},
    });
    const channel = createLengthPrefixedV8Channel(neverDrains);
    let closeError: Error | undefined;
    channel.onClose((error) => {
      closeError = error;
    });
    for (let index = 0; index < 1_026; index += 1) {
      channel.send({ v: 1, kind: "port-data", portId: 0, data: index });
    }
    expect(closeError?.message).toMatch(/send queue overflow/);
    expect(neverDrains.destroyed).toBe(true);
  });
});

describe("process IPC transport", () => {
  it("fails closed when send callbacks never complete and the queue reaches its bound", () => {
    const fake = new EventEmitter() as EventEmitter & {
      channel: unknown;
      send: (...args: any[]) => boolean;
    };
    fake.channel = {};
    fake.send = () => false;
    const channel = createProcessIpcChannel(fake);
    let closeError: Error | undefined;
    channel.onClose((error) => {
      closeError = error;
    });
    for (let index = 0; index < 1_026; index += 1) {
      channel.send({ v: 1, kind: "port-data", portId: 0, data: index });
    }
    expect(closeError?.message).toMatch(/send queue overflow/);
  });
});

describe("NodeHostProcess main-side adapter", () => {
  it("adopts hello and forwards control/port frames in order", async () => {
    const fake = createChannelPair();
    const child = new FakeChild();
    const process = new NodeHostProcess(child, { channel: fake.channel });
    const messages: unknown[] = [];
    process.on("message", (message) => messages.push(message));
    fake.receive({ v: 1, kind: "hello", hostId: "host-1" });
    await expect(process.waitForHostId()).resolves.toBe("host-1");

    const port = new FakeElectronPort();
    process.postMessage({ type: "init" }, [port as never]);
    expect(fake.sent[0]).toEqual({
      v: 1,
      kind: "control",
      message: { type: "init" },
      portIds: [0],
    });
    expect(port.started).toBe(true);

    port.emit("message", { data: { flow: "pause" } });
    expect(fake.sent[1]).toEqual({
      v: 1,
      kind: "port-data",
      portId: 0,
      data: { flow: "pause" },
    });
    fake.receive({ v: 1, kind: "control", message: { type: "ready" }, portIds: [] });
    expect(messages).toEqual([{ type: "ready" }]);
    fake.receive({ v: 1, kind: "port-data", portId: 0, data: { echo: 1 } });
    expect(port.posted).toEqual([{ echo: 1 }]);
    fake.receive({ v: 1, kind: "port-close", portId: 0 });
    expect(port.closed).toBe(true);
  });

  it("rejects a conflicting hello, duplicate transfer, and unknown port data", () => {
    const fake = createChannelPair();
    const child = new FakeChild();
    const process = new NodeHostProcess(child, { channel: fake.channel, hostId: "expected" });
    const errors: Error[] = [];
    process.on("error", (error) => errors.push(error));
    fake.receive({ v: 1, kind: "hello", hostId: "different" });
    expect(errors.map((error) => error.message)).toContain(
      "Node Host announced a conflicting hostId",
    );
    expect(child.kill).toHaveBeenCalled();

    const secondFake = createChannelPair();
    const second = new NodeHostProcess(new FakeChild(), { channel: secondFake.channel });
    const port = new FakeElectronPort();
    second.postMessage({ type: "init" }, [port as never]);
    expect(() => second.postMessage({ type: "init" }, [port as never])).toThrow(/already transferred/);
    const freshPort = new FakeElectronPort();
    expect(() => second.postMessage({ type: "init" }, [freshPort as never, port as never])).toThrow(
      /already transferred/,
    );
    secondFake.receive({ v: 1, kind: "port-data", portId: 99, data: "late" });
    expect(secondFake.closed).toBe(true);
  });

  it("closes ports once on exit", () => {
    const fake = createChannelPair();
    const child = new FakeChild();
    const process = new NodeHostProcess(child, { channel: fake.channel, hostId: "host-1" });
    const port = new FakeElectronPort();
    process.postMessage({ type: "init" }, [port as never]);
    const exits: number[] = [];
    process.on("exit", (code) => exits.push(code));
    child.emit("exit", 0, null);
    child.emit("exit", 1, null);
    expect(port.closed).toBe(true);
    expect(exits).toEqual([0]);
  });
});

describe("native Host launch config", () => {
  it("rejects relative launchers, non-whitelisted entries, and ELECTRON_RUN_AS_NODE", () => {
    expect(() =>
      assertNativeHostLaunchConfig({ ...baseNativeConfig, launcherPath: "native" }),
    ).toThrow(/absolute path/);
    expect(() =>
      assertNativeHostLaunchConfig({ ...baseNativeConfig, entryName: "index.mjs" as never }),
    ).toThrow(/entryName/);
    expect(() =>
      assertNativeHostLaunchConfig({ ...baseNativeConfig, env: { ELECTRON_RUN_AS_NODE: "1" } }),
    ).toThrow(/ELECTRON_RUN_AS_NODE/);
    expect(() => assertNativeHostLaunchConfig(baseNativeConfig)).not.toThrow();
    expect(NATIVE_HOST_ENTRY_NAME).toBe("host-entry.mjs");
  });

  it("keeps direct argv unchanged and appends the relay flag only explicitly", () => {
    const directArgs = [
      "--launch-session",
      "--entry-name",
      "host-entry.mjs",
      "--host-fd",
      "5",
    ];
    expect(buildNativeHostLaunchArgs(baseNativeConfig)).toEqual(directArgs);
    expect(buildNativeHostLaunchArgs({ ...baseNativeConfig, launchMode: "direct" })).toEqual(
      directArgs,
    );
    expect(
      buildNativeHostLaunchArgs({ ...baseNativeConfig, launchMode: "workspace-relay" }),
    ).toEqual([...directArgs, "--launch-via-workspace"]);
    expect(() =>
      assertNativeHostLaunchConfig({ ...baseNativeConfig, launchMode: "other" as never }),
    ).toThrow(/launchMode/);
  });

  it.skipIf(process.platform === "win32")(
    "spawns a launcher with fd5 and exchanges hello/control/port frames",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "zody-node-host-fd-"));
      const fixture = fileURLToPath(new URL("./fixtures/nativeHostFdProbe.mjs", import.meta.url));
      const launcher = join(dir, "native-host");
      writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, {
        mode: 0o755,
      });
      chmodSync(launcher, 0o755);
      const hostProcess = spawnNativeHostProcess({
        config: { launcherPath: launcher, cwd: dir },
        label: "native-fd-test",
      });
      try {
        await expect(hostProcess.waitForHostId()).resolves.toBe("probe-host");
        const messages: unknown[] = [];
        hostProcess.on("message", (message) => messages.push(message));
        const port = new FakeElectronPort();
        hostProcess.postMessage({ type: "init" }, [port as never]);
        await waitFor(() => (messages.length > 0 ? true : undefined));
        expect(messages[0]).toEqual({ type: "ready" });
        await waitFor(() => (port.posted.length > 0 ? true : undefined));
        expect(port.posted[0]).toEqual({ echo: "hello" });
        port.emit("message", { data: { ping: 1 } });
        await waitFor(() =>
          port.posted.some(
            (value) => (value as { echo?: { ping?: number } }).echo?.ping === 1,
          ),
        );
        const exited = new Promise<void>((resolve) => hostProcess.once("exit", () => resolve()));
        hostProcess.kill();
        await exited;
      } finally {
        hostProcess.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
