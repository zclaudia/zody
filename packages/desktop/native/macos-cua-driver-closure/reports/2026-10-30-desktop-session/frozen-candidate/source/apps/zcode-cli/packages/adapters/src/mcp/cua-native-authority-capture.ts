import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CuaSubmissionTurnScope } from "@zcode/contracts";
import {
  type CuaNativeAuthorityCaptureOptions,
  type CuaNativeCapturePngFacts,
  type CuaNativeCaptureResultPayload,
  type CuaNativeCaptureTarget,
  isBoundedString,
  isObject,
  readCuaSubmissionRef,
  sameCuaSubmissionRef,
} from "./cua-native-authority-contract.js";

export const CUA_NATIVE_CAPTURE_MAX_PNG_BYTES = 32 * 1024 * 1024;
export const CUA_NATIVE_CAPTURE_MAX_DIMENSION = 65_535;
export const CUA_NATIVE_CAPTURE_MODEL_IMAGE_MAX_BASE64_BYTES = 200 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CAPTURE_KEYS = new Set([
  "ref",
  "traceId",
  "producerIncarnation",
  "runId",
  "turnId",
  "target",
  "png",
  "resourcesReleased",
  "machineLeaseReleased",
]);
const PNG_KEYS = new Set(["path", "sha256", "width", "height", "bytes"]);
const TARGET_KEYS = new Set(["pid", "windowId"]);

export interface CuaNativeCaptureBinding {
  readonly scope: CuaSubmissionTurnScope;
  readonly producerIncarnation: string;
  readonly target: CuaNativeCaptureTarget;
}

export type CuaNativeCaptureParseResult =
  | { readonly ok: true; readonly payload: CuaNativeCaptureResultPayload }
  | { readonly ok: false; readonly reason: string };

export type CuaNativeCaptureFileResult =
  | {
      readonly ok: true;
      readonly payload: CuaNativeCaptureResultPayload;
      readonly bytes: Uint8Array;
    }
  | { readonly ok: false; readonly reason: string };

export function readCuaNativeCaptureTarget(value: unknown): CuaNativeCaptureTarget | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, TARGET_KEYS)) return undefined;
  if (!isPositiveSafeInteger(value.pid) || !isPositiveSafeInteger(value.windowId)) return undefined;
  return Object.freeze({ pid: value.pid, windowId: value.windowId });
}

export function sameCuaNativeCaptureTarget(
  left: CuaNativeCaptureTarget | undefined,
  right: CuaNativeCaptureTarget | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.windowId === right.windowId
  );
}

export function parseCuaNativeCaptureResult(
  payload: Record<string, unknown>,
  binding: CuaNativeCaptureBinding,
): CuaNativeCaptureParseResult {
  if (!hasOnlyKeys(payload, CAPTURE_KEYS)) return reject("invalid_payload");
  const ref = readCuaSubmissionRef(payload.ref);
  if (!ref) return reject("invalid_ref");
  if (!sameCuaSubmissionRef(ref, binding.scope.ref)) return reject("ref_mismatch");
  if (payload.traceId !== binding.scope.traceId) return reject("trace_mismatch");
  if (
    payload.producerIncarnation !== binding.producerIncarnation ||
    payload.runId !== binding.scope.runId ||
    payload.turnId !== binding.scope.turnId
  ) {
    return reject("association_mismatch");
  }
  const target = readCuaNativeCaptureTarget(payload.target);
  if (!target || !sameCuaNativeCaptureTarget(target, binding.target)) {
    return reject("target_mismatch");
  }
  const png = readPngFacts(payload.png);
  if (!png) return reject("invalid_png");
  if (payload.resourcesReleased !== true) return reject("resources_not_released");
  if (payload.machineLeaseReleased !== true) return reject("machine_lease_not_released");
  return {
    ok: true,
    payload: Object.freeze({
      ref,
      traceId: binding.scope.traceId,
      producerIncarnation: binding.producerIncarnation,
      runId: binding.scope.runId,
      turnId: binding.scope.turnId,
      target,
      png,
      resourcesReleased: true,
      machineLeaseReleased: true,
    }),
  };
}

export async function readCuaNativeCaptureFile(input: {
  readonly capture: CuaNativeAuthorityCaptureOptions;
  readonly payload: CuaNativeCaptureResultPayload;
  readonly isLive: () => boolean;
}): Promise<CuaNativeCaptureFileResult> {
  if (!input.isLive()) return reject("scope_invalidated");
  const root = resolve(input.capture.root);
  if (!isAbsolute(input.capture.root) || !isBoundedString(root))
    return reject("invalid_capture_root");
  const declaredPath = input.payload.png.path;
  if (!isAbsolute(declaredPath) || !isBoundedString(declaredPath))
    return reject("invalid_png_path");
  const path = resolve(declaredPath);
  if (!isBoundedString(path)) return reject("invalid_png_path");
  if (dirname(path) !== root) return reject("png_not_direct_child");

  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return reject("capture_root_unavailable");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return reject("invalid_capture_root");
  if ((rootStat.mode & 0o077) !== 0) return reject("capture_root_not_private");
  const uid = currentUid();
  if (uid !== undefined && rootStat.uid !== uid) return reject("capture_root_owner_mismatch");
  if (!input.isLive()) return reject("scope_invalidated");

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    return reject(isNoFollowError(error) ? "png_symlink" : "png_unavailable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return reject("png_not_regular");
    if (uid !== undefined && stat.uid !== uid) return reject("png_owner_mismatch");
    if (input.payload.png.bytes > CUA_NATIVE_CAPTURE_MAX_PNG_BYTES) {
      return reject("png_too_large");
    }
    if (!Number.isSafeInteger(stat.size) || stat.size !== input.payload.png.bytes) {
      return reject("png_size_mismatch");
    }
    if (!input.isLive()) return reject("scope_invalidated");
    const bytes = await readBoundedFile(handle, stat.size);
    if (!bytes) return reject("png_size_mismatch");
    if (!input.isLive()) return reject("scope_invalidated");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== input.payload.png.sha256) return reject("png_sha_mismatch");
    const ihdr = readPngIhdr(bytes);
    if (!ihdr) return reject("png_ihdr_invalid");
    if (ihdr.width !== input.payload.png.width || ihdr.height !== input.payload.png.height) {
      return reject("png_dimensions_mismatch");
    }
    if (!input.isLive()) return reject("scope_invalidated");
    return { ok: true, payload: input.payload, bytes };
  } catch {
    return reject("png_read_failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function hasCuaNativeCaptureImage(result: {
  readonly content: Array<Record<string, unknown>>;
}): boolean {
  return result.content.some(
    (block) =>
      block.type === "image" &&
      typeof block.mimeType === "string" &&
      /^image\/[a-z0-9.+-]+$/iu.test(block.mimeType) &&
      typeof block.data === "string" &&
      block.data.length > 0 &&
      Buffer.byteLength(block.data, "utf8") <= CUA_NATIVE_CAPTURE_MODEL_IMAGE_MAX_BASE64_BYTES,
  );
}

function readPngFacts(value: unknown): CuaNativeCapturePngFacts | undefined {
  if (!isObject(value) || !hasOnlyKeys(value, PNG_KEYS)) return undefined;
  if (!isBoundedString(value.path)) return undefined;
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) return undefined;
  if (!isPositiveSafeInteger(value.width) || value.width > CUA_NATIVE_CAPTURE_MAX_DIMENSION) {
    return undefined;
  }
  if (!isPositiveSafeInteger(value.height) || value.height > CUA_NATIVE_CAPTURE_MAX_DIMENSION) {
    return undefined;
  }
  if (!isPositiveSafeInteger(value.bytes) || value.bytes > CUA_NATIVE_CAPTURE_MAX_PNG_BYTES) {
    return undefined;
  }
  return Object.freeze({
    path: value.path,
    sha256: value.sha256,
    width: value.width,
    height: value.height,
    bytes: value.bytes,
  });
}

function readPngIhdr(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 33 || !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.readUInt32BE(8) !== 13 || view.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > CUA_NATIVE_CAPTURE_MAX_DIMENSION ||
    height > CUA_NATIVE_CAPTURE_MAX_DIMENSION
  ) {
    return undefined;
  }
  return { width, height };
}

async function readBoundedFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) return undefined;
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  const { bytesRead } = await handle.read(extra, 0, 1, size);
  return bytesRead === 0 ? buffer : undefined;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isNoFollowError(error: unknown): boolean {
  return isObject(error) && (error.code === "ELOOP" || error.code === "EMLINK");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function reject(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
