// Prepare a fresh stop-worker visual source stage from the frozen R9 tree and
// R11 visual overlay. Every source/overlay/patch input is hash-pinned before a
// derived file can be compiled.
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  DesktopSessionBuildError,
  FIXED_DEPLOYMENT_TARGET,
  REPO_ROOT,
} from "./cua-desktop-session-config.mjs";
import { run, sha256File } from "./cua-desktop-session-toolchain.mjs";
import {
  STOP_VISUAL_BASELINE,
  STOP_VISUAL_PROFILES,
  applyStopVisualPatch,
  resolveStopVisualOutputRoot,
  stopCancelImplementationDigests,
} from "./cua-desktop-stop-visual-config.mjs";

export { STOP_VISUAL_BASELINE, STOP_VISUAL_PROFILES };

const VISUAL_CRATE = "crates/cua-macos-visual";

function stopSourceError(code, message, details) {
  return new DesktopSessionBuildError(`stop-visual-${code}`, message, details);
}

function computeTreeSha256(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(`${file.path}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

export async function scanStopVisualTree(root) {
  const files = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        files.push({ path, sha256: await sha256File(absolute) });
      } else {
        throw stopSourceError("source-shape", `unsupported visual source entry: ${path}`, {
          path,
        });
      }
    }
  }
  await walk(root, "");
  return { files, treeSha256: computeTreeSha256(files) };
}

export async function loadStopVisualBaseline() {
  return JSON.parse(await readFile(STOP_VISUAL_BASELINE, "utf8"));
}

function resolveRepoRelative(path) {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function safeCopyTarget(root, file, label) {
  if (
    typeof file !== "string" ||
    file.length === 0 ||
    isAbsolute(file) ||
    file.split(/[\\/]/).includes("..") ||
    normalize(file) !== file ||
    normalize(file) === "."
  ) {
    throw stopSourceError("unsafe-target", `${label} must stay inside its stage`, { file });
  }
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, file);
  const rel = relative(resolvedRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw stopSourceError("unsafe-target", `${label} escapes its stage`, {
      file,
      root: resolvedRoot,
      target,
    });
  }
  return target;
}

async function verifyFrozenInputs(baseline) {
  const sourceRoot = resolveRepoRelative(baseline.source.root);
  const source = await scanStopVisualTree(sourceRoot);
  if (
    source.treeSha256 !== baseline.source.treeSha256 ||
    source.files.length !== baseline.source.files
  ) {
    throw stopSourceError("r9-tree-drift", "frozen R9 visual tree does not match its pin", {
      expected: baseline.source.treeSha256,
      actual: source.treeSha256,
      expectedFiles: baseline.source.files,
      actualFiles: source.files.length,
    });
  }

  const overlayRoot = resolveRepoRelative(baseline.overlay.root);
  const overlayPatch = join(overlayRoot, baseline.overlay.patch);
  const overlayHelper = join(overlayRoot, baseline.overlay.helper);
  const overlayHeader = join(overlayRoot, baseline.overlay.header);
  const overlay = {
    root: overlayRoot,
    patch: overlayPatch,
    patchSha256: await sha256File(overlayPatch),
    helper: overlayHelper,
    helperSha256: await sha256File(overlayHelper),
    header: overlayHeader,
    headerSha256: await sha256File(overlayHeader),
  };
  for (const key of ["patchSha256", "helperSha256", "headerSha256"]) {
    const pinKey = key;
    if (overlay[key] !== baseline.overlay[pinKey]) {
      throw stopSourceError(
        "overlay-drift",
        `R11 visual overlay ${key} does not match its pin`,
        { expected: baseline.overlay[pinKey], actual: overlay[key], path: overlay[key === "patchSha256" ? "patch" : key === "helperSha256" ? "helper" : "header"] },
      );
    }
  }
  return { sourceRoot, source, overlay };
}

function overlayApplyError(result, overlayPatch) {
  return stopSourceError("overlay-patch-failed", "R11 visual overlay patch failed", {
    patch: overlayPatch,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export async function prepareStopVisualSource({ profile, outputRoot } = {}) {
  const profileSpec = STOP_VISUAL_PROFILES[profile];
  if (!profileSpec) {
    throw stopSourceError("profile", `unknown stop visual profile: ${profile}`, { profile });
  }
  const root = resolveStopVisualOutputRoot({ profile, outputRoot });
  const baseline = await loadStopVisualBaseline();
  const frozen = await verifyFrozenInputs(baseline);
  const workRoot = join(root, "work", "visual");
  const sourceRoot = join(workRoot, "source");
  const buildRoot = join(root, "build");
  const libRoot = join(root, "lib");
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  await mkdir(libRoot, { recursive: true, mode: 0o755 });
  await cp(frozen.sourceRoot, sourceRoot, { recursive: true, dereference: false });
  const copied = await scanStopVisualTree(sourceRoot);
  if (copied.treeSha256 !== baseline.source.treeSha256) {
    throw stopSourceError("copy-drift", "copied R9 visual tree does not match its pin", {
      expected: baseline.source.treeSha256,
      actual: copied.treeSha256,
    });
  }

  const overlayResult = await run(
    "/usr/bin/patch",
    ["--fuzz=0", "-p1", "-i", frozen.overlay.patch],
    { cwd: sourceRoot, timeoutMs: 60_000 },
  );
  if (overlayResult.code !== 0) throw overlayApplyError(overlayResult, frozen.overlay.patch);
  for (const [file, expectedSha256] of Object.entries(baseline.overlay.postFiles ?? {})) {
    const actualSha256 = await sha256File(join(sourceRoot, file));
    if (actualSha256 !== expectedSha256) {
      throw stopSourceError(
        "overlay-output-drift",
        `overlay output ${file} does not match its pinned after hash`,
        { file, expected: expectedSha256, actual: actualSha256 },
      );
    }
  }
  await copyFile(
    frozen.overlay.helper,
    join(sourceRoot, VISUAL_CRATE, "src/helper_bridge.rs"),
  );

  const derivedPatches = [];
  for (const patch of baseline.patches ?? []) {
    const patchPath = isAbsolute(patch.path)
      ? patch.path
      : resolve(dirname(STOP_VISUAL_BASELINE), patch.path);
    const applied = await applyStopVisualPatch({
      sourceRoot,
      patchPath,
      patchSha256: patch.sha256,
      files: patch.files,
      baselinePath: STOP_VISUAL_BASELINE,
    });
    derivedPatches.push({ id: patch.id, ...applied });
  }
  if (derivedPatches.length === 0) {
    throw stopSourceError("patch-missing", "stop visual baseline pins no derived patch", {});
  }

  const headers = [];
  for (const header of baseline.headers ?? []) {
    const sourcePath = isAbsolute(header.path)
      ? header.path
      : resolve(dirname(STOP_VISUAL_BASELINE), header.path);
    const sourceSha256 = await sha256File(sourcePath);
    if (sourceSha256 !== header.sha256) {
      throw stopSourceError(
        "header-file-mismatch",
        `stop visual header ${header.id} does not match its pin`,
        { expected: header.sha256, actual: sourceSha256, sourcePath },
      );
    }
    const targetPath = safeCopyTarget(root, header.file, "stop visual header");
    await copyFile(sourcePath, targetPath);
    const copiedSha256 = await sha256File(targetPath);
    if (copiedSha256 !== header.sha256) {
      throw stopSourceError(
        "header-copy-mismatch",
        `stop visual header ${header.id} changed while copying`,
        { expected: header.sha256, actual: copiedSha256, targetPath },
      );
    }
    headers.push({ id: header.id, file: header.file, sha256: copiedSha256, targetPath });
  }

  const derived = await scanStopVisualTree(sourceRoot);
  const cancelImplementation = await stopCancelImplementationDigests();
  const report = {
    schemaVersion: 1,
    kind: "zody-cua-desktop-stop-visual-prepare",
    status: "pass",
    generatedAt: new Date().toISOString(),
    outputRoot: root,
    source: {
      root: frozen.sourceRoot,
      treeSha256: frozen.source.treeSha256,
      files: frozen.source.files.length,
    },
    overlay: {
      root: frozen.overlay.root,
      patch: frozen.overlay.patch,
      patchSha256: frozen.overlay.patchSha256,
      helper: frozen.overlay.helper,
      helperSha256: frozen.overlay.helperSha256,
      header: frozen.overlay.header,
      headerSha256: frozen.overlay.headerSha256,
      postFiles: baseline.overlay.postFiles,
    },
    derived: {
      root: sourceRoot,
      treeSha256: derived.treeSha256,
      files: derived.files.length,
    },
    patches: derivedPatches,
    headers,
    cancelImplementation,
    profile: {
      ...profileSpec,
      features: [...profileSpec.cargoFeatures],
    },
    toolchain: baseline.toolchain,
    deploymentTarget: FIXED_DEPLOYMENT_TARGET,
  };
  await writeFile(
    join(buildRoot, "prepare-manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    sourceRoot,
    buildRoot,
    libRoot,
    staticlib: join(libRoot, "libcua_macos_visual_round11.a"),
    header: join(libRoot, "cua_r11_visual.h"),
    prepareManifest: join(buildRoot, "prepare-manifest.json"),
    report,
  };
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
