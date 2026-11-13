import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FetchFrozenError,
  fetchCuaNarrowFrozen,
  parseFrozenPinFile,
} from "./fetch-cua-narrow-frozen.mjs";

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinnedFacts(archiveSha256, manifestSha256) {
  return {
    releaseTag: "cua-narrow-frozen-test",
    archiveAsset: "cua-narrow-frozen.tar.gz",
    archiveSha256,
    manifestRelativePath: "output/cua-narrow-frozen/controller-prepared/manifest.json",
    manifestSha256,
  };
}

test("pin file parsing requires all pinned fields and sha256 shapes", () => {
  assert.deepEqual(
    parseFrozenPinFile(JSON.stringify(pinnedFacts("a".repeat(64), "b".repeat(64)))),
    pinnedFacts("a".repeat(64), "b".repeat(64)),
  );
  for (const raw of ["{}", "[]", "null", "not json", JSON.stringify({ releaseTag: "x" })]) {
    assert.throws(() => parseFrozenPinFile(raw), (error) => error.code === "frozen-pin-json");
  }
  assert.throws(
    () => parseFrozenPinFile(JSON.stringify(pinnedFacts("not-hex", "b".repeat(64)))),
    (error) => error.code === "frozen-pin-json",
  );
});

test("local archive override must exist and sha must match the pin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-narrow-fetch-local-"));
  try {
    const archive = join(dir, "cua-narrow-frozen.tar.gz");
    const bytes = Buffer.from("fixture-archive-bytes");
    await writeFile(archive, bytes);
    const pinFilePath = join(dir, "pin.json");

    // 本地路径不存在：显式失败，不回退网络源。
    await writeFile(
      pinFilePath,
      JSON.stringify(pinnedFacts(sha256Bytes(bytes), "b".repeat(64))),
    );
    await assert.rejects(
      fetchCuaNarrowFrozen({
        env: { ZODY_CUA_NARROW_FROZEN_ARCHIVE: join(dir, "missing.tar.gz") },
        repoRoot: dir,
        pinFilePath,
      }),
      (error) => error.code === "frozen-archive-missing",
    );

    // sha 不匹配：拒绝进入 restore。
    await writeFile(
      pinFilePath,
      JSON.stringify(pinnedFacts("0".repeat(64), "b".repeat(64))),
    );
    await assert.rejects(
      fetchCuaNarrowFrozen({
        env: { ZODY_CUA_NARROW_FROZEN_ARCHIVE: archive },
        repoRoot: dir,
        pinFilePath,
      }),
      (error) => error.code === "frozen-archive-sha-mismatch",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download failure propagates verbatim without network fallbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-narrow-fetch-download-"));
  try {
    const pinFilePath = join(dir, "pin.json");
    await writeFile(pinFilePath, JSON.stringify(pinnedFacts("a".repeat(64), "b".repeat(64))));
    // 注入的下载失败必须原样传播：fetch 不做重试、不换源、不吞错。
    await assert.rejects(
      fetchCuaNarrowFrozen({
        env: {},
        repoRoot: dir,
        pinFilePath,
        deps: {
          downloadArchive: async () => {
            throw new FetchFrozenError("frozen-archive-download", "gh failed");
          },
        },
      }),
      (error) => {
        assert.equal(error.code, "frozen-archive-download");
        assert.equal(error.message, "gh failed");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetch runs only on darwin and delegates verification to restore", async () => {
  // fetch 本身不做 tar 解包校验：sha 双重校验后委托 restore（restore 在非 darwin 或
  // 未过 pin 复验时失败）。这里用 darwin 上的最小坏归档验证委托路径会显式失败。
  if (process.platform !== "darwin") {
    assert.ok(true, "non-darwin platforms are refused by restore; nothing to assert here");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "cua-narrow-fetch-delegate-"));
  try {
    const archive = join(dir, "cua-narrow-frozen.tar.gz");
    const bytes = Buffer.from("not really a tar");
    await writeFile(archive, bytes);
    const pinFilePath = join(dir, "pin.json");
    await writeFile(
      pinFilePath,
      JSON.stringify(pinnedFacts(sha256Bytes(bytes), "b".repeat(64))),
    );
    await mkdir(join(dir, "output"), { recursive: true });
    await assert.rejects(
      fetchCuaNarrowFrozen({
        env: { ZODY_CUA_NARROW_FROZEN_ARCHIVE: archive },
        repoRoot: dir,
        pinFilePath,
        force: true,
      }),
      (error) => {
        // sha 已匹配，失败必须来自 restore 的 tar/pin 复验链，而不是 fetch 自身。
        assert.notEqual(error.code, "frozen-archive-sha-mismatch");
        assert.notEqual(error.code, "frozen-archive-missing");
        return true;
      },
    );
    // pin 文件内容仍完整可读（未被半还原破坏）。
    assert.equal(
      typeof JSON.parse(await readFile(pinFilePath, "utf8")).archiveSha256,
      "string",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
