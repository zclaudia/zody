import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildCandidateManifest,
  computeTreeSha256,
  scanTree,
} from "../../scripts/lib/cua-driver-round7-prepare-source.mjs";

export const REVISION = "2d2f99228d4d2508dc6fcc84c176b296e146714a";
export const SOURCE_ROOT = "libs/cua-driver/rust";

export function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

const baseFiles = {
  "Cargo.toml": `[workspace]\nresolver = "2"\nmembers = ["crates/cua-driver-core", "crates/cua-driver-sdk", "crates/platform-macos"]\n\n[workspace.package]\nversion = "0.37.0"\n`,
  "Cargo.lock": `version = 4\n\n[[package]]\nname = "cua-driver-core"\nversion = "0.37.0"\n`,
  "crates/cua-driver-core/Cargo.toml": `[package]\nname = "cua-driver-core"\nversion = "0.37.0"\n`,
  "crates/cua-driver-core/src/lib.rs": "pub fn observe() {}\n",
  "crates/cua-driver-sdk/Cargo.toml": `[package]\nname = "cua-driver-sdk"\nversion = "0.37.0"\n\n[dependencies]\ncua-driver-core = { path = "../cua-driver-core" }\n`,
  "crates/platform-macos/Cargo.toml": `[package]\nname = "platform-macos"\nversion = "0.37.0"\n\n[features]\ndefault = ["zody-dev-no-input", "zody-strict-frame-gate"]\nzody-dev-no-input = []\nzody-strict-frame-gate = []\n`,
  "crates/platform-macos/src/lib.rs": "pub fn old_capture() {}\n",
  "notes/old.txt": "preserve round 7 bytes\n",
};

const visualCargo = `[package]\nname = "cua-macos-visual"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nobjc2 = "0.6"\n`;
const visualLib = `pub fn request_capture() -> Result<(), &'static str> {\n    Err("HostNotApproved")\n}\n`;

function candidateFiles(base) {
  return {
    ...base,
    "Cargo.toml": base["Cargo.toml"].replace(
      'members = ["crates/cua-driver-core", "crates/cua-driver-sdk", "crates/platform-macos"]',
      'members = ["crates/cua-driver-core", "crates/cua-driver-sdk", "crates/platform-macos", "crates/cua-macos-visual"]',
    ),
    "Cargo.lock": `${base["Cargo.lock"]}\n[[package]]\nname = "cua-macos-visual"\nversion = "0.1.0"\n`,
    "crates/cua-macos-visual/Cargo.toml": visualCargo,
    "crates/cua-macos-visual/src/lib.rs": visualLib,
  };
}

async function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function textLines(text) {
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function modifyPatch(path, before, after) {
  const oldLines = textLines(before);
  const newLines = textLines(after);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ];
}

function addPatch(path, contents) {
  const lines = textLines(contents);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
}

export async function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return { text, sha256: sha(text) };
}

export async function snapshotTree(root) {
  const scanned = await scanTree(root);
  return Object.fromEntries(scanned.files.map((file) => [file.path, file.sha256]));
}

export async function createRound8PrepareFixture(root) {
  const base = join(root, "base");
  const expected = join(root, "expected");
  const work = join(root, "candidate-work");
  await mkdir(work);
  const nextFiles = candidateFiles(baseFiles);
  await writeTree(base, baseFiles);
  await writeTree(expected, nextFiles);

  const baseFilesManifest = (await scanTree(base)).files.map((file) => {
    if (file.path === "crates/platform-macos/Cargo.toml") {
      return {
        path: file.path,
        status: "modified",
        upstreamSha256: sha("round 7 upstream platform"),
        candidateSha256: file.sha256,
      };
    }
    if (file.path === "Cargo.toml" || file.path === "Cargo.lock") {
      return { path: file.path, status: "added", candidateSha256: file.sha256 };
    }
    return {
      path: file.path,
      status: "unchanged",
      upstreamSha256: file.sha256,
      candidateSha256: file.sha256,
    };
  });
  const baseManifest = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-source-manifest",
    revision: REVISION,
    sourceRoot: SOURCE_ROOT,
    treeSha256: computeTreeSha256(baseFilesManifest),
    files: baseFilesManifest,
  };
  const candidateManifest = await buildCandidateManifest({
    baseManifest,
    candidateRoot: expected,
  });
  const baseManifestPath = join(root, "base-manifest.json");
  const sourceManifestPath = join(root, "source-manifest.json");
  const baseManifestWrite = await writeJson(baseManifestPath, baseManifest);
  const sourceManifestWrite = await writeJson(sourceManifestPath, candidateManifest);

  const changed = Object.keys(nextFiles).filter((path) => path in baseFiles);
  const added = Object.keys(nextFiles).filter((path) => !(path in baseFiles));
  const patchText = [
    ...changed.map((path) => modifyPatch(path, baseFiles[path], nextFiles[path])),
    ...added.map((path) => addPatch(path, nextFiles[path])),
  ]
    .flat()
    .join("\n")
    .concat("\n");
  const patchPath = join(root, "candidate-source.patch");
  await writeFile(patchPath, patchText);
  const config = {
    schemaVersion: 1,
    kind: "zody-cua-driver-closure-review",
    revision: REVISION,
    sourceRoot: SOURCE_ROOT,
    baseSourceManifest: "base-manifest.json",
    sourceManifest: "source-manifest.json",
    baseSourceManifestSha256: baseManifestWrite.sha256,
    candidateSourceManifestSha256: sourceManifestWrite.sha256,
    candidatePatch: {
      path: "candidate-source.patch",
      sha256: sha(patchText),
      bytes: Buffer.byteLength(patchText),
    },
    baseTreeSha256: baseManifest.treeSha256,
    candidateTreeSha256: candidateManifest.treeSha256,
  };
  const reviewConfigPath = join(root, "review-config.json");
  await writeJson(reviewConfigPath, config);
  return {
    root,
    base,
    expected,
    work,
    output: join(work, "full-source"),
    baseManifest,
    candidateManifest,
    config,
    baseManifestPath,
    sourceManifestPath,
    patchPath,
    reviewConfigPath,
  };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
