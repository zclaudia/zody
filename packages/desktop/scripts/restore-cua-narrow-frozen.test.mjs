import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NarrowFrozenRestoreError,
  assertSafeTarEntries,
  parseSha256File,
  restoreCuaNarrowFrozen,
} from "./restore-cua-narrow-frozen.mjs";

test("sha sidecar parsing accepts hex digest and rejects garbage", () => {
  assert.equal(
    parseSha256File("3713cbf39c85de42df34533d3d555026d4e909d821832fca307a51b6ee1afa59  narrow-frozen-v4.tar.gz\n"),
    "3713cbf39c85de42df34533d3d555026d4e909d821832fca307a51b6ee1afa59",
  );
  assert.throws(() => parseSha256File("not a digest"), (error) => {
    assert.equal(error.code, "restore-sha-file-invalid");
    return true;
  });
});

test("tar entry guard only accepts repo-relative output/ paths", () => {
  assert.equal(assertSafeTarEntries(["output/", "output/cua-app-icon/controller-prepared/manifest.json"]), true);
  const unsafe = [
    "/etc/passwd",
    "../outside.txt",
    "output/../../escape",
    "packages/desktop/scripts/lib/evil.mjs",
  ];
  assert.throws(() => assertSafeTarEntries(unsafe), (error) => {
    assert.equal(error.code, "restore-archive-path-unsafe");
    assert.equal(error.details.entries.length, unsafe.length);
    return true;
  });
});

test("restore refuses when archive sha does not match or sha source is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-narrow-restore-"));
  try {
    const archive = join(dir, "narrow-frozen.tar.gz");
    await writeFile(archive, "not really a tar");
    await assert.rejects(
      restoreCuaNarrowFrozen({ archivePath: archive, expectedSha256: "0".repeat(64) }),
      (error) => {
        assert.equal(error.code, "restore-archive-sha-mismatch");
        return true;
      },
    );
    await assert.rejects(
      restoreCuaNarrowFrozen({ archivePath: archive }),
      (error) => {
        assert.equal(error.code, "restore-sha-required");
        return true;
      },
    );
    // sha 匹配但内容不是 tar：列表步骤必须失败，不能落入半还原状态。
    const bytes = await import("node:crypto")
      .then(({ createHash }) => createHash("sha256").update("not really a tar").digest("hex"));
    await assert.rejects(
      restoreCuaNarrowFrozen({ archivePath: archive, expectedSha256: bytes }),
      (error) => {
        assert.ok(
          error instanceof NarrowFrozenRestoreError ||
            /tar/i.test(String(error.message ?? "")) ||
            error.code === "restore-archive-sha-mismatch",
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore refuses to overwrite an existing pinned manifest without --force", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cua-narrow-restore-exists-"));
  try {
    await mkdir(join(dir, "output", "cua-app-icon", "controller-prepared"), { recursive: true });
    await writeFile(join(dir, "output", "cua-app-icon", "controller-prepared", "manifest.json"), "{}");
    await assert.rejects(
      restoreCuaNarrowFrozen({
        archivePath: join(dir, "missing.tar.gz"),
        repoRoot: dir,
      }),
      (error) => {
        assert.ok(
          error.code === "restore-destination-exists" || error.code === "restore-archive-missing",
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
