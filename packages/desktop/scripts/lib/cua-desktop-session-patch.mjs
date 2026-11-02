// 冻结 session 源的 patch/header 校验与应用。所有目标路径必须留在 stage 内。
import { copyFile, readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { DesktopSessionBuildError } from "./cua-desktop-session-config.mjs";
import { run, sha256File } from "./cua-desktop-session-toolchain.mjs";

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

function unsafeRelativeTarget(file, label, details) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    isAbsolute(file) ||
    file.split(/[\\/]/).includes("..") ||
    normalize(file) !== file ||
    normalize(file) === "." ||
    normalize(file).startsWith(`..${sep}`)
  ) {
    throw new DesktopSessionBuildError(
      `${label}-unsafe-target`,
      `${label} must be a safe relative path inside the stage`,
      { file, ...details },
    );
  }
}

function stageTarget(stageRoot, file, label, details = {}) {
  unsafeRelativeTarget(file, label, details);
  const stage = resolve(stageRoot);
  const target = resolve(stage, file);
  const rel = relative(stage, target);
  if (
    rel === "" ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    isAbsolute(rel)
  ) {
    throw new DesktopSessionBuildError(
      `${label}-unsafe-target`,
      `${label} escapes the stage`,
      { file, stage, target, ...details },
    );
  }
  return target;
}

/** 严格按 baseline 顺序应用 patch；每个 patch 前后 hash 必须精确匹配。 */
export async function applySequentialPatches({
  stageRoot,
  baselinePath,
  entries,
}) {
  const patches = Array.isArray(entries) ? entries : [];
  if (patches.length === 0) {
    throw new DesktopSessionBuildError(
      "session-baseline-patches",
      "session baseline must pin at least one patch",
      { count: patches.length },
    );
  }
  const applied = [];
  for (const [index, entry] of patches.entries()) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.file !== "string"
    ) {
      throw new DesktopSessionBuildError(
        "session-patch-entry",
        "patch entry is incomplete",
        { index, entry },
      );
    }
    unsafeRelativeTarget(entry.file, "session-patch", {
      id: entry.id,
      index,
    });
    const patchPath = isAbsolute(entry.path)
      ? entry.path
      : resolve(dirname(baselinePath), entry.path);
    const patchSha256 = await sha256File(patchPath);
    if (patchSha256 !== entry.sha256) {
      throw new DesktopSessionBuildError(
        "session-patch-file-mismatch",
        `patch ${entry.id} bytes differ from the pinned hash`,
        { expected: entry.sha256, actual: patchSha256, patchPath, index },
      );
    }
    const { oldTargets, newTargets } = patchHeaders(
      await readFile(patchPath, "utf8"),
    );
    if (
      oldTargets.length === 0 ||
      newTargets.length === 0 ||
      oldTargets.some((target) => target !== entry.file) ||
      newTargets.some((target) => target !== entry.file)
    ) {
      throw new DesktopSessionBuildError(
        "session-patch-target-mismatch",
        `patch ${entry.id} does not name exactly ${entry.file} on both diff sides`,
        { id: entry.id, file: entry.file, oldTargets, newTargets, index },
      );
    }
    const targetPath = stageTarget(stageRoot, entry.file, "session-patch", {
      id: entry.id,
      index,
    });
    const beforeSha256 = await sha256File(targetPath);
    if (beforeSha256 !== entry.beforeSha256) {
      throw new DesktopSessionBuildError(
        "session-patch-baseline-mismatch",
        `patch ${entry.id} target does not match its pinned before hash`,
        {
          id: entry.id,
          file: entry.file,
          expected: entry.beforeSha256,
          actual: beforeSha256,
          index,
        },
      );
    }
    const patched = await run(
      "/usr/bin/patch",
      ["--fuzz=0", "-p1", "-i", patchPath],
      { cwd: stageRoot },
    );
    if (patched.code !== 0) {
      throw new DesktopSessionBuildError(
        "session-patch-failed",
        `patch ${entry.id} failed`,
        {
          id: entry.id,
          index,
          stdout: patched.stdout,
          stderr: patched.stderr,
        },
      );
    }
    const afterSha256 = await sha256File(targetPath);
    if (afterSha256 !== entry.afterSha256) {
      throw new DesktopSessionBuildError(
        "session-patch-output-mismatch",
        `patch ${entry.id} output differs from the pinned after hash`,
        {
          id: entry.id,
          file: entry.file,
          expected: entry.afterSha256,
          actual: afterSha256,
          index,
        },
      );
    }
    applied.push({
      id: entry.id,
      file: entry.file,
      patchPath,
      patchSha256,
      beforeSha256,
      afterSha256,
      fuzz: 0,
    });
  }
  return { applied, extraPatch: applied[0], extraPatches: applied };
}

export async function copyPinnedStopHeaders(stageRoot, baseline, baselinePath) {
  const headers = Array.isArray(baseline.headers) ? baseline.headers : [];
  const copied = [];
  for (const entry of headers) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.file !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new DesktopSessionBuildError(
        "session-header-entry",
        "header entry is incomplete",
        { entry },
      );
    }
    const sourcePath = isAbsolute(entry.path)
      ? entry.path
      : resolve(dirname(baselinePath), entry.path);
    const sourceSha256 = await sha256File(sourcePath);
    if (sourceSha256 !== entry.sha256) {
      throw new DesktopSessionBuildError(
        "session-header-file-mismatch",
        `header ${entry.id} bytes differ from the pinned hash`,
        { expected: entry.sha256, actual: sourceSha256, sourcePath },
      );
    }
    const targetPath = stageTarget(stageRoot, entry.file, "session-header", {
      id: entry.id,
    });
    await copyFile(sourcePath, targetPath);
    const copiedSha256 = await sha256File(targetPath);
    if (copiedSha256 !== entry.sha256) {
      throw new DesktopSessionBuildError(
        "session-header-copy-mismatch",
        `header ${entry.id} changed while copying`,
        { expected: entry.sha256, actual: copiedSha256, targetPath },
      );
    }
    copied.push({
      id: entry.id,
      file: entry.file,
      sourcePath,
      sha256: copiedSha256,
    });
  }
  return copied;
}

export async function verifyCaptureOwnerStage(stageRoot) {
  const captureOwnerPath = stageTarget(
    stageRoot,
    "src/capture_owner.mm",
    "session-capture-owner",
  );
  const captureOwner = await readFile(captureOwnerPath, "utf8");
  if (
    captureOwner.includes('authority.request(@"revoke"') ||
    !captureOwner.includes('outcome.reason = "captured"')
  ) {
    throw new DesktopSessionBuildError(
      "session-patch-verify",
      "capture_owner still auto-revokes or lost the normal capture terminal state",
      { captureOwnerPath },
    );
  }
}
