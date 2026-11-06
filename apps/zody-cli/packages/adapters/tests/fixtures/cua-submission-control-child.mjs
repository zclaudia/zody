import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { appendFileSync, createReadStream, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { createControlChannel } from "@zody/zody-cua/control-channel";

const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";
const BOOTSTRAP_MAX_BYTES = 16 * 1024;
const UNKNOWN_STOP = Object.freeze({
  nativeFenced: false,
  pending: true,
  ownedInputsReleased: false,
  leaseReleased: false,
});
const MODES = new Set([
  "normal",
  "ready-exit",
  "ready-eof",
  "ready-protocol-error",
  "reverse-on-ready",
  "reverse-arbitrary",
  "reverse-duplicate",
  "fenced-ack",
  "close-on-request",
  "eof-after-ready",
]);

const mode = process.argv[2];
const logPath = process.argv[3];
const lineageArg = process.argv[4] ?? "fixture-lineage";
const revisionArg = Number(process.argv[5] ?? "1");

if (!MODES.has(mode) || logPath === undefined) {
  process.stderr.write("expected a cua submission control test mode and log path\n");
  process.exit(2);
}

function log(event) {
  appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

if (mode === "eof-after-ready") {
  process.on("SIGTERM", () => {
    log({ event: "child-sigterm" });
    process.exit(0);
  });
  process.on("exit", () => log({ event: "child-exit" }));
}

async function readBootstrap() {
  const chunks = [];
  let bytes = 0;
  for await (const raw of createReadStream("", { autoClose: true, fd: 3 })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > BOOTSTRAP_MAX_BYTES) throw new Error("bootstrap is too large");
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8");
    }
    chunks.push(chunk);
  }
  throw new Error("bootstrap ended before a complete line");
}

function startupProof(challenge, binding, producerPid) {
  return [
    STARTUP_PROOF_DOMAIN,
    challenge,
    binding.channelId,
    binding.controllerIncarnation,
    binding.producerIncarnation,
    binding.appIncarnation,
    String(producerPid),
  ].join("\n");
}

async function writeReady(bootstrap) {
  const ready = {
    version: 1,
    kind: "ready",
    binding: bootstrap.binding,
    challenge: bootstrap.challenge,
    producerPid: process.pid,
    signature: sign(
      null,
      Buffer.from(startupProof(bootstrap.challenge, bootstrap.binding, process.pid)),
      createPrivateKey({
        format: "der",
        key: Buffer.from(bootstrap.producerPrivateKeyPkcs8, "base64"),
        type: "pkcs8",
      }),
    ).toString("base64"),
  };
  const readyStream = createWriteStream("", { autoClose: true, fd: 4 });
  readyStream.end(`${JSON.stringify(ready)}\n`);
  await finished(readyStream);
}

function stopFacts() {
  return mode === "fenced-ack"
    ? { ...UNKNOWN_STOP, nativeFenced: true, leaseReleased: true, pending: false }
    : UNKNOWN_STOP;
}

function ackFor(body) {
  if (mode === "fenced-ack") {
    return {
      phase: "fenced",
      facts: {
        projection: { admissionClosed: true, projectionApplied: true },
        revoked: { authorizationRevoked: true },
        stop: body.payload.operation === "stop" ? stopFacts() : null,
      },
    };
  }
  const stop = body.payload.operation === "stop";
  return {
    phase: stop ? "stop_pending" : "revoked",
    facts: {
      projection: { admissionClosed: true, projectionApplied: true },
      revoked: { authorizationRevoked: true },
      stop: stop ? stopFacts() : null,
    },
  };
}

const bootstrap = JSON.parse(await readBootstrap());
if (mode === "ready-exit") {
  await writeReady(bootstrap);
  log({ event: "ready-exit" });
  process.exit(21);
}
if (mode === "ready-eof" || mode === "ready-protocol-error") {
  await writeReady(bootstrap);
  const control = createWriteStream("", { autoClose: true, fd: 6 });
  control.end(mode === "ready-protocol-error" ? "not-a-control-frame\n" : undefined);
  await finished(control);
  log({ event: mode });
  setInterval(() => undefined, 1_000);
} else {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const channel = createControlChannel({
    binding: bootstrap.binding,
    duplex: (await import("node:stream")).Duplex.from({
      readable: createReadStream("", { autoClose: true, fd: 5 }),
      writable: createWriteStream("", { autoClose: true, fd: 6 }),
    }),
    keyId: "producer",
    onClosed: (event) => {
      log({ code: event.code, event: "control-closed" });
      resolveClosed(event);
    },
    onRequest: (request) => {
      log({
        authorizationRevision: request.body.authorizationRevision,
        event: "request",
        operation: request.body.payload.operation,
        submissionLineageId: request.body.submissionLineageId,
      });
      if (mode === "close-on-request") throw new Error("simulated loss during ACK");
      return ackFor(request.body);
    },
    privateKey: createPrivateKey({
      format: "der",
      key: Buffer.from(bootstrap.producerPrivateKeyPkcs8, "base64"),
      type: "pkcs8",
    }),
    role: "producer",
    trustedKeys: {
      controller: createPublicKey({
        format: "der",
        key: Buffer.from(bootstrap.controllerPublicKeySpki, "base64"),
        type: "spki",
      }),
    },
  });

  await writeReady(bootstrap);
  log({ event: "ready", producerIncarnation: bootstrap.binding.producerIncarnation });

  if (mode === "eof-after-ready") {
    setTimeout(() => void channel.dispose(), 150);
  }

  if (mode === "reverse-on-ready" || mode === "reverse-arbitrary") {
    setTimeout(() => {
      const lineage = mode === "reverse-arbitrary" ? `${lineageArg}-other` : lineageArg;
      const revision = mode === "reverse-arbitrary" ? revisionArg + 1 : revisionArg;
      channel
        .request({
          authorizationRevision: revision,
          operation: "revoke_submission",
          submissionLineageId: lineage,
        })
        .then((result) => {
          log({ event: "reverse-ack", phase: result.ack.body.phase });
        })
        .catch((error) => {
          log({
            event: "reverse-error",
            message: error instanceof Error ? error.message : "failed",
          });
        });
    }, 150);
  }
  if (mode === "reverse-duplicate") {
    setTimeout(() => {
      const reverse = () =>
        channel
          .request({
            authorizationRevision: revisionArg,
            operation: "revoke_submission",
            submissionLineageId: lineageArg,
          })
          .then((result) => log({ event: "reverse-ack", phase: result.ack.body.phase }))
          .catch((error) =>
            log({
              event: "reverse-error",
              message: error instanceof Error ? error.message : "failed",
            }),
          );
      void Promise.all([reverse(), reverse()]);
    }, 150);
  }

  await closed;
  if (mode === "eof-after-ready") {
    setInterval(() => undefined, 1_000);
  } else {
    await channel.dispose().catch(() => undefined);
  }
}
