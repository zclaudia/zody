import { generateKeyPairSync } from "node:crypto";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";

import { createControlChannel } from "../control-channel.js";
import type {
  ControlChannel,
  ControlChannelClosedEvent,
  ControlChannelRequest,
} from "../control-channel.js";
import { createControlRequest } from "../control-protocol.js";
import type {
  ControlAckBody,
  ControlBinding,
  ControlEnvelope,
  ControlRequestBody,
} from "../control-protocol.js";
import { createProducerControlOwner } from "../producer-control.js";

const controllerKeys = generateKeyPairSync("ed25519");
const producerKeys = generateKeyPairSync("ed25519");
const attackerKeys = generateKeyPairSync("ed25519");

const binding: ControlBinding = {
  channelId: "channel-producer-control",
  controllerIncarnation: "controller-incarnation",
  producerIncarnation: "producer-incarnation",
  appIncarnation: "app-incarnation",
};

class PairedDuplex extends Duplex {
  peer: PairedDuplex | null = null;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.peer?.push(chunk);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.peer?.push(null);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.peer !== null && !this.peer.destroyed) {
      this.peer.push(null);
    }
    callback(error);
  }
}

function socketPair(): { left: Duplex; right: Duplex } {
  const left = new PairedDuplex();
  const right = new PairedDuplex();
  left.peer = right;
  right.peer = left;
  return { left, right };
}

function frame(envelope: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
}

function producerChannel(
  duplex: Duplex,
  owner: ReturnType<typeof createProducerControlOwner>,
  closed?: (event: ControlChannelClosedEvent) => void,
): ControlChannel {
  return createControlChannel({
    duplex,
    role: "producer",
    binding,
    keyId: "producer-key",
    privateKey: producerKeys.privateKey,
    trustedKeys: { "controller-key": controllerKeys.publicKey },
    requestTimeoutMs: 5_000,
    onRequest: (request) => owner.onRequest(request),
    onClosed: (event) => {
      owner.close();
      closed?.(event);
    },
  });
}

function controllerChannel(duplex: Duplex): ControlChannel {
  return createControlChannel({
    duplex,
    role: "controller",
    binding,
    keyId: "controller-key",
    privateKey: controllerKeys.privateKey,
    trustedKeys: { "producer-key": producerKeys.publicKey },
    requestTimeoutMs: 5_000,
    onRequest: () => ({
      phase: "revoked",
      facts: {
        projection: { admissionClosed: true, projectionApplied: true },
        revoked: { authorizationRevoked: true },
        stop: null,
      },
    }),
  });
}

function directRequest(
  submissionLineageId: string,
  authorizationRevision: number,
  operation: "revoke_submission" | "stop",
): ControlChannelRequest {
  const body: ControlRequestBody = {
    keyId: "controller-key",
    kind: "request",
    direction: "controller_to_producer",
    binding,
    messageId: `direct-${submissionLineageId}-${authorizationRevision}`,
    sequence: 1,
    submissionLineageId,
    authorizationRevision,
    payload: { operation },
    payloadDigest: "0".repeat(64),
  };
  return {
    body,
    keyId: "controller-key",
    digest: "0".repeat(64),
    signal: new AbortController().signal,
  };
}

class JsonlFrames {
  private buffer = Buffer.alloc(0);
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const index = this.buffer.indexOf(0x0a);
        if (index < 0) {
          return;
        }
        const text = this.buffer.subarray(0, index).toString("utf8");
        this.buffer = this.buffer.subarray(index + 1);
        const parsed: unknown = JSON.parse(text);
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(parsed);
        } else {
          this.frames.push(parsed);
        }
      }
    });
  }

  next(): Promise<unknown> {
    const value = this.frames.shift();
    if (value !== undefined) {
      return Promise.resolve(value);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

describe("producer control owner diagnostics", () => {
  it("reports no executable admission and keeps candidate non-grant", () => {
    const owner = createProducerControlOwner({ maxLineages: 3 });
    const diagnostics = owner.diagnostics();

    expect(diagnostics).toMatchObject({
      closed: false,
      admissionClosed: false,
      executableAdmission: false,
      nativeHelper: "unavailable",
      nativeFence: "unknown",
      candidateIsGrant: false,
      maxLineages: 3,
      lineageCount: 0,
    });
    expect(diagnostics.lineages).toEqual([]);
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.lineages)).toBe(true);
  });
});

describe("producer control owner over the authenticated endpoint", () => {
  it("deduplicates an identical signed request before invoking the owner handler", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    let handlerCalls = 0;
    const producer = createControlChannel({
      duplex: right,
      role: "producer",
      binding,
      keyId: "producer-key",
      privateKey: producerKeys.privateKey,
      trustedKeys: { "controller-key": controllerKeys.publicKey },
      requestTimeoutMs: 5_000,
      onRequest: (request) => {
        handlerCalls += 1;
        return owner.onRequest(request);
      },
      onClosed: () => owner.close(),
    });
    const frames = new JsonlFrames(left);
    const envelope = createControlRequest(
      {
        keyId: "controller-key",
        direction: "controller_to_producer",
        binding,
        messageId: "duplicate-request",
        sequence: 1,
        submissionLineageId: "lineage-duplicate",
        authorizationRevision: 1,
        operation: "revoke_submission",
      },
      controllerKeys.privateKey,
    );
    try {
      const bytes = frame(envelope);
      left.write(Buffer.concat([bytes, bytes]));
      const first = (await frames.next()) as ControlEnvelope<ControlAckBody>;
      const second = (await frames.next()) as ControlEnvelope<ControlAckBody>;

      expect(handlerCalls).toBe(1);
      expect(first.body.facts.revoked.authorizationRevoked).toBe(true);
      expect(second.signature).toBe(first.signature);
      expect(second.body.sequence).toBe(first.body.sequence);
      expect(owner.diagnostics()).toMatchObject({ lineageCount: 1, revokedLineageCount: 1 });
    } finally {
      await producer.close();
      left.destroy();
    }
  });

  it("rejects a forged signature without invoking the owner handler", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    let resolveClosed!: (event: ControlChannelClosedEvent) => void;
    const closed = new Promise<ControlChannelClosedEvent>((resolve) => {
      resolveClosed = resolve;
    });
    const producer = producerChannel(right, owner, (event) => {
      resolveClosed(event);
    });
    const forged = createControlRequest(
      {
        keyId: "attacker-key",
        direction: "controller_to_producer",
        binding,
        messageId: "forged-request",
        sequence: 1,
        submissionLineageId: "lineage-forged",
        authorizationRevision: 1,
        operation: "revoke_submission",
      },
      attackerKeys.privateKey,
    );
    try {
      left.write(frame(forged));
      const event = await closed;
      expect(event.code).toBe("protocol_error");
      expect(owner.diagnostics()).toMatchObject({ closed: true, lineageCount: 0 });
    } finally {
      await producer.close();
      left.destroy();
    }
  });

  it("applies revocation once, rejects stale revisions, and never restores a lineage", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    const producer = producerChannel(right, owner);
    const controller = controllerChannel(left);
    try {
      const first = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-revoke",
        authorizationRevision: 5,
      });
      expect(first.ack.body.phase).toBe("revoked");
      expect(first.evaluation.projection.complete).toBe(true);
      expect(first.evaluation.revoked.complete).toBe(true);
      expect(first.evaluation.stop).toBeNull();

      const stale = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-revoke",
        authorizationRevision: 4,
      });
      expect(stale.ack.body.phase).toBe("rejected");
      expect(stale.evaluation.revoked.authorizationRevoked).toBe(false);
      expect(stale.evaluation.revoked.complete).toBe(false);

      const duplicate = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-revoke",
        authorizationRevision: 5,
      });
      expect(duplicate.ack.body.phase).toBe("revoked");
      expect(duplicate.evaluation.revoked.complete).toBe(true);

      const higher = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-revoke",
        authorizationRevision: 7,
      });
      expect(higher.ack.body.phase).toBe("revoked");

      const diagnostics = owner.diagnostics();
      expect(diagnostics.lineageCount).toBe(1);
      expect(diagnostics.lineages[0]).toMatchObject({
        submissionLineageId: "lineage-revoke",
        authorizationRevision: 7,
        observedRevision: 7,
        authorizationRevoked: true,
        admissionClosed: true,
        nativeFence: "unknown",
      });
    } finally {
      await controller.dispose();
      await producer.close();
      left.destroy();
      right.destroy();
    }
  });

  it("bounds lineage tombstones and rejects new lineages without evicting existing ones", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner({ maxLineages: 2 });
    const producer = producerChannel(right, owner);
    const controller = controllerChannel(left);
    try {
      for (const lineage of ["lineage-a", "lineage-b"]) {
        const result = await controller.request({
          operation: "revoke_submission",
          submissionLineageId: lineage,
          authorizationRevision: 1,
        });
        expect(result.ack.body.phase).toBe("revoked");
      }

      const overflow = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-c",
        authorizationRevision: 1,
      });
      expect(overflow.ack.body.phase).toBe("rejected");
      expect(overflow.evaluation.revoked.complete).toBe(false);
      expect(overflow.evaluation.projection.complete).toBe(false);
      expect(overflow.ack.body.facts.projection).toEqual({
        admissionClosed: true,
        projectionApplied: false,
      });

      const overflowStop = await controller.request({
        operation: "stop",
        submissionLineageId: "lineage-c",
        authorizationRevision: 1,
      });
      expect(overflowStop.ack.body.phase).toBe("rejected");
      expect(overflowStop.evaluation.stop?.complete).toBe(false);

      const existing = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-a",
        authorizationRevision: 2,
      });
      expect(existing.ack.body.phase).toBe("revoked");

      const diagnostics = owner.diagnostics();
      expect(diagnostics.lineageCount).toBe(2);
      expect(diagnostics.admissionClosed).toBe(true);
      expect(diagnostics.lineages.every((lineage) => lineage.admissionClosed)).toBe(true);
      expect(diagnostics.lineages.map((lineage) => lineage.submissionLineageId)).toEqual([
        "lineage-a",
        "lineage-b",
      ]);
      expect(diagnostics.lineages[0]?.authorizationRevision).toBe(2);
    } finally {
      await controller.dispose();
      await producer.close();
      left.destroy();
      right.destroy();
    }
  });

  it("keeps stop pending with unknown native facts and no revocation guess", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    const producer = producerChannel(right, owner);
    const controller = controllerChannel(left);
    try {
      const stop = await controller.request({
        operation: "stop",
        submissionLineageId: "lineage-stop",
        authorizationRevision: 1,
      });
      expect(stop.ack.body.phase).toBe("stop_pending");
      expect(stop.evaluation.projection.complete).toBe(true);
      expect(stop.evaluation.revoked.authorizationRevoked).toBe(false);
      expect(stop.evaluation.revoked.complete).toBe(false);
      expect(stop.evaluation.stop).toMatchObject({
        nativeFenced: false,
        pending: true,
        ownedInputsReleased: false,
        leaseReleased: false,
        complete: false,
      });
      expect(stop.evaluation.stop?.reasons).toEqual(
        expect.arrayContaining([
          "phase_not_final",
          "authorization_not_revoked",
          "native_not_fenced",
          "pending",
          "owned_inputs_not_released",
          "lease_not_released",
        ]),
      );

      const revoke = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-stop",
        authorizationRevision: 1,
      });
      expect(revoke.ack.body.phase).toBe("revoked");
      expect(owner.diagnostics().lineages[0]).toMatchObject({
        authorizationRevoked: true,
        stopPending: true,
      });

      const stoppedAtRevokedRevision = await controller.request({
        operation: "stop",
        submissionLineageId: "lineage-stop",
        authorizationRevision: 1,
      });
      expect(stoppedAtRevokedRevision.ack.body.phase).toBe("stop_pending");
      expect(stoppedAtRevokedRevision.ack.body.phase).not.toBe("fenced");
      expect(stoppedAtRevokedRevision.ack.body.phase).not.toBe("drained");
      expect(stoppedAtRevokedRevision.evaluation.revoked.complete).toBe(true);
      expect(stoppedAtRevokedRevision.evaluation.stop).toMatchObject({
        nativeFenced: false,
        pending: true,
        ownedInputsReleased: false,
        leaseReleased: false,
        complete: false,
      });
    } finally {
      await controller.dispose();
      await producer.close();
      left.destroy();
      right.destroy();
    }
  });

  it("does not claim revocation evidence from a newer stop and rejects an intermediate revision", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    const producer = producerChannel(right, owner);
    const controller = controllerChannel(left);
    try {
      const revoke = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-observed",
        authorizationRevision: 2,
      });
      expect(revoke.evaluation.revoked.complete).toBe(true);

      const stop = await controller.request({
        operation: "stop",
        submissionLineageId: "lineage-observed",
        authorizationRevision: 5,
      });
      expect(stop.ack.body.phase).toBe("stop_pending");
      expect(stop.evaluation.revoked.authorizationRevoked).toBe(false);
      expect(stop.evaluation.revoked.complete).toBe(false);
      expect(stop.evaluation.stop?.complete).toBe(false);
      expect(owner.diagnostics().lineages[0]).toMatchObject({
        authorizationRevision: 2,
        observedRevision: 5,
        authorizationRevoked: true,
        stopPending: true,
      });

      const intermediate = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-observed",
        authorizationRevision: 4,
      });
      expect(intermediate.ack.body.phase).toBe("rejected");
      expect(intermediate.evaluation.revoked.authorizationRevoked).toBe(false);
      expect(intermediate.evaluation.revoked.complete).toBe(false);
      expect(owner.diagnostics().lineages[0]).toMatchObject({
        authorizationRevision: 2,
        observedRevision: 5,
        authorizationRevoked: true,
      });

      const currentRevoke = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-observed",
        authorizationRevision: 5,
      });
      expect(currentRevoke.ack.body.phase).toBe("revoked");
      expect(currentRevoke.evaluation.revoked.complete).toBe(true);
      expect(owner.diagnostics().lineages[0]).toMatchObject({
        authorizationRevision: 5,
        observedRevision: 5,
        authorizationRevoked: true,
      });
    } finally {
      await controller.dispose();
      await producer.close();
      left.destroy();
      right.destroy();
    }
  });

  it("latches every admission closed when the endpoint reports disconnect", async () => {
    const { left, right } = await socketPair();
    const owner = createProducerControlOwner();
    let resolveClosed!: (event: ControlChannelClosedEvent) => void;
    const closed = new Promise<ControlChannelClosedEvent>((resolve) => {
      resolveClosed = resolve;
    });
    const producer = producerChannel(right, owner, (event) => resolveClosed(event));
    const controller = controllerChannel(left);
    try {
      const revoke = await controller.request({
        operation: "revoke_submission",
        submissionLineageId: "lineage-close",
        authorizationRevision: 1,
      });
      expect(revoke.evaluation.revoked.complete).toBe(true);
      expect(owner.closed).toBe(false);

      await controller.dispose();
      await closed;
      expect(owner.closed).toBe(true);
      const diagnostics = owner.diagnostics();
      expect(diagnostics.admissionClosed).toBe(true);
      expect(diagnostics.lineages[0]?.admissionClosed).toBe(true);

      const afterClose = owner.onRequest(directRequest("lineage-after-close", 1, "stop"));
      expect(afterClose.phase).toBe("rejected");
      expect(afterClose.facts.projection).toEqual({
        admissionClosed: true,
        projectionApplied: false,
      });
      expect(afterClose.facts.revoked.authorizationRevoked).toBe(false);
      expect(afterClose.facts.stop).toEqual({
        nativeFenced: false,
        pending: true,
        ownedInputsReleased: false,
        leaseReleased: false,
      });
      expect(owner.diagnostics().lineageCount).toBe(1);
      owner.close();
      owner.dispose();
      expect(owner.diagnostics().lineageCount).toBe(1);
    } finally {
      await producer.close();
      left.destroy();
      right.destroy();
    }
  });
});
