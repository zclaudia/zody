// Derived visual profiles for the stop-worker. Production and diagnostic share
// the exact same cancellation implementation; only the diagnostic profile
// compiles the build-time gate and its feature.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  DesktopSessionBuildError,
  REPO_ROOT,
  SESSION_BASELINE,
} from "./cua-desktop-session-config.mjs";
import { run, sha256File } from "./cua-desktop-session-toolchain.mjs";

export const STOP_VISUAL_OUTPUT_BOUNDARY = join(
  REPO_ROOT,
  "output/cua-arm64-screenshot",
);
export const STOP_VISUAL_BASELINE = join(
  REPO_ROOT,
  "packages/desktop/native/macos-cua-desktop-session/visual-stop/source-baseline.json",
);
export const STOP_VISUAL_HEADER = join(
  REPO_ROOT,
  "packages/desktop/native/macos-cua-desktop-session/visual-stop/include/cua_r11_visual.h",
);
export const STOP_VISUAL_PATCH = join(
  REPO_ROOT,
  "packages/desktop/native/macos-cua-desktop-session/visual-stop/patches/cua-r11-stop-visual.patch",
);

const SHARED_CANCEL_IMPLEMENTATION = "capture-owner-stop-lifecycle-v1";

export const STOP_VISUAL_PROFILES = Object.freeze({
  production: Object.freeze({
    name: "production",
    gateEnabled: false,
    cargoFeatures: [],
    cancelImplementation: SHARED_CANCEL_IMPLEMENTATION,
  }),
  diagnostic: Object.freeze({
    name: "diagnostic",
    gateEnabled: true,
    cargoFeatures: ["stop-diagnostic"],
    cancelImplementation: SHARED_CANCEL_IMPLEMENTATION,
  }),
});

function stopVisualError(code, message, details) {
  return new DesktopSessionBuildError(`stop-visual-${code}`, message, details);
}

function insideBoundary(boundary, target) {
  const rel = relative(boundary, target);
  return (
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel)
  );
}

export function resolveStopVisualOutputRoot({ profile, outputRoot } = {}) {
  if (!STOP_VISUAL_PROFILES[profile]) {
    throw stopVisualError(
      "profile",
      `unknown stop visual profile: ${profile}`,
      { profile },
    );
  }
  const root = resolve(
    outputRoot ?? join(STOP_VISUAL_OUTPUT_BOUNDARY, "stop-worker", profile),
  );
  if (!insideBoundary(STOP_VISUAL_OUTPUT_BOUNDARY, root)) {
    throw stopVisualError(
      "output-boundary",
      "stop visual output root must stay strictly inside output/cua-arm64-screenshot",
      { profile, outputRoot: root, boundary: STOP_VISUAL_OUTPUT_BOUNDARY },
    );
  }
  return root;
}

export async function stopCancelImplementationDigests() {
  const baseline = JSON.parse(await readFile(SESSION_BASELINE, "utf8"));
  const lifecycle = baseline.patches?.find(
    (entry) => entry.id === "capture-owner-stop-lifecycle",
  );
  if (!lifecycle) {
    throw stopVisualError(
      "cancel-implementation",
      "session baseline does not pin capture-owner-stop-lifecycle",
      { baseline: SESSION_BASELINE },
    );
  }
  return {
    captureOwnerFile: lifecycle.file,
    lifecyclePatchSha256: lifecycle.sha256,
    lifecycleAfterSha256: lifecycle.afterSha256,
    implementation: SHARED_CANCEL_IMPLEMENTATION,
  };
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assertSafeTarget(file, label, details) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    isAbsolute(file) ||
    file.split(/[\\/]/).includes("..") ||
    normalize(file) !== file ||
    normalize(file) === "." ||
    normalize(file).startsWith(`..${sep}`)
  ) {
    throw stopVisualError(
      "patch-unsafe-target",
      `${label} must stay inside the stage`,
      {
        file,
        ...details,
      },
    );
  }
}

function stageTarget(sourceRoot, file, label, details) {
  assertSafeTarget(file, label, details);
  const root = resolve(sourceRoot);
  const target = resolve(root, file);
  const rel = relative(root, target);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw stopVisualError("patch-unsafe-target", `${label} escapes the stage`, {
      file,
      root,
      target,
      ...details,
    });
  }
  return target;
}

function patchHeaders(text) {
  const oldTargets = [];
  const newTargets = [];
  for (const line of text.split(/\r?\n/)) {
    const oldMatch = /^---\s+(.+?)(?:\t.*)?$/.exec(line);
    const newMatch = /^\+\+\+\s+(.+?)(?:\t.*)?$/.exec(line);
    if (oldMatch) oldTargets.push(oldMatch[1].replace(/^a\//, ""));
    if (newMatch) newTargets.push(newMatch[1].replace(/^b\//, ""));
  }
  return { oldTargets, newTargets };
}

/** Apply one derived visual patch with exact before/after and both-side target pins. */
export async function applyStopVisualPatch({
  sourceRoot,
  patchPath,
  patchSha256,
  files,
  baselinePath,
}) {
  const pins = Array.isArray(files) ? files : [];
  if (pins.length === 0) {
    throw stopVisualError(
      "patch-files",
      "visual patch must pin at least one file",
      {},
    );
  }
  const resolvedPatch = isAbsolute(patchPath)
    ? patchPath
    : resolve(
        baselinePath ? resolve(baselinePath, "..") : REPO_ROOT,
        patchPath,
      );
  const actualPatchSha256 = await sha256File(resolvedPatch);
  if (actualPatchSha256 !== patchSha256) {
    throw stopVisualError(
      "patch-file-mismatch",
      "visual patch bytes differ from the pin",
      {
        expected: patchSha256,
        actual: actualPatchSha256,
        patchPath: resolvedPatch,
      },
    );
  }
  const patchText = await readFile(resolvedPatch, "utf8");
  const { oldTargets, newTargets } = patchHeaders(patchText);
  const expectedTargets = new Set(pins.map((entry) => entry.file));
  if (
    oldTargets.length === 0 ||
    newTargets.length === 0 ||
    oldTargets.length !== expectedTargets.size ||
    newTargets.length !== expectedTargets.size ||
    oldTargets.some((target) => !expectedTargets.has(target)) ||
    newTargets.some((target) => !expectedTargets.has(target)) ||
    oldTargets.some((target, index) => target !== newTargets[index])
  ) {
    throw stopVisualError(
      "patch-target-mismatch",
      "visual patch does not name every pinned file exactly on both diff sides",
      { oldTargets, newTargets, files: pins.map((entry) => entry.file) },
    );
  }
  for (const target of [...oldTargets, ...newTargets]) {
    assertSafeTarget(target, "visual patch target", {
      patchPath: resolvedPatch,
    });
  }

  const before = [];
  for (const pin of pins) {
    const targetPath = stageTarget(
      sourceRoot,
      pin.file,
      "visual patch target",
      {
        patchPath: resolvedPatch,
      },
    );
    const actual = await sha256File(targetPath);
    if (actual !== pin.beforeSha256) {
      throw stopVisualError(
        "patch-baseline-mismatch",
        `visual patch target ${pin.file} does not match its before hash`,
        { file: pin.file, expected: pin.beforeSha256, actual },
      );
    }
    before.push({ ...pin, targetPath });
  }
  const applied = await run(
    "/usr/bin/patch",
    ["--fuzz=0", "-p1", "-i", resolvedPatch],
    { cwd: sourceRoot },
  );
  if (applied.code !== 0) {
    throw stopVisualError("patch-failed", "visual patch failed", {
      stdout: applied.stdout,
      stderr: applied.stderr,
      patchPath: resolvedPatch,
    });
  }
  const resultFiles = [];
  for (const pin of before) {
    const actual = await sha256File(pin.targetPath);
    if (actual !== pin.afterSha256) {
      throw stopVisualError(
        "patch-output-mismatch",
        `visual patch output ${pin.file} differs from its after hash`,
        { file: pin.file, expected: pin.afterSha256, actual },
      );
    }
    resultFiles.push({
      file: pin.file,
      beforeSha256: pin.beforeSha256,
      afterSha256: pin.afterSha256,
    });
  }
  return {
    patchPath: resolvedPatch,
    patchSha256: actualPatchSha256,
    patchTextSha256: sha256Text(patchText),
    files: resultFiles,
  };
}
