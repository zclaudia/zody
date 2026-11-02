import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySequentialPatches,
  copyPinnedStopHeaders,
  verifyCaptureOwnerStage,
} from "../scripts/lib/cua-desktop-session-source.mjs";

const directories: string[] = [];

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function patchText(file: string, before: string, after: string): string {
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

function splitPatchText(oldFile: string, newFile: string, before: string, after: string): string {
  return [
    `--- a/${oldFile}`,
    `+++ b/${newFile}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-stop-source-"));
  directories.push(root);
  const stageRoot = join(root, "stage");
  const patchRoot = join(root, "patches");
  await Promise.all([mkdir(stageRoot), mkdir(patchRoot)]);
  return { root, stageRoot, patchRoot, baselinePath: join(root, "source-baseline.json") };
}

async function writePatch(
  patchRoot: string,
  name: string,
  file: string,
  before: string,
  after: string,
) {
  const path = join(patchRoot, `${name}.patch`);
  await writeFile(path, patchText(file, before, after));
  return {
    id: name,
    file,
    path: `patches/${name}.patch`,
    sha256: sha256(await readFile(path, "utf8")),
    beforeSha256: sha256(`${before}\n`),
    afterSha256: sha256(`${after}\n`),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("desktop-session sequential source patches", () => {
  it("keeps the old single-patch report shape while exposing the ordered list", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const first = await writePatch(patchRoot, "first", "capture_owner.mm", "v1", "v2");

    const result = await applySequentialPatches({
      stageRoot,
      baselinePath,
      entries: [first],
    });

    expect(await readFile(join(stageRoot, "capture_owner.mm"), "utf8")).toBe("v2\n");
    expect(result.extraPatch).toEqual(result.extraPatches[0]);
    expect(result.extraPatches).toHaveLength(1);
    expect(result.extraPatches[0]).toMatchObject({
      id: "first",
      beforeSha256: first.beforeSha256,
      afterSha256: first.afterSha256,
      fuzz: 0,
    });
  });

  it("applies multiple patches only in the pinned sequential hash order", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const first = await writePatch(patchRoot, "first", "capture_owner.mm", "v1", "v2");
    const second = await writePatch(patchRoot, "second", "capture_owner.mm", "v2", "v3");
    const third = await writePatch(patchRoot, "third", "capture_owner.mm", "v3", "v4");

    const result = await applySequentialPatches({
      stageRoot,
      baselinePath,
      entries: [first, second, third],
    });

    expect(await readFile(join(stageRoot, "capture_owner.mm"), "utf8")).toBe("v4\n");
    expect(result.extraPatches.map((entry: { id: string }) => entry.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("rejects an out-of-order patch before it can change the staged file", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const first = await writePatch(patchRoot, "first", "capture_owner.mm", "v1", "v2");
    const second = await writePatch(patchRoot, "second", "capture_owner.mm", "v2", "v3");

    await expect(
      applySequentialPatches({
        stageRoot,
        baselinePath,
        entries: [second, first],
      }),
    ).rejects.toMatchObject({
      code: "session-patch-baseline-mismatch",
      details: { id: "second", file: "capture_owner.mm" },
    });
    expect(await readFile(join(stageRoot, "capture_owner.mm"), "utf8")).toBe("v1\n");
  });

  it("rejects patch bytes, target bytes and patched output that drift from the pins", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const entry = await writePatch(patchRoot, "first", "capture_owner.mm", "v1", "v2");

    await expect(
      applySequentialPatches({
        stageRoot,
        baselinePath,
        entries: [{ ...entry, sha256: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "session-patch-file-mismatch" });

    await expect(
      applySequentialPatches({
        stageRoot,
        baselinePath,
        entries: [{ ...entry, beforeSha256: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "session-patch-baseline-mismatch" });

    await expect(
      applySequentialPatches({
        stageRoot,
        baselinePath,
        entries: [{ ...entry, afterSha256: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "session-patch-output-mismatch" });
  });

  it("rejects a patch that claims to target a different file", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const path = join(patchRoot, "wrong-target.patch");
    await writeFile(path, patchText("other.mm", "v1", "v2"));
    const entry = {
      id: "wrong-target",
      file: "capture_owner.mm",
      path: "patches/wrong-target.patch",
      sha256: sha256(await readFile(path, "utf8")),
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    };

    await expect(
      applySequentialPatches({ stageRoot, baselinePath, entries: [entry] }),
    ).rejects.toMatchObject({ code: "session-patch-target-mismatch" });
    expect(await readFile(join(stageRoot, "capture_owner.mm"), "utf8")).toBe("v1\n");
  });

  it("requires both old and new patch headers to name the pinned target", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");
    const path = join(patchRoot, "old-target-differs.patch");
    await writeFile(path, splitPatchText("other.mm", "capture_owner.mm", "v1", "v2"));
    const entry = {
      id: "old-target-differs",
      file: "capture_owner.mm",
      path: "patches/old-target-differs.patch",
      sha256: sha256(await readFile(path, "utf8")),
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    };

    await expect(
      applySequentialPatches({ stageRoot, baselinePath, entries: [entry] }),
    ).rejects.toMatchObject({ code: "session-patch-target-mismatch" });
    expect(await readFile(join(stageRoot, "capture_owner.mm"), "utf8")).toBe("v1\n");
  });

  it("rejects absolute and parent-relative patch targets before reading outside the stage", async () => {
    const { stageRoot, patchRoot, baselinePath } = await fixture();
    await writeFile(join(stageRoot, "capture_owner.mm"), "v1\n");

    for (const [id, file] of [
      ["parent-target", "../outside.mm"],
      ["absolute-target", "/tmp/outside.mm"],
    ]) {
      const path = join(patchRoot, `${id}.patch`);
      await writeFile(path, patchText(file, "v1", "v2"));
      const entry = {
        id,
        file,
        path: `patches/${id}.patch`,
        sha256: sha256(await readFile(path, "utf8")),
        beforeSha256: sha256("v1\n"),
        afterSha256: sha256("v2\n"),
      };

      await expect(
        applySequentialPatches({ stageRoot, baselinePath, entries: [entry] }),
      ).rejects.toMatchObject({ code: "session-patch-unsafe-target" });
    }
  });

  it("rejects header copy targets that escape the stage", async () => {
    const { root, stageRoot } = await fixture();
    const source = join(root, "header.h");
    await writeFile(source, "#pragma once\n");
    const baselinePath = join(root, "headers-baseline.json");

    await expect(
      copyPinnedStopHeaders(
        stageRoot,
        {
          headers: [
            {
              id: "escaping-header",
              file: "../escape.h",
              path: source,
              sha256: sha256("#pragma once\n"),
            },
          ],
        },
        baselinePath,
      ),
    ).rejects.toMatchObject({ code: "session-header-unsafe-target" });
  });

  it("verifies the fixed capture owner path rather than a patch-declared path", async () => {
    const { stageRoot } = await fixture();
    await mkdir(join(stageRoot, "src"));
    await writeFile(
      join(stageRoot, "src/capture_owner.mm"),
      'outcome.reason = "captured";\n',
    );
    await writeFile(join(stageRoot, "not-capture-owner.mm"), "unrelated\n");

    await expect(verifyCaptureOwnerStage(stageRoot)).resolves.toBeUndefined();
  });
});
