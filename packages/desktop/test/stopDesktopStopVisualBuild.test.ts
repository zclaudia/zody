import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STOP_VISUAL_BASELINE,
  STOP_VISUAL_PATCH,
  STOP_VISUAL_PROFILES,
  applyStopVisualPatch,
  resolveStopVisualOutputRoot,
  stopCancelImplementationDigests,
} from "../scripts/lib/cua-desktop-stop-visual-config.mjs";
import { REPO_ROOT } from "../scripts/lib/cua-desktop-session-config.mjs";

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

function swiftPatchSection(patch: string): string {
  const lines = patch.split("\n");
  const start = lines.indexOf(
    "--- a/crates/cua-macos-visual/native/CuaVisualCapture.swift",
  );
  const end = lines.indexOf(
    "--- a/crates/cua-macos-visual/src/capture.rs",
    start + 1,
  );
  if (start < 0 || end <= start) {
    throw new Error("pinned stop visual patch has no Swift section");
  }
  return `${lines.slice(start, end).join("\n")}\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-stop-visual-"));
  directories.push(root);
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  return { root, sourceRoot, baselinePath: join(root, "baseline.json") };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("desktop stop visual profiles", () => {
  it("keeps production gate-free and enables the diagnostic feature only for diagnostic", () => {
    expect(STOP_VISUAL_PROFILES.production.gateEnabled).toBe(false);
    expect(STOP_VISUAL_PROFILES.production.cargoFeatures).toEqual([]);
    expect(STOP_VISUAL_PROFILES.diagnostic.gateEnabled).toBe(true);
    expect(STOP_VISUAL_PROFILES.diagnostic.cargoFeatures).toEqual([
      "stop-diagnostic",
    ]);
    expect(STOP_VISUAL_PROFILES.production.cancelImplementation).toEqual(
      STOP_VISUAL_PROFILES.diagnostic.cancelImplementation,
    );
  });

  it("keeps production and diagnostic roots independent inside the widened boundary", () => {
    const production = resolveStopVisualOutputRoot({ profile: "production" });
    const diagnostic = resolveStopVisualOutputRoot({ profile: "diagnostic" });
    expect(production).toMatch(
      /output\/cua-arm64-screenshot\/stop-worker\/production$/,
    );
    expect(diagnostic).toMatch(
      /output\/cua-arm64-screenshot\/stop-worker\/diagnostic$/,
    );
    expect(production).not.toBe(diagnostic);
    expect(
      resolveStopVisualOutputRoot({
        profile: "diagnostic",
        outputRoot:
          "output/cua-arm64-screenshot/stop-worker/controller-rebuild",
      }),
    ).toMatch(/output\/cua-arm64-screenshot\/stop-worker\/controller-rebuild$/);

    expect(() =>
      resolveStopVisualOutputRoot({
        profile: "production",
        outputRoot: "/tmp/outside",
      }),
    ).toThrow(/strictly inside/);
    expect(() =>
      resolveStopVisualOutputRoot({
        profile: "diagnostic",
        outputRoot: "output/cua-helper-round11/visual-worker",
      }),
    ).toThrow(/strictly inside/);
    expect(() =>
      resolveStopVisualOutputRoot({
        profile: "diagnostic",
        outputRoot: "output/cua-arm64-screenshot",
      }),
    ).toThrow(/strictly inside/);
  });

  it("records the shared session cancel implementation separately from the visual patch", async () => {
    const digests = await stopCancelImplementationDigests();
    expect(digests.lifecyclePatchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(digests.lifecycleAfterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(digests.captureOwnerFile).toBe("src/capture_owner.mm");
  });
});

describe("stop visual derived lifecycle", () => {
  it("waits for the real completion before gating and releases held resources", async () => {
    const baseline = JSON.parse(await readFile(STOP_VISUAL_BASELINE, "utf8"));
    const patch = await readFile(STOP_VISUAL_PATCH, "utf8");
    const root = await mkdtemp(join(tmpdir(), "zcode-stop-visual-lifecycle-"));
    directories.push(root);
    const sourceRoot = join(root, "source");
    const swiftPath = "crates/cua-macos-visual/native/CuaVisualCapture.swift";
    await mkdir(join(sourceRoot, "crates/cua-macos-visual/native"), {
      recursive: true,
    });
    await copyFile(
      join(REPO_ROOT, baseline.source.root, swiftPath),
      join(sourceRoot, swiftPath),
    );
    const patchPath = join(root, "swift.patch");
    await writeFile(patchPath, swiftPatchSection(patch));
    execFileSync("/usr/bin/patch", ["--fuzz=0", "-p1", "-i", patchPath], {
      cwd: sourceRoot,
    });
    const swift = await readFile(join(sourceRoot, swiftPath), "utf8");

    expect(swift).not.toContain("consumeAfterSubmit");
    const waitIndex = swift.indexOf("mailbox.waitReadyAfterSubmit()");
    const gateIndex = swift.indexOf(
      "cua_r11_visual_wait_diagnostic_gate(",
      waitIndex,
    );
    expect(waitIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(waitIndex);

    const stopBranch = swift.slice(
      swift.indexOf("if gate == 1 {"),
      swift.indexOf("if gate == 2 {"),
    );
    expect(stopBranch.indexOf("mailbox.discard()")).toBeGreaterThan(-1);
    expect(stopBranch.indexOf("mailbox.discard()")).toBeLessThan(
      stopBranch.indexOf("finish(.canceled"),
    );
    expect(stopBranch.indexOf("return")).toBeGreaterThan(
      stopBranch.indexOf("finish(.canceled"),
    );

    const timeoutBranch = swift.slice(
      swift.indexOf("if gate == 2 {"),
      swift.indexOf("if gate != 0 {"),
    );
    expect(timeoutBranch).toContain("mailbox.discard()");
    expect(timeoutBranch).toContain("finish(.captureFailed");
    expect(timeoutBranch.indexOf("return")).toBeGreaterThan(
      timeoutBranch.indexOf("finish(.captureFailed"),
    );

    const errorStart = swift.indexOf("if gate != 0 {");
    const errorBranch = swift.slice(
      errorStart,
      swift.indexOf("#endif", errorStart),
    );
    expect(errorBranch).toContain("mailbox.discard()");
    expect(errorBranch).toContain("finish(.captureFailed");
    expect(errorBranch.indexOf("return")).toBeGreaterThan(
      errorBranch.indexOf("finish(.captureFailed"),
    );

    const mismatchBranch = swift.slice(
      swift.indexOf("if !targetMatches {"),
      swift.indexOf("mailbox.publishSubmit()"),
    );
    expect(mismatchBranch).toContain("mailbox.discard()");
    expect(mismatchBranch).toContain("finish(.admissionRejected");

    expect(swift).toContain("func takeHeldCompletion()");
    expect(swift).toContain("prepareCompletion(");
    const prepareBranch = swift.slice(
      swift.indexOf("let prepared = prepareCompletion("),
    );
    expect(prepareBranch.indexOf("prepared.rgba")).toBeGreaterThan(-1);
    expect(prepareBranch).not.toContain("heldImage");
  });
});

describe("stop visual patch application", () => {
  it("applies a pinned patch and verifies every file before and after", async () => {
    const { sourceRoot, baselinePath } = await fixture();
    await mkdir(join(sourceRoot, "crates/foo"), { recursive: true });
    await writeFile(join(sourceRoot, "crates/foo/a.rs"), "v1\n");
    const patchPath = join(baselinePath, "..", "stop.patch");
    await writeFile(patchPath, patchText("crates/foo/a.rs", "v1", "v2"));

    const result = await applyStopVisualPatch({
      sourceRoot,
      patchPath,
      patchSha256: sha256(await readFile(patchPath, "utf8")),
      files: [
        {
          file: "crates/foo/a.rs",
          beforeSha256: sha256("v1\n"),
          afterSha256: sha256("v2\n"),
        },
      ],
      baselinePath,
    });

    expect(await readFile(join(sourceRoot, "crates/foo/a.rs"), "utf8")).toBe(
      "v2\n",
    );
    expect(result.patchSha256).toBe(sha256(await readFile(patchPath, "utf8")));
    expect(result.files[0]).toMatchObject({
      file: "crates/foo/a.rs",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    });
  });

  it("rejects patch bytes, before bytes, after bytes and escaping file pins", async () => {
    const { sourceRoot, baselinePath } = await fixture();
    await mkdir(join(sourceRoot, "crates/foo"), { recursive: true });
    await writeFile(join(sourceRoot, "crates/foo/a.rs"), "v1\n");
    const patchPath = join(baselinePath, "..", "stop.patch");
    await writeFile(patchPath, patchText("crates/foo/a.rs", "v1", "v2"));
    const pin = {
      file: "crates/foo/a.rs",
      beforeSha256: sha256("v1\n"),
      afterSha256: sha256("v2\n"),
    };

    await expect(
      applyStopVisualPatch({
        sourceRoot,
        patchPath,
        patchSha256: "0".repeat(64),
        files: [pin],
        baselinePath,
      }),
    ).rejects.toMatchObject({ code: "stop-visual-patch-file-mismatch" });

    await expect(
      applyStopVisualPatch({
        sourceRoot,
        patchPath,
        patchSha256: sha256(await readFile(patchPath, "utf8")),
        files: [{ ...pin, beforeSha256: "0".repeat(64) }],
        baselinePath,
      }),
    ).rejects.toMatchObject({ code: "stop-visual-patch-baseline-mismatch" });

    await expect(
      applyStopVisualPatch({
        sourceRoot,
        patchPath,
        patchSha256: sha256(await readFile(patchPath, "utf8")),
        files: [{ ...pin, afterSha256: "0".repeat(64) }],
        baselinePath,
      }),
    ).rejects.toMatchObject({ code: "stop-visual-patch-output-mismatch" });

    const escapingPatch = join(baselinePath, "..", "escape.patch");
    await writeFile(escapingPatch, patchText("../outside.rs", "v1", "v2"));
    await expect(
      applyStopVisualPatch({
        sourceRoot,
        patchPath: escapingPatch,
        patchSha256: sha256(await readFile(escapingPatch, "utf8")),
        files: [
          {
            file: "../outside.rs",
            beforeSha256: sha256("v1\n"),
            afterSha256: sha256("v2\n"),
          },
        ],
        baselinePath,
      }),
    ).rejects.toMatchObject({ code: "stop-visual-patch-unsafe-target" });
  });
});
