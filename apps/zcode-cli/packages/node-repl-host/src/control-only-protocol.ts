import { close, createReadStream, createWriteStream, fstat, read } from "node:fs";
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import type {
  ControlChannelAckResult,
  ControlChannelRequest,
} from "@zcode/zcode-cua/control-channel";
import type { ControlBinding } from "@zcode/zcode-cua/control-protocol";
import type { ProducerControlOwner } from "@zcode/zcode-cua/producer-control";

export const ZCODE_NODE_REPL_CONTROL_FLAG = "--zcode-node-repl-control";
export const CONTROL_ONLY_BOOTSTRAP_MAX_BYTES = 16 * 1024;
const CONTROL_ONLY_READY_MAX_BYTES = 8 * 1024;
const PRODUCER_KEY_ID = "producer";
const CONTROLLER_KEY_ID = "controller";
const STARTUP_PROOF_DOMAIN = "zody.cua.control.startup.v1";
const MAX_IDENTIFIER_BYTES = 256;
const MAX_KEY_BASE64_BYTES = 4096;
const readFd = promisify(read);
const closeFd = promisify(close);
const fstatFd = promisify(fstat);

export type ControlOnlyErrorCode =
  | "invalid_arguments"
  | "bootstrap_fd_unavailable"
  | "bootstrap_invalid"
  | "control_fd_unavailable"
  | "ready_write_failed"
  | "channel_failed";

export class ControlOnlyEntryError extends Error {
  readonly code: ControlOnlyErrorCode;

  constructor(code: ControlOnlyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ControlOnlyEntryError";
    this.code = code;
  }
}

export interface ControlOnlyChildOptions {
  readonly argv?: readonly string[];
  readonly bootstrapFd?: number;
  readonly readyFd?: number;
  readonly controlReadFd?: number;
  readonly controlWriteFd?: number;
  readonly createOwner?: () => ProducerControlOwner;
  readonly onRequest?: (
    request: ControlChannelRequest,
  ) => ControlChannelAckResult | Promise<ControlChannelAckResult>;
  readonly onClosed?: (
    event: import("@zcode/zcode-cua/control-channel").ControlChannelClosedEvent,
  ) => void | Promise<void>;
  readonly writeStderr?: (text: string) => void;
}

export interface ValidatedBootstrap {
  readonly binding: ControlBinding;
  readonly challenge: string;
  readonly controllerKeyId: string;
  readonly controllerPublicKey: KeyObject;
  readonly producerKeyId: string;
  readonly producerPrivateKey: KeyObject;
}

export function isControlOnlyInvocation(argv: readonly string[]): boolean {
  return argv.includes(ZCODE_NODE_REPL_CONTROL_FLAG);
}

export function hasExactControlArguments(argv: readonly string[]): boolean {
  return (
    argv.length === 3 &&
    argv[2] === ZCODE_NODE_REPL_CONTROL_FLAG &&
    argv.filter((value) => value === ZCODE_NODE_REPL_CONTROL_FLAG).length === 1
  );
}

function invalid(message: string, options?: { cause?: unknown }): never {
  throw new ControlOnlyEntryError("bootstrap_invalid", message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid("bootstrap schema is not exact");
  }
}

function readIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
  ) {
    invalid(`bootstrap ${name} is invalid`);
  }
  return value;
}

function readChallenge(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 128) {
    invalid("bootstrap challenge is invalid");
  }
  return value;
}

function readBinding(value: unknown): ControlBinding {
  if (!isRecord(value)) invalid("bootstrap binding is invalid");
  assertExactKeys(value, [
    "channelId",
    "controllerIncarnation",
    "producerIncarnation",
    "appIncarnation",
  ]);
  return Object.freeze({
    channelId: readIdentifier(value.channelId, "channelId"),
    controllerIncarnation: readIdentifier(value.controllerIncarnation, "controllerIncarnation"),
    producerIncarnation: readIdentifier(value.producerIncarnation, "producerIncarnation"),
    appIncarnation: readIdentifier(value.appIncarnation, "appIncarnation"),
  });
}

function decodeBase64(value: unknown, name: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_KEY_BASE64_BYTES) {
    invalid(`bootstrap ${name} is invalid`);
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    invalid(`bootstrap ${name} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    invalid(`bootstrap ${name} is invalid`);
  }
  return decoded;
}

export function parseBootstrap(raw: string): ValidatedBootstrap {
  if (Buffer.byteLength(raw, "utf8") > CONTROL_ONLY_BOOTSTRAP_MAX_BYTES || raw.length === 0) {
    invalid("bootstrap size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    invalid("bootstrap is not JSON", { cause: error });
  }
  if (!isRecord(value)) invalid("bootstrap is not an object");
  assertExactKeys(value, [
    "version",
    "kind",
    "binding",
    "challenge",
    "producerKeyId",
    "producerPrivateKeyPkcs8",
    "controllerKeyId",
    "controllerPublicKeySpki",
  ]);
  if (value.version !== 1 || value.kind !== "zody.cua.control.bootstrap") {
    invalid("bootstrap version is invalid");
  }
  if (value.producerKeyId !== PRODUCER_KEY_ID || value.controllerKeyId !== CONTROLLER_KEY_ID) {
    invalid("bootstrap key ids are invalid");
  }
  const binding = readBinding(value.binding);
  const challenge = readChallenge(value.challenge);

  const privateDer = decodeBase64(value.producerPrivateKeyPkcs8, "producer private key");
  const publicDer = decodeBase64(value.controllerPublicKeySpki, "controller public key");
  let producerPrivateKey: KeyObject;
  let controllerPublicKey: KeyObject;
  try {
    producerPrivateKey = createPrivateKey({ format: "der", key: privateDer, type: "pkcs8" });
    controllerPublicKey = createPublicKey({ format: "der", key: publicDer, type: "spki" });
  } catch (error) {
    invalid("bootstrap key material is invalid", { cause: error });
  } finally {
    privateDer.fill(0);
    publicDer.fill(0);
  }
  if (
    producerPrivateKey.type !== "private" ||
    producerPrivateKey.asymmetricKeyType !== "ed25519" ||
    controllerPublicKey.type !== "public" ||
    controllerPublicKey.asymmetricKeyType !== "ed25519"
  ) {
    invalid("bootstrap key algorithms are invalid");
  }
  return {
    binding,
    challenge,
    controllerKeyId: value.controllerKeyId,
    controllerPublicKey,
    producerKeyId: value.producerKeyId,
    producerPrivateKey,
  };
}

async function assertPrivatePipe(
  fd: number,
  code: ControlOnlyErrorCode,
  message: string,
): Promise<void> {
  try {
    const stats = await fstatFd(fd);
    if (!stats.isFIFO() && !stats.isSocket()) {
      throw new ControlOnlyEntryError(code, message);
    }
  } catch (error) {
    if (error instanceof ControlOnlyEntryError) throw error;
    throw new ControlOnlyEntryError(code, message, { cause: error });
  }
}

export async function readBootstrapLine(fd: number): Promise<string> {
  await assertPrivatePipe(fd, "bootstrap_fd_unavailable", "private bootstrap fd unavailable");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(8192);
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      let result: { bytesRead: number };
      try {
        result = await readFd(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EBADF") {
          throw new ControlOnlyEntryError(
            "bootstrap_fd_unavailable",
            "private bootstrap fd unavailable",
            { cause: error },
          );
        }
        throw new ControlOnlyEntryError("bootstrap_invalid", "bootstrap read failed", {
          cause: error,
        });
      }
      if (result.bytesRead === 0) {
        if (bytes === 0) {
          throw new ControlOnlyEntryError(
            "bootstrap_fd_unavailable",
            "private bootstrap fd unavailable",
          );
        }
        invalid("bootstrap ended before a complete line");
      }
      bytes += result.bytesRead;
      if (bytes > CONTROL_ONLY_BOOTSTRAP_MAX_BYTES) {
        invalid("bootstrap exceeds the size limit");
      }
      const chunk = Buffer.from(buffer.subarray(0, result.bytesRead));
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        completed = true;
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
    }
  } finally {
    // 只有成功读完完整 bootstrap frame 后才按一次关闭该 fd；这不是身份证明，
    // 也不把 frame 本身当作认证。EOF/ENXIO 可能来自运行时继承的 pipe，不能盲关，
    // 否则会破坏 libuv 内部 fd；失败路径依赖进程退出回收。
    if (completed) {
      await closeFd(fd).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EBADF") throw error;
      });
    }
  }
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

export async function writeReady(fd: number, material: ValidatedBootstrap): Promise<void> {
  await assertPrivatePipe(fd, "ready_write_failed", "ready fd unavailable");
  let stream;
  try {
    stream = createWriteStream("", { autoClose: true, fd });
  } catch (error) {
    throw new ControlOnlyEntryError("ready_write_failed", "ready fd unavailable", { cause: error });
  }
  const proof = startupProof(material.challenge, material.binding, process.pid);
  const ready = {
    version: 1,
    kind: "ready",
    binding: material.binding,
    challenge: material.challenge,
    producerPid: process.pid,
    signature: sign(null, Buffer.from(proof), material.producerPrivateKey).toString("base64"),
  };
  const line = `${JSON.stringify(ready)}\n`;
  if (Buffer.byteLength(line, "utf8") > CONTROL_ONLY_READY_MAX_BYTES) {
    throw new ControlOnlyEntryError("ready_write_failed", "ready frame exceeds the size limit");
  }
  try {
    stream.end(line);
    await finished(stream);
  } catch (error) {
    throw new ControlOnlyEntryError("ready_write_failed", "ready write failed", { cause: error });
  }
}

export async function createControlDuplex(
  readFdNumber: number,
  writeFdNumber: number,
): Promise<Duplex> {
  await Promise.all([
    assertPrivatePipe(readFdNumber, "control_fd_unavailable", "private control fd unavailable"),
    assertPrivatePipe(writeFdNumber, "control_fd_unavailable", "private control fd unavailable"),
  ]);
  // 两个 stream 拥有 fd5/fd6；channel.dispose()/Duplex.destroy() 统一关闭，外层不再按数字 close。
  return Duplex.from({
    readable: createReadStream("", { autoClose: true, fd: readFdNumber }),
    writable: createWriteStream("", { autoClose: true, fd: writeFdNumber }),
  });
}

export function writeFailure(writeStderr: (text: string) => void, code: string): void {
  const messages: Record<string, string> = {
    invalid_arguments: "invalid control-only arguments",
    bootstrap_fd_unavailable: "private bootstrap fd unavailable",
    bootstrap_invalid: "invalid bootstrap",
    control_fd_unavailable: "private control fd unavailable",
    ready_write_failed: "ready write failed",
    channel_failed: "control channel failed",
  };
  try {
    writeStderr(`node_repl control failed: ${messages[code] ?? "startup failed"}\n`);
  } catch {
    // The child is already failing closed; no fallback output path is safe.
  }
}
