import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  ControlChannelClosedError,
  ControlChannelError,
  createControlChannel,
} from "../control-channel.js";
import type {
  ControlChannel,
  ControlChannelAckResult,
  ControlChannelClosedEvent,
  CreateControlChannelOptions,
} from "../control-channel.js";
import type { ControlBinding } from "../control-protocol.js";

const controllerKeys = generateKeyPairSync("ed25519");
const producerKeys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");

const binding: ControlBinding = {
  channelId: "channel-1",
  controllerIncarnation: "controller-incarnation",
  producerIncarnation: "producer-incarnation",
  appIncarnation: "app-incarnation",
};

const PASSIVE_ACK: ControlChannelAckResult = {
  phase: "revoked",
  facts: {
    projection: { admissionClosed: true, projectionApplied: true },
    revoked: { authorizationRevoked: true },
    stop: null,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function socketPair(): Promise<{ left: Socket; right: Socket }> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const rightPromise = once(server, "connection") as Promise<[Socket]>;
  const left = net.connect({ host: "127.0.0.1", port: address.port });
  await once(left, "connect");
  const [right] = await rightPromise;
  left.setNoDelay(true);
  right.setNoDelay(true);
  server.close();
  return { left, right };
}

function channelFor(
  duplex: Duplex,
  role: "controller" | "producer",
  overrides: Partial<CreateControlChannelOptions> = {},
): ControlChannel {
  const controller = role === "controller";
  return createControlChannel({
    duplex,
    role,
    binding,
    keyId: controller ? "controller-key" : "producer-key",
    privateKey: controller ? controllerKeys.privateKey : producerKeys.privateKey,
    trustedKeys: controller
      ? { "producer-key": producerKeys.publicKey }
      : { "controller-key": controllerKeys.publicKey },
    onRequest: () => PASSIVE_ACK,
    requestTimeoutMs: 5_000,
    ...overrides,
  });
}

function passiveDuplex(): Duplex {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("control channel API", () => {
  it("copies binding and trusted keys and keeps request/ACK round-trip working", async () => {
    const { left, right } = await socketPair();
    const mutableBinding: ControlBinding = { ...binding };
    const mutableTrust: Record<string, KeyObject> = {
      "controller-key": controllerKeys.publicKey,
    };
    let producer!: ControlChannel;
    producer = channelFor(right, "producer", {
      binding: mutableBinding,
      trustedKeys: mutableTrust,
      onRequest: async (request) => {
        if (request.body.payload.operation === "stop") {
          const revoke = await producer.request({
            operation: "revoke_submission",
            submissionLineageId: request.body.submissionLineageId,
            authorizationRevision: request.body.authorizationRevision,
          });
          return {
            phase: "admission_closed",
            facts: {
              projection: { admissionClosed: true, projectionApplied: true },
              revoked: { authorizationRevoked: revoke.evaluation.revoked.complete },
              stop: {
                nativeFenced: false,
                pending: true,
                ownedInputsReleased: false,
                leaseReleased: false,
              },
            },
          };
        }
        return PASSIVE_ACK;
      },
    });
    let revokeSequence = 0;
    const controller = channelFor(left, "controller", {
      binding: mutableBinding,
      onRequest: (request) => {
        revokeSequence = request.body.sequence;
        return PASSIVE_ACK;
      },
    });
    mutableBinding.channelId = "mutated-after-construction";
    mutableTrust["controller-key"] = otherKeys.publicKey;

    const result = await controller.request({
      operation: "stop",
      submissionLineageId: "lineage-1",
      authorizationRevision: 1,
    });
    expect(result.evaluation.projection.complete).toBe(true);
    expect(result.evaluation.revoked.complete).toBe(true);
    expect(result.evaluation.stop?.complete).toBe(false);
    expect(result.evaluation.stop?.nativeFenced).toBe(false);
    expect(result.sequence).toBe(1);
    expect(result.ack.body.sequence).toBe(2);
    expect(revokeSequence).toBe(1);
    expect(controller.binding.channelId).toBe("channel-1");
    expect(Object.isFrozen(controller.binding)).toBe(true);
    await controller.dispose();
    await producer.dispose();
  });

  it("rejects missing keys and private key material in trustedKeys", () => {
    const duplex = passiveDuplex();
    expect(() =>
      createControlChannel({ duplex } as unknown as CreateControlChannelOptions),
    ).toThrow(ControlChannelError);
    expect(() =>
      channelFor(duplex, "controller", {
        trustedKeys: { "producer-key": producerKeys.privateKey },
      }),
    ).toThrow(/public key|private key/);
    duplex.destroy();
  });

  it("reads request input strictly and rejects getters without closing", async () => {
    const duplex = passiveDuplex();
    const channel = channelFor(duplex, "controller");
    await expect(
      channel.request({
        operation: "stop",
        submissionLineageId: "lineage-1",
        authorizationRevision: 1,
        extra: true,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" } satisfies Partial<ControlChannelError>);
    const hostile = Object.defineProperty(
      {
        operation: "stop" as const,
        submissionLineageId: "lineage-1",
        authorizationRevision: 1,
      },
      "signal",
      {
        enumerable: true,
        get() {
          throw new Error("getter must not run");
        },
      },
    );
    await expect(channel.request(hostile)).rejects.toMatchObject({ code: "invalid_request" });
    expect(channel.closed).toBe(false);
    await channel.close();
  });

  it("waits for the real delayed transport close before resolving close()", async () => {
    const destroyStarted = deferred<void>();
    const allowDestroy = deferred<void>();
    const duplex = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
      destroy(error, callback) {
        destroyStarted.resolve();
        void allowDestroy.promise.then(() => callback(error));
      },
    });
    const channel = channelFor(duplex, "controller");
    let settled = false;
    const closing = channel.close().then(() => {
      settled = true;
    });
    await destroyStarted.promise;
    expect(settled).toBe(false);
    expect(duplex.closed).toBe(false);
    allowDestroy.resolve();
    await closing;
    expect(settled).toBe(true);
    expect(duplex.closed).toBe(true);
  });

  it("resolves close immediately when the transport was already closed", async () => {
    const duplex = passiveDuplex();
    duplex.destroy();
    await once(duplex, "close");
    const channel = channelFor(duplex, "controller");
    await channel.close();
    expect(duplex.closed).toBe(true);
  });

  it("rejects streams without Node Duplex emitClose semantics", () => {
    const duplex = new Duplex({
      emitClose: false,
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    expect(() => channelFor(duplex, "controller")).toThrow(/emitClose/);
    duplex.destroy();
  });

  it("rejects close when destroy throws and notifies the owner once", async () => {
    const duplex = passiveDuplex();
    const originalDestroy = duplex.destroy.bind(duplex);
    (duplex as unknown as { destroy: () => void }).destroy = () => {
      throw new Error("destroy failed");
    };
    const events: ControlChannelClosedEvent[] = [];
    const channel = channelFor(duplex, "controller", {
      onClosed: (event) => {
        events.push(event);
      },
    });
    await expect(channel.close()).rejects.toThrow("destroy failed");
    expect(channel.closed).toBe(true);
    expect(events).toHaveLength(1);
    const transportClosed = once(duplex, "close");
    originalDestroy();
    await transportClosed;
  });

  it("contains internal close failures instead of surfacing unhandled rejections", async () => {
    const duplex = passiveDuplex();
    const originalDestroy = duplex.destroy.bind(duplex);
    (duplex as unknown as { destroy: () => void }).destroy = () => {
      throw new Error("internal destroy failed");
    };
    const closedEvent = deferred<ControlChannelClosedEvent>();
    const channel = channelFor(duplex, "controller", {
      requestTimeoutMs: 10,
      onClosed: (event) => closedEvent.resolve(event),
    });
    const pending = channel.request({
      operation: "stop",
      submissionLineageId: "lineage-timeout-close",
      authorizationRevision: 1,
    });
    await expect(pending).rejects.toBeInstanceOf(ControlChannelClosedError);
    await expect(closedEvent.promise).resolves.toMatchObject({ code: "request_timeout" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(channel.closed).toBe(true);
    originalDestroy();
  });

  it("settles abort, dispose, pending capacity and timeout without success", async () => {
    const { left, right } = await socketPair();
    const closedEvents: string[] = [];
    const channel = channelFor(left, "controller", {
      maxPendingRequests: 2,
      requestTimeoutMs: 5_000,
      onClosed: (event) => {
        closedEvents.push(event.code);
      },
    });
    const first = channel.request({
      operation: "stop",
      submissionLineageId: "lineage-abort",
      authorizationRevision: 1,
    });
    const abort = new AbortController();
    const aborted = channel.request({
      operation: "stop",
      submissionLineageId: "lineage-abort-2",
      authorizationRevision: 1,
      signal: abort.signal,
    });
    await expect(
      channel.request({
        operation: "stop",
        submissionLineageId: "lineage-overflow",
        authorizationRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "pending_overflow" });
    abort.abort();
    await expect(first).rejects.toBeInstanceOf(ControlChannelClosedError);
    await expect(aborted).rejects.toBeInstanceOf(ControlChannelClosedError);
    await channel.close();
    expect(closedEvents).toEqual(["request_aborted"]);
    expect(channel.closeCode).toBe("request_aborted");
    right.destroy();
  });

  it("closes on handler errors without manufacturing an ACK", async () => {
    const { left, right } = await socketPair();
    const producerClosed = deferred<string>();
    const producer = channelFor(right, "producer", {
      onRequest: () => {
        throw new Error("owner handler failed");
      },
      onClosed: (event) => producerClosed.resolve(event.code),
    });
    const controller = channelFor(left, "controller");
    const request = controller.request({
      operation: "stop",
      submissionLineageId: "lineage-handler",
      authorizationRevision: 1,
    });
    await expect(request).rejects.toBeInstanceOf(ControlChannelClosedError);
    await expect(producerClosed.promise).resolves.toBe("handler_error");
    expect(producer.closed).toBe(true);
    await producer.close();
    await controller.close();
  });
});
