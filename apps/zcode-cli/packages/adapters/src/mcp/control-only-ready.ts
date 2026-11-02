import { generateKeyPairSync, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import type { Readable } from "node:stream";
import type { ControlBinding } from "@zcode/zcode-cua/control-protocol";
import { ControlOnlyLauncherError } from "./control-only-contract.js";

const PRODUCER_KEY_ID = "producer";
const CONTROLLER_KEY_ID = "controller";
const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";
const CONTROL_ONLY_BOOTSTRAP_MAX_BYTES = 16 * 1024;
const CONTROL_ONLY_READY_MAX_BYTES = 8 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_SIGNATURE_BASE64_BYTES = 1024;

export interface ControlOnlyMaterial {
  readonly binding: ControlBinding;
  readonly bootstrapLine: string;
  readonly challenge: string;
  readonly controllerPrivateKey: KeyObject;
  readonly producerPublicKey: KeyObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidReady(message: string, options?: { cause?: unknown }): never {
  throw new ControlOnlyLauncherError("startup_invalid", message, options);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalidReady("control startup ready is invalid");
  }
}

function readReadyString(value: unknown, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    invalidReady("control startup ready is invalid");
  }
  return value;
}

function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxBytes ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    invalidReady("control startup ready is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    invalidReady("control startup ready is invalid");
  }
  return decoded;
}

export function startupProof(
  challenge: string,
  binding: ControlBinding,
  producerPid: number,
): string {
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

export function createControlOnlyMaterial(appIncarnation: string): ControlOnlyMaterial {
  const binding: ControlBinding = Object.freeze({
    appIncarnation,
    channelId: randomUUID(),
    controllerIncarnation: randomUUID(),
    producerIncarnation: randomUUID(),
  });
  const challenge = randomBytes(32).toString("base64url");
  const controllerKeys = generateKeyPairSync("ed25519");
  const producerKeys = generateKeyPairSync("ed25519");
  const producerPrivateDer = producerKeys.privateKey.export({ format: "der", type: "pkcs8" });
  const bootstrapLine = `${JSON.stringify({
    version: 1,
    kind: "zody.cua.control.bootstrap",
    binding,
    challenge,
    producerKeyId: PRODUCER_KEY_ID,
    producerPrivateKeyPkcs8: producerPrivateDer.toString("base64"),
    controllerKeyId: CONTROLLER_KEY_ID,
    controllerPublicKeySpki: controllerKeys.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  })}\n`;
  producerPrivateDer.fill(0);
  if (Buffer.byteLength(bootstrapLine, "utf8") > CONTROL_ONLY_BOOTSTRAP_MAX_BYTES) {
    throw new ControlOnlyLauncherError("invalid_options", "control bootstrap is too large");
  }
  return Object.freeze({
    binding,
    bootstrapLine,
    challenge,
    controllerPrivateKey: controllerKeys.privateKey,
    producerPublicKey: producerKeys.publicKey,
  });
}

export async function readReadyLine(stream: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new ControlOnlyLauncherError("startup_invalid", "control startup ready is too large");
      }
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ControlOnlyLauncherError) throw error;
    throw new ControlOnlyLauncherError("startup_eof", "control startup ready read failed", {
      cause: error,
    });
  }
  throw new ControlOnlyLauncherError("startup_eof", "control startup ended before ready");
}

export function verifyReady(
  raw: string,
  expected: { challenge: string; binding: ControlBinding; producerPid: number },
  producerPublicKey: KeyObject,
): void {
  if (Buffer.byteLength(raw, "utf8") > CONTROL_ONLY_READY_MAX_BYTES || raw.length === 0) {
    invalidReady("control startup ready is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    invalidReady("control startup ready is invalid", { cause: error });
  }
  if (!isRecord(value)) invalidReady("control startup ready is invalid");
  assertExactKeys(value, ["version", "kind", "binding", "challenge", "producerPid", "signature"]);
  if (value.version !== 1 || value.kind !== "ready" || !isRecord(value.binding)) {
    invalidReady("control startup ready is invalid");
  }
  assertExactKeys(value.binding, [
    "channelId",
    "controllerIncarnation",
    "producerIncarnation",
    "appIncarnation",
  ]);
  const binding: ControlBinding = {
    channelId: readReadyString(value.binding.channelId, MAX_IDENTIFIER_BYTES),
    controllerIncarnation: readReadyString(
      value.binding.controllerIncarnation,
      MAX_IDENTIFIER_BYTES,
    ),
    producerIncarnation: readReadyString(value.binding.producerIncarnation, MAX_IDENTIFIER_BYTES),
    appIncarnation: readReadyString(value.binding.appIncarnation, MAX_IDENTIFIER_BYTES),
  };
  if (
    binding.channelId !== expected.binding.channelId ||
    binding.controllerIncarnation !== expected.binding.controllerIncarnation ||
    binding.producerIncarnation !== expected.binding.producerIncarnation ||
    binding.appIncarnation !== expected.binding.appIncarnation
  ) {
    throw new ControlOnlyLauncherError("startup_invalid", "control startup binding changed");
  }
  const challenge = readReadyString(value.challenge, MAX_IDENTIFIER_BYTES);
  if (challenge !== expected.challenge) {
    throw new ControlOnlyLauncherError("startup_invalid", "control startup challenge changed");
  }
  if (
    typeof value.producerPid !== "number" ||
    !Number.isSafeInteger(value.producerPid) ||
    value.producerPid <= 0 ||
    value.producerPid !== expected.producerPid
  ) {
    throw new ControlOnlyLauncherError("startup_invalid", "control startup producer pid changed");
  }
  const signature = decodeBase64(value.signature, MAX_SIGNATURE_BASE64_BYTES);
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(startupProof(challenge, binding, value.producerPid)),
      producerPublicKey,
      signature,
    );
  } finally {
    signature.fill(0);
  }
  if (!valid) {
    throw new ControlOnlyLauncherError("startup_invalid", "control startup signature is invalid");
  }
}
