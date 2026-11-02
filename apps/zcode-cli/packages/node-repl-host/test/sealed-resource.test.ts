import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeUtf8Lossless,
  readBoundedBytes,
  readSealedResourceSnapshot,
} from "../src/sealed-resource.js";

const execFileAsync = promisify(execFile);
const SOURCE = "export const marker = 'ORIGINAL';\n";
const SHA = createHash("sha256").update(SOURCE).digest("hex");

describe.skipIf(process.platform === "win32")("sealed node-repl resource snapshot", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-sealed-resource-"));
  });

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reads the same bytes into an immutable UTF-8 snapshot", async () => {
    const path = join(directory, "server.mjs");
    await writeFile(path, SOURCE, "utf8");

    const snapshot = await readSealedResourceSnapshot({
      path,
      expectedSha256: SHA,
      maxBytes: 1024,
      expectedUid: process.getuid?.(),
    });

    expect(snapshot.source).toBe(SOURCE);
    expect(snapshot.sha256).toBe(SHA);
    expect(snapshot.size).toBe(Buffer.byteLength(SOURCE));
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("rejects a hash mismatch after reading the same handle", async () => {
    const path = join(directory, "server.mjs");
    await writeFile(path, SOURCE, "utf8");
    await expect(
      readSealedResourceSnapshot({
        path,
        expectedSha256: "0".repeat(64),
        maxBytes: 1024,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/sha_mismatch/u);
  });

  it("rejects a symlink with O_NOFOLLOW", async () => {
    const target = join(directory, "target.mjs");
    const link = join(directory, "server.mjs");
    await writeFile(target, SOURCE, "utf8");
    await symlink(target, link);
    await expect(
      readSealedResourceSnapshot({
        path: link,
        expectedSha256: SHA,
        maxBytes: 1024,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/open_failed/u);
  });

  it("rejects group/other writable resources", async () => {
    const path = join(directory, "server.mjs");
    await writeFile(path, SOURCE, "utf8");
    await chmod(path, 0o664);
    await expect(
      readSealedResourceSnapshot({
        path,
        expectedSha256: SHA,
        maxBytes: 1024,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/writable/u);
  });

  it("rejects empty and oversized resources", async () => {
    const empty = join(directory, "empty.mjs");
    await writeFile(empty, "", "utf8");
    await expect(
      readSealedResourceSnapshot({
        path: empty,
        expectedSha256: SHA,
        maxBytes: 1024,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/size_out_of_bounds/u);

    const oversized = join(directory, "oversized.mjs");
    await writeFile(oversized, "x".repeat(17), "utf8");
    await expect(
      readSealedResourceSnapshot({
        path: oversized,
        expectedSha256: SHA,
        maxBytes: 16,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/size_out_of_bounds/u);
  });

  it.skipIf(process.getuid === undefined)("rejects a mismatched owner uid", async () => {
    const path = join(directory, "server.mjs");
    await writeFile(path, SOURCE, "utf8");
    await expect(
      readSealedResourceSnapshot({
        path,
        expectedSha256: SHA,
        maxBytes: 1024,
        expectedUid: (process.getuid?.() ?? 0) + 1,
      }),
    ).rejects.toThrow(/owner_mismatch/u);
  });

  it("rejects a non-regular file", async () => {
    const path = join(directory, "server.mjs");
    await mkdir(path);
    await expect(
      readSealedResourceSnapshot({
        path,
        expectedSha256: SHA,
        maxBytes: 1024,
        expectedUid: process.getuid?.(),
      }),
    ).rejects.toThrow(/not_regular/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without blocking the open",
    async () => {
      const path = join(directory, "server.fifo");
      await execFileAsync("mkfifo", [path]);
      const outcome = await Promise.race([
        readSealedResourceSnapshot({
          path,
          expectedSha256: SHA,
          maxBytes: 1024,
          expectedUid: process.getuid?.(),
        }).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 2000),
        ),
      ]);
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toMatch(/not_regular/u);
      }
    },
    5000,
  );

  it("bounds growth while reading and never exceeds maxBytes", async () => {
    const total = Buffer.from("x".repeat(40));
    let offset = 0;
    await expect(
      readBoundedBytes(
        async (buffer) => {
          const remaining = total.length - offset;
          if (remaining <= 0) return 0;
          const length = Math.min(buffer.length, remaining, 8);
          total.copy(buffer, 0, offset, offset + length);
          offset += length;
          return length;
        },
        16,
        8,
      ),
    ).rejects.toThrow(/size_out_of_bounds/u);
  });

  it("rejects invalid UTF-8 instead of substituting U+FFFD", async () => {
    const invalid = Buffer.from([0xff, 0xfe, 0x00]);
    await expect(async () => decodeUtf8Lossless(invalid)).rejects.toThrow(/utf8_invalid/u);
  });
});
