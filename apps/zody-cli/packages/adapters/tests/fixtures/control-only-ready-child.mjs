import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, createWriteStream, readSync } from "node:fs";
import { finished } from "node:stream/promises";

const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";
const BOOTSTRAP_MAX_BYTES = 16 * 1024;
const mode = process.argv[2];

if (!["abnormal-exit", "forged-signature", "wrong-binding", "wrong-challenge"].includes(mode)) {
  process.stderr.write("expected a control-only ready test mode\n");
  process.exit(2);
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

const bootstrap = JSON.parse(await readBootstrap());
const binding = { ...bootstrap.binding };
let challenge = bootstrap.challenge;
let signingKey = createPrivateKey({
  format: "der",
  key: Buffer.from(bootstrap.producerPrivateKeyPkcs8, "base64"),
  type: "pkcs8",
});

if (mode === "forged-signature") {
  signingKey = generateKeyPairSync("ed25519").privateKey;
} else if (mode === "wrong-binding") {
  binding.channelId = `wrong-${binding.channelId}`;
} else if (mode === "wrong-challenge") {
  challenge = `wrong-${challenge}`;
}

const ready = {
  version: 1,
  kind: "ready",
  binding,
  challenge,
  producerPid: process.pid,
  signature: sign(
    null,
    Buffer.from(startupProof(challenge, binding, process.pid)),
    signingKey,
  ).toString("base64"),
};
const readyStream = createWriteStream("", { autoClose: true, fd: 4 });
readyStream.end(`${JSON.stringify(ready)}\n`);
await finished(readyStream);

if (mode === "abnormal-exit") {
  const byte = Buffer.allocUnsafe(1);
  process.exit(readSync(5, byte, 0, 1, null) === 0 ? 24 : 23);
}

// Invalid-ready modes stay alive so the launcher's own failure cleanup, not a
// self-exit race, is what ends the child.
setInterval(() => undefined, 1_000);
