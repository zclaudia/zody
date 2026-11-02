import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createControlChannel } from "../control-channel.js";
import type {
  ControlChannel,
  ControlChannelAckResult,
  ControlChannelClosedEvent,
} from "../control-channel.js";
import type { ControlBinding, ControlRequestBody } from "../control-protocol.js";

const controllerKeys = generateKeyPairSync("ed25519");
const producerKeys = generateKeyPairSync("ed25519");
const fixture = fileURLToPath(new URL("./fixtures/control-channel-child.mjs", import.meta.url));

const binding: ControlBinding = {
  channelId: "channel-child",
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

type ChildMessage = Record<string, unknown> & { type: string };

function messageQueue(child: ChildProcess) {
  const items: ChildMessage[] = [];
  const waiters: Array<{ type: string; resolve: (message: ChildMessage) => void }> = [];
  child.on("message", (message) => {
    if (message === null || typeof message !== "object") {
      return;
    }
    const typed = message as ChildMessage;
    const index = waiters.findIndex((waiter) => waiter.type === typed.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(typed);
    } else {
      items.push(typed);
    }
  });
  return {
    next(type: string): Promise<ChildMessage> {
      const index = items.findIndex((item) => item.type === type);
      if (index >= 0) {
        const [item] = items.splice(index, 1);
        return Promise.resolve(item!);
      }
      return new Promise((resolve) => {
        waiters.push({ type, resolve });
      });
    },
  };
}

async function startChild(): Promise<{
  channel: ControlChannel;
  socket: Socket;
  child: ChildProcess;
  messages: ReturnType<typeof messageQueue>;
  closed: Promise<ControlChannelClosedEvent>;
  incoming: Array<ControlRequestBody>;
}> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  const child = spawn(process.execPath, [fixture], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages = messageQueue(child);
  const connection = once(server, "connection") as Promise<[Socket]>;
  const producerPrivateKey = producerKeys.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const controllerPublicKey = controllerKeys.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  child.send({
    type: "start",
    port: address.port,
    binding,
    producerPrivateKey,
    controllerPublicKey,
  });
  const [socket] = await connection;
  server.close();
  const incoming: ControlRequestBody[] = [];
  let resolveClosed!: (event: ControlChannelClosedEvent) => void;
  const closed = new Promise<ControlChannelClosedEvent>((resolve) => {
    resolveClosed = resolve;
  });
  const channel = createControlChannel({
    duplex: socket,
    role: "controller",
    binding,
    keyId: "controller-key",
    privateKey: controllerKeys.privateKey,
    trustedKeys: { "producer-key": producerKeys.publicKey },
    requestTimeoutMs: 5_000,
    onRequest: (request) => {
      incoming.push(request.body);
      return PASSIVE_ACK;
    },
    onClosed: resolveClosed,
  });
  await messages.next("ready");
  return { channel, socket, child, messages, closed, incoming };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("control channel real child IPC", () => {
  it("runs a bidirectional revoke without deadlock and keeps stop incomplete", async () => {
    const session = await startChild();
    try {
      const stop = await session.channel.request({
        operation: "stop",
        submissionLineageId: "lineage-child-stop",
        authorizationRevision: 7,
      });
      expect(stop.sequence).toBe(1);
      expect(stop.ack.body.sequence).toBe(2);
      expect(stop.evaluation.projection.complete).toBe(true);
      expect(stop.evaluation.revoked.complete).toBe(true);
      expect(stop.evaluation.stop?.nativeFenced).toBe(false);
      expect(stop.evaluation.stop?.complete).toBe(false);
      expect(session.incoming).toHaveLength(1);
      expect(session.incoming[0]!.sequence).toBe(1);
      const revoke = await session.messages.next("revoke-result");
      expect(revoke).toMatchObject({
        complete: true,
        requestSequence: 1,
        ackSequence: 2,
      });
      const socket = session.socket;
      await session.channel.dispose();
      expect(socket.closed).toBe(true);
      const childClosed = await session.messages.next("closed");
      expect(["peer_eof", "transport_closed"]).toContain(childClosed.code);
    } finally {
      await stopChild(session.child);
    }
  });

  it("settles a pending request when the child is killed and notifies once", async () => {
    const session = await startChild();
    const pending = session.channel.request({
      operation: "stop",
      submissionLineageId: "lineage-child-kill",
      authorizationRevision: 9,
    });
    await session.messages.next("stop-received");
    const events: ControlChannelClosedEvent[] = [];
    void session.closed.then((event) => events.push(event));
    const exited = once(session.child, "exit");
    session.child.kill("SIGKILL");
    await expect(pending).rejects.toMatchObject({ code: "channel_closed" });
    await exited;
    const event = await session.closed;
    expect(["peer_eof", "transport_closed", "transport_error"]).toContain(event.code);
    expect(events).toHaveLength(1);
    await session.channel.close();
  });
});
