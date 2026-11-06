import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createControlChannel } from "@zody/zody-cua/control-channel";
import { CuaSubmissionAuthority } from "../src/runtime/cua/cua-submission-authority.js";

const UNKNOWN_NATIVE = {
  nativeFenced: false,
  pending: true,
  ownedInputsReleased: false,
  leaseReleased: false,
};

async function connectedSockets() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const incoming = once(server, "connection");
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  const connected = once(client, "connect");
  const [peer] = (await incoming) as [Socket];
  await connected;
  return {
    client,
    peer,
    close: async () => {
      client.destroy();
      peer.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("runtime authority and authenticated control channel", () => {
  it("locks runtime revocation through a nested reverse request without claiming native stop", async () => {
    const authority = new CuaSubmissionAuthority({
      appIncarnation: "app-instance",
      hostInstanceId: "host-instance",
      runtimeInstanceId: "runtime-instance",
      sessionId: "session",
      workspaceKey: "workspace",
    });
    const admission = authority.admitLive({
      origin: "desktop",
      inputKind: "new-submission",
      sourceCommandId: "command",
      queueItemId: "queue-item",
    });
    if (!admission.accepted) throw new Error("Expected candidate");
    expect(
      authority.bindTurn({
        ref: admission.ref,
        producerIncarnation: "producer-instance",
        runId: "run",
        turnId: "turn",
      }).ok,
    ).toBe(true);
    const port = authority.createProducerPort();
    const sockets = await connectedSockets();
    const controllerKey = generateKeyPairSync("ed25519");
    const producerKey = generateKeyPairSync("ed25519");
    const binding = {
      channelId: "test-channel",
      controllerIncarnation: "controller-instance",
      producerIncarnation: "producer-instance",
      appIncarnation: "app-instance",
    };
    let authoritativeRevocations = 0;
    const controller = createControlChannel({
      duplex: sockets.client,
      role: "controller",
      binding,
      keyId: "controller",
      privateKey: controllerKey.privateKey,
      trustedKeys: { producer: producerKey.publicKey },
      onRequest: async ({ body }) => {
        expect(body.submissionLineageId).toBe(admission.ref.submissionLineageId);
        const result = await port.revoke({ ref: admission.ref, reason: "user-stop" });
        expect(result.status).toBe("revoked");
        authoritativeRevocations += 1;
        return {
          phase: "revoked",
          facts: {
            projection: { admissionClosed: false, projectionApplied: false },
            revoked: { authorizationRevoked: result.status === "revoked" },
            stop: null,
          },
        };
      },
      onClosed: () => {
        authority.producerLost({
          producerIncarnation: "producer-instance",
          reason: "control-lost",
        });
      },
    });
    const producer = createControlChannel({
      duplex: sockets.peer,
      role: "producer",
      binding,
      keyId: "producer",
      privateKey: producerKey.privateKey,
      trustedKeys: { controller: controllerKey.publicKey },
      onRequest: async ({ body }) => {
        const reverse = await producer.request({
          operation: "revoke_submission",
          submissionLineageId: body.submissionLineageId,
          authorizationRevision: body.authorizationRevision,
        });
        expect(reverse.evaluation.revoked.complete).toBe(true);
        return {
          phase: "stop_pending",
          facts: {
            projection: { admissionClosed: true, projectionApplied: true },
            revoked: { authorizationRevoked: true },
            stop: UNKNOWN_NATIVE,
          },
        };
      },
    });
    try {
      const stopped = await controller.request({
        operation: "stop",
        submissionLineageId: admission.ref.submissionLineageId,
        authorizationRevision: admission.ref.authorizationRevision,
      });
      expect(authoritativeRevocations).toBe(1);
      expect(stopped.evaluation.stop?.complete).toBe(false);
      expect(stopped.ack.body.facts.stop?.nativeFenced).toBe(false);
      const duplicate = authority.admitLive({
        origin: "desktop",
        inputKind: "new-submission",
        sourceCommandId: "command",
        queueItemId: "queue-item",
      });
      expect(duplicate.accepted).toBe(false);
      if (duplicate.accepted || !duplicate.existingRef) throw new Error("Missing prior lineage");
      const projection = await port.resolve({ ref: duplicate.existingRef });
      expect(projection.status).toBe("revoked");
      expect(projection.nativeFence).toBe("unknown");
      expect(projection.mobileDelivery).toBe("unknown");
      expect(
        authority.bindTurn({
          ref: duplicate.existingRef,
          producerIncarnation: "new-producer-instance",
          runId: "continuation-run",
          turnId: "continuation-turn",
        }).ok,
      ).toBe(false);
    } finally {
      await Promise.all([controller.close(), producer.close()]);
      await sockets.close();
      authority.dispose();
    }
  });
});
