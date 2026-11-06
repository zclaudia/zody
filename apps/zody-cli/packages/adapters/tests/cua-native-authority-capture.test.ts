import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CuaSubmissionRef } from "@zody/contracts";
import {
  CUA_NATIVE_CAPTURE_MAX_PNG_BYTES,
  CUA_NATIVE_CAPTURE_MODEL_IMAGE_MAX_BASE64_BYTES,
  hasCuaNativeCaptureImage,
  readCuaNativeCaptureFile,
} from "../src/mcp/cua-native-authority-capture.js";
import type { CuaNativeCaptureResultPayload } from "../src/mcp/cua-native-authority-contract.js";

const ref: CuaSubmissionRef = {
  submissionLineageId: "lineage-capture",
  authorizationRevision: 1,
  appIncarnation: "app-capture",
  hostInstanceId: "host-capture",
  runtimeInstanceId: "runtime-capture",
  sessionId: "session-capture",
  workspaceKey: "/workspace/capture",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.write("tail", 33, "ascii");
  return bytes;
}

async function fixture(options: { mode?: number; width?: number; height?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zody-cua-evidence-"));
  roots.push(root);
  await chmod(root, options.mode ?? 0o700);
  const bytes = pngBytes(options.width ?? 640, options.height ?? 480);
  const path = join(root, "capture.png");
  await writeFile(path, bytes);
  const payload: CuaNativeCaptureResultPayload = {
    ref,
    traceId: "trace-capture",
    producerIncarnation: "producer-capture",
    runId: "run-capture",
    turnId: "turn-capture",
    target: { pid: 42, windowId: 99 },
    png: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 640,
      height: 480,
      bytes: bytes.byteLength,
    },
    resourcesReleased: true,
    machineLeaseReleased: true,
  };
  return { root, path, bytes, payload };
}

function read(input: Awaited<ReturnType<typeof fixture>>, isLive = () => true) {
  return readCuaNativeCaptureFile({
    capture: { root: input.root, target: { pid: 42, windowId: 99 }, accept: async () => ({ content: [] }) },
    payload: input.payload,
    isLive,
  });
}

describe("readCuaNativeCaptureFile", () => {
  it("accepts only a live direct-child regular PNG with matching facts", async () => {
    const input = await fixture();
    const result = await read(input);
    expect(result).toMatchObject({ ok: true, payload: { png: input.payload.png } });
    if (result.ok) expect(Buffer.from(result.bytes).equals(input.bytes)).toBe(true);
  });

  it("rejects symlinks, non-private roots, nested paths and evidence mismatches", async () => {
    const symlinked = await fixture();
    const linkPath = join(symlinked.root, "link.png");
    await symlink(symlinked.path, linkPath);
    symlinked.payload = { ...symlinked.payload, png: { ...symlinked.payload.png, path: linkPath } };
    await expect(read(symlinked)).resolves.toMatchObject({ ok: false, reason: "png_symlink" });

    const publicRoot = await fixture({ mode: 0o755 });
    await expect(read(publicRoot)).resolves.toMatchObject({
      ok: false,
      reason: "capture_root_not_private",
    });

    const nested = await fixture();
    const nestedDir = join(nested.root, "nested");
    await mkdir(nestedDir);
    const nestedPath = join(nestedDir, "capture.png");
    await writeFile(nestedPath, nested.bytes);
    nested.payload = { ...nested.payload, png: { ...nested.payload.png, path: nestedPath } };
    await expect(read(nested)).resolves.toMatchObject({ ok: false, reason: "png_not_direct_child" });

    const badSha = await fixture();
    badSha.payload = { ...badSha.payload, png: { ...badSha.payload.png, sha256: "a".repeat(64) } };
    await expect(read(badSha)).resolves.toMatchObject({ ok: false, reason: "png_sha_mismatch" });

    const badDimensions = await fixture();
    badDimensions.payload = {
      ...badDimensions.payload,
      png: { ...badDimensions.payload.png, width: 641 },
    };
    await expect(read(badDimensions)).resolves.toMatchObject({
      ok: false,
      reason: "png_dimensions_mismatch",
    });

    const badSize = await fixture();
    badSize.payload = {
      ...badSize.payload,
      png: { ...badSize.payload.png, bytes: badSize.payload.png.bytes + 1 },
    };
    await expect(read(badSize)).resolves.toMatchObject({ ok: false, reason: "png_size_mismatch" });

    const oversized = await fixture();
    oversized.payload = {
      ...oversized.payload,
      png: { ...oversized.payload.png, bytes: CUA_NATIVE_CAPTURE_MAX_PNG_BYTES + 1 },
    };
    await expect(read(oversized)).resolves.toMatchObject({ ok: false, reason: "png_too_large" });
  });

  it("checks scope before and after reading", async () => {
    const input = await fixture();
    await expect(read(input, () => false)).resolves.toMatchObject({
      ok: false,
      reason: "scope_invalidated",
    });
    let checks = 0;
    const result = await read(input, () => {
      checks += 1;
      return checks < 4;
    });
    expect(result).toMatchObject({ ok: false, reason: "scope_invalidated" });
  });

  it("accepts the processor's actual image MIME within the model base64 budget", () => {
    expect(
      hasCuaNativeCaptureImage({
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }],
      }),
    ).toBe(true);
    expect(
      hasCuaNativeCaptureImage({
        content: [
          {
            type: "image",
            data: "a".repeat(CUA_NATIVE_CAPTURE_MODEL_IMAGE_MAX_BASE64_BYTES + 1),
            mimeType: "image/png",
          },
        ],
      }),
    ).toBe(false);
  });
});
