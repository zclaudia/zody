import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { ControlChannelClosedError, createControlChannel } from "../control-channel.js";
import type {
  ControlChannel,
  ControlChannelAckResult,
  ControlChannelClosedEvent,
} from "../control-channel.js";
import { createControlRequest, signControlBody } from "../control-protocol.js";
import type { ControlAckBody, ControlBinding, ControlRequestBody } from "../control-protocol.js";

const controllerKeys = generateKeyPairSync("ed25519");
const producerKeys = generateKeyPairSync("ed25519");

const binding: ControlBinding = {
  channelId: "channel-frames",
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

class JsonlFrames {
  private buffer = Buffer.alloc(0);
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(frame: unknown) => void> = [];

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const index = this.buffer.indexOf(0x0a);
        if (index < 0) {
          return;
        }
        const text = this.buffer.subarray(0, index).toString("utf8");
        this.buffer = this.buffer.subarray(index + 1);
        const frame: unknown = JSON.parse(text);
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(frame);
        } else {
          this.frames.push(frame);
        }
      }
    });
  }

  next(): Promise<unknown> {
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return Promise.resolve(frame);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function request(sequence: number, overrides: Partial<ControlRequestBody> = {}) {
  return createControlRequest(
    {
      keyId: "producer-key",
      direction: "producer_to_controller",
      binding,
      messageId: `producer-revoke-${sequence}`,
      sequence,
      submissionLineageId: `lineage-${sequence}`,
      authorizationRevision: 1,
      operation: "revoke_submission",
      ...overrides,
    } as never,
    producerKeys.privateKey,
  );
}

function frame(envelope: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function channelFor(
  duplex: Duplex,
  onRequest: (requestValue: {
    body: ControlRequestBody;
  }) => ControlChannelAckResult | Promise<ControlChannelAckResult>,
  overrides: Record<string, unknown> = {},
): { channel: ControlChannel; closed: Promise<ControlChannelClosedEvent[]> } {
  const events: ControlChannelClosedEvent[] = [];
  let resolveClosed!: (value: ControlChannelClosedEvent[]) => void;
  const closed = new Promise<ControlChannelClosedEvent[]>((resolve) => {
    resolveClosed = resolve;
  });
  const channel = createControlChannel({
    duplex,
    role: "controller",
    binding,
    keyId: "controller-key",
    privateKey: controllerKeys.privateKey,
    trustedKeys: { "producer-key": producerKeys.publicKey },
    onRequest,
    requestTimeoutMs: 5_000,
    onClosed: (event) => {
      events.push(event);
      resolveClosed(events);
    },
    ...overrides,
  });
  return { channel, closed };
}

async function firstEvent(
  closed: Promise<ControlChannelClosedEvent[]>,
): Promise<ControlChannelClosedEvent> {
  const [event] = await closed;
  if (event === undefined) {
    throw new Error("expected a control channel close event");
  }
  return event;
}

describe("control channel framing and replay", () => {
  it("handles fragmented input and multiple frames in one chunk", async () => {
    const { left, right } = await socketPair();
    const frames = new JsonlFrames(right);
    let handled = 0;
    const { channel } = channelFor(left, () => {
      handled += 1;
      return PASSIVE_ACK;
    });
    const bytes = Buffer.concat([frame(request(1)), frame(request(2))]);
    right.write(bytes.subarray(0, 31));
    await new Promise<void>((resolve) => setImmediate(resolve));
    right.write(bytes.subarray(31));
    const ack1 = (await frames.next()) as { body: ControlAckBody };
    const ack2 = (await frames.next()) as { body: ControlAckBody };
    expect(handled).toBe(2);
    expect(ack1.body.replyToMessageId).toBe("producer-revoke-1");
    expect(ack2.body.replyToMessageId).toBe("producer-revoke-2");
    expect(ack1.body.sequence).toBe(1);
    expect(ack2.body.sequence).toBe(2);
    await channel.close();
    right.destroy();
  });

  it("closes on oversized frames and real socket close", async () => {
    const { left, right } = await socketPair();
    right.on("error", () => {});
    const { channel, closed } = channelFor(left, () => PASSIVE_ACK, {
      maxFrameBytes: 256,
      maxOutboundBytes: 512,
    });
    const peerClosed = once(right, "close");
    right.write(Buffer.alloc(300, 0x61));
    const event = await firstEvent(closed);
    await peerClosed;
    expect(event.code).toBe("frame_too_large");
    expect(channel.closeCode).toBe("frame_too_large");
    await channel.close();
  });

  it("closes on invalid UTF-8, incomplete EOF and tampered signatures", async () => {
    for (const scenario of ["utf8", "eof", "tamper"] as const) {
      const { left, right } = await socketPair();
      right.on("error", () => {});
      const { channel, closed } = channelFor(left, () => PASSIVE_ACK);
      if (scenario === "utf8") {
        right.write(Buffer.from([0xff, 0x0a]));
      } else if (scenario === "eof") {
        const bytes = frame(request(1));
        right.end(bytes.subarray(0, bytes.length - 5));
      } else {
        const envelope = request(1);
        const tampered = structuredClone(envelope);
        tampered.body.submissionLineageId = "tampered-lineage";
        right.write(frame(tampered));
      }
      const event = await firstEvent(closed);
      expect(event.code).toBe("protocol_error");
      const cause = event.cause as { code?: string } | null;
      expect(cause?.code).toBe(
        scenario === "utf8"
          ? "invalid_utf8"
          : scenario === "eof"
            ? "incomplete_frame"
            : "invalid_signature",
      );
      await channel.close();
      right.destroy();
    }
  });

  it("deduplicates requests and replays the bounded cached ACK", async () => {
    const { left, right } = await socketPair();
    const frames = new JsonlFrames(right);
    let handled = 0;
    const { channel } = channelFor(left, () => {
      handled += 1;
      return PASSIVE_ACK;
    });
    const envelope = request(1);
    right.write(Buffer.concat([frame(envelope), frame(envelope)]));
    const first = (await frames.next()) as { body: ControlAckBody; signature: string };
    const second = (await frames.next()) as { body: ControlAckBody; signature: string };
    expect(handled).toBe(1);
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(second.body.sequence).toBe(first.body.sequence);
    expect(second.signature).toBe(first.signature);
    await channel.close();
    right.destroy();
  });

  it("closes on same-sequence conflict and stale gaps", async () => {
    for (const scenario of ["conflict", "stale"] as const) {
      const { left, right } = await socketPair();
      right.on("error", () => {});
      const { channel, closed } = channelFor(left, () => PASSIVE_ACK);
      if (scenario === "conflict") {
        right.write(frame(request(1)));
        await new Promise<void>((resolve) => setImmediate(resolve));
        right.write(
          frame(
            request(1, {
              messageId: "producer-revoke-conflict",
              submissionLineageId: "lineage-conflict",
            }),
          ),
        );
      } else {
        right.write(frame(request(2)));
      }
      const event = await firstEvent(closed);
      const cause = event.cause as { code?: string } | null;
      expect(cause?.code).toBe(scenario === "conflict" ? "sequence_conflict" : "sequence_stale");
      await channel.close();
      right.destroy();
    }
  });

  it("closes on a signed ACK with the wrong correlation", async () => {
    const { left, right } = await socketPair();
    const frames = new JsonlFrames(right);
    const { channel, closed } = channelFor(left, () => PASSIVE_ACK);
    const pending = channel.request({
      operation: "stop",
      submissionLineageId: "lineage-correlation",
      authorizationRevision: 1,
    });
    const requestEnvelope = (await frames.next()) as { body: ControlRequestBody };
    const ack: ControlAckBody = {
      keyId: "producer-key",
      kind: "ack",
      direction: "producer_to_controller",
      binding,
      messageId: "producer-ack-1",
      sequence: 1,
      replyToMessageId: "unknown-request-1",
      replyToSequence: requestEnvelope.body.sequence,
      replyToPayloadDigest: requestEnvelope.body.payloadDigest,
      submissionLineageId: requestEnvelope.body.submissionLineageId,
      authorizationRevision: requestEnvelope.body.authorizationRevision,
      phase: "drained",
      facts: PASSIVE_ACK.facts,
    };
    right.write(frame(signControlBody(ack, producerKeys.privateKey)));
    await expect(pending).rejects.toBeInstanceOf(ControlChannelClosedError);
    const event = await firstEvent(closed);
    const cause = event.cause as { code?: string } | null;
    expect(cause?.code).toBe("correlation_mismatch");
    await channel.close();
    right.destroy();
  });

  it("never sends a late ACK after dispose and notifies once", async () => {
    const { left, right } = await socketPair();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handled = 0;
    const { channel, closed } = channelFor(left, async () => {
      handled += 1;
      await gate;
      return PASSIVE_ACK;
    });
    let received = Buffer.alloc(0);
    right.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    right.write(frame(request(1)));
    while (handled === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await channel.dispose();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(received.length).toBe(0);
    const events = await closed;
    expect(events).toHaveLength(1);
    expect(events[0]!.code).toBe("disposed");
  });

  it("settles an active drain wait and closes when the outbound budget overflows", async () => {
    const writes: Buffer[] = [];
    const duplex = new Duplex({
      readableHighWaterMark: 1,
      writableHighWaterMark: 1,
      read() {},
      write(chunk: Buffer, _encoding, _callback) {
        writes.push(chunk);
        return false;
      },
      destroy(error, callback) {
        callback(error);
      },
    });
    const { channel, closed } = channelFor(duplex, () => PASSIVE_ACK, {
      maxFrameBytes: 700,
      maxOutboundBytes: 700,
      maxPendingRequests: 10,
    });
    const requests = [1, 2, 3].map((revision) =>
      channel.request({
        operation: "stop",
        submissionLineageId: `lineage-drain-${revision}`,
        authorizationRevision: revision,
      }),
    );
    const results = await Promise.allSettled(requests);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    await channel.close();
    const event = await firstEvent(closed);
    expect(event.code).toBe("outbound_overflow");
    expect(writes.length).toBeLessThanOrEqual(2);
  });

  it("detaches data handling after close", async () => {
    const duplex = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let handled = 0;
    const { channel } = channelFor(duplex, () => {
      handled += 1;
      return PASSIVE_ACK;
    });
    await channel.close();
    duplex.emit("data", frame(request(1)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handled).toBe(0);
  });
});
