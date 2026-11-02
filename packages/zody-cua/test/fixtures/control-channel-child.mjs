import { createPrivateKey, createPublicKey } from "node:crypto";
import net from "node:net";

import { createControlChannel } from "../../control-channel.js";

function send(message) {
  if (process.connected) {
    process.send(message);
  }
}

let channel = null;
let started = false;

process.on("message", async (message) => {
  if (message?.type !== "start" || started) {
    return;
  }
  started = true;
  const socket = net.connect({ host: "127.0.0.1", port: message.port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const privateKey = createPrivateKey({
    key: Buffer.from(message.producerPrivateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const controllerPublicKey = createPublicKey({
    key: Buffer.from(message.controllerPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  channel = createControlChannel({
    duplex: socket,
    role: "producer",
    binding: message.binding,
    keyId: "producer-key",
    privateKey,
    trustedKeys: { "controller-key": controllerPublicKey },
    requestTimeoutMs: 5_000,
    onRequest: async (request) => {
      if (request.body.payload.operation !== "stop") {
        return {
          phase: "revoked",
          facts: {
            projection: { admissionClosed: true, projectionApplied: true },
            revoked: { authorizationRevoked: true },
            stop: null,
          },
        };
      }
      send({ type: "stop-received" });
      const revoke = await channel.request({
        operation: "revoke_submission",
        submissionLineageId: request.body.submissionLineageId,
        authorizationRevision: request.body.authorizationRevision,
      });
      send({
        type: "revoke-result",
        complete: revoke.evaluation.revoked.complete,
        requestSequence: revoke.sequence,
        ackSequence: revoke.ack.body.sequence,
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
    },
    onClosed: (event) => {
      send({ type: "closed", code: event.code, message: event.message });
    },
  });
  send({ type: "ready", pid: process.pid });
});

process.on("disconnect", () => {
  if (channel !== null) {
    void channel.dispose().finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
