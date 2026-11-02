// Reproducible source evidence for the normal utility Host candidate rebuild.
// Metafiles keep esbuild's original build paths; the input index adds repo-relative
// source paths and hashes so a frozen checkout can be compared without trusting labels.
// esbuild <define:NAME> inputs are generated expressions, not files: only their name,
// exact supplied expression SHA-256, and byte count are archived.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { NarrowResourceError } from "../macos-cua-narrow-resources-base.mjs";
import { DESKTOP_ROOT } from "./cua-desktop-candidate-app-config.mjs";
import { REPO_ROOT } from "./cua-desktop-session-config.mjs";
import { staleWorkspaceDistInputs } from "./cua-desktop-session-workspace-source.mjs";

const BUILD_NAMES = ["main", "host", "scheduler"];
const DEFINE_INPUT_PATTERN = /^<define:([^<>]+)>$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseDefineInput(inputPath) {
  if (!inputPath.startsWith("<")) return null;
  const match = DEFINE_INPUT_PATTERN.exec(inputPath);
  if (!match) {
    throw new NarrowResourceError(
      "candidate-evidence-unknown-virtual-input",
      `candidate build contains an unsupported virtual input: ${inputPath}`,
      { inputPath },
    );
  }
  return match[1];
}

function suppliedDefineExpression(defines, name) {
  if (!defines || typeof defines !== "object" || Array.isArray(defines)) return null;
  if (!Object.prototype.hasOwnProperty.call(defines, name)) return null;
  return typeof defines[name] === "string" ? defines[name] : null;
}

function defineInputEvidence(inputPath, name, defines) {
  const expression = suppliedDefineExpression(defines, name);
  if (expression === null) {
    throw new NarrowResourceError(
      "candidate-evidence-unresolved-define",
      `candidate build input has no exact supplied define expression: ${name}`,
      { name },
    );
  }
  const expressionBytes = Buffer.from(expression, "utf8");
  return {
    path: inputPath,
    kind: "esbuild-define",
    name,
    bytes: expressionBytes.length,
    sha256: sha256(expressionBytes),
  };
}

async function inputEvidence({ build, inputPath, buildRoot, repoRoot }) {
  const defineName = parseDefineInput(inputPath);
  if (defineName !== null) return defineInputEvidence(inputPath, defineName, build.defines);
  const resolved = repoRelativeInputPath(inputPath, { buildRoot, repoRoot });
  const bytes = await readFile(resolved.absolutePath);
  return {
    path: resolved.path,
    buildPath: resolved.absolutePath,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function repoRelativeInputPath(inputPath, { buildRoot, repoRoot }) {
  const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(buildRoot, inputPath);
  const repoRelativePath = relative(repoRoot, absolutePath);
  if (
    !repoRelativePath ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(repoRelativePath)
  ) {
    throw new NarrowResourceError(
      "candidate-evidence-input-path",
      `candidate build input must stay inside the repository: ${inputPath}`,
    );
  }
  return { absolutePath, path: repoRelativePath.split(sep).join("/") };
}

function assertBuildSet(builds) {
  if (!Array.isArray(builds) || builds.length !== BUILD_NAMES.length) {
    throw new NarrowResourceError(
      "candidate-evidence-build-set",
      `build evidence requires exactly ${BUILD_NAMES.join(", ")}`,
    );
  }
  const names = new Set();
  for (const build of builds) {
    if (!BUILD_NAMES.includes(build?.name) || names.has(build.name)) {
      throw new NarrowResourceError(
        "candidate-evidence-build-set",
        `unexpected or duplicate build evidence entry: ${build?.name ?? "missing"}`,
      );
    }
    if (!build.metafile || typeof build.metafile !== "object") {
      throw new NarrowResourceError(
        "candidate-evidence-metafile",
        `build ${build.name} is missing an esbuild metafile`,
      );
    }
    names.add(build.name);
  }
  for (const name of BUILD_NAMES) {
    if (!names.has(name)) {
      throw new NarrowResourceError(
        "candidate-evidence-build-set",
        `build evidence is missing ${name}`,
      );
    }
  }
}

function staleInputsForBuild(build, buildRoot) {
  const normalizedInputs = {};
  for (const inputPath of Object.keys(build.metafile.inputs ?? {})) {
    if (inputPath.startsWith("<")) continue;
    const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(buildRoot, inputPath);
    normalizedInputs[absolutePath] = build.metafile.inputs[inputPath];
  }
  return staleWorkspaceDistInputs({ inputs: normalizedInputs });
}

export async function writeNormalHostBuildEvidence({
  evidenceDir,
  builds,
  buildRoot = DESKTOP_ROOT,
  repoRoot = REPO_ROOT,
}) {
  assertBuildSet(builds);
  const staleInputs = builds.flatMap((build) =>
    staleInputsForBuild(build, buildRoot).map((input) => ({ build: build.name, input })),
  );
  if (staleInputs.length > 0) {
    throw new NarrowResourceError(
      "candidate-stale-workspace-dist",
      "candidate build still resolves workspace dist inputs",
      { inputs: staleInputs.slice(0, 32) },
    );
  }

  await mkdir(evidenceDir, { recursive: true });
  const entryEvidence = {};
  const allInputs = new Map();
  for (const build of BUILD_NAMES.map((name) => builds.find((entry) => entry.name === name))) {
    const metafileBytes = Buffer.from(`${JSON.stringify(build.metafile, null, 2)}\n`);
    const metafilePath = resolve(evidenceDir, `${build.name}.metafile.json`);
    await writeFile(metafilePath, metafileBytes, { mode: 0o600 });
    const inputs = [];
    for (const inputPath of Object.keys(build.metafile.inputs ?? {}).sort()) {
      const input = await inputEvidence({ build, inputPath, buildRoot, repoRoot });
      inputs.push(input);
      const existing = allInputs.get(input.path);
      if (existing && existing.sha256 !== input.sha256) {
        throw new NarrowResourceError(
          "candidate-evidence-input-conflict",
          `candidate build read different bytes for ${input.path}`,
        );
      }
      if (existing) {
        existing.builds.add(build.name);
      } else {
        allInputs.set(input.path, { ...input, builds: new Set([build.name]) });
      }
    }
    entryEvidence[build.name] = {
      metafile: `${build.name}.metafile.json`,
      metafileSha256: sha256(metafileBytes),
      inputs,
    };
  }

  const inputs = [...allInputs.values()]
    .map(({ builds: inputBuilds, ...input }) => ({ ...input, builds: [...inputBuilds].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const index = {
    schemaVersion: 1,
    kind: "zody-normal-host-candidate-build-evidence",
    generatedAt: new Date().toISOString(),
    buildRoot,
    repoRoot,
    builds: entryEvidence,
    inputs,
  };
  const inputsBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  const inputsPath = resolve(evidenceDir, "inputs.json");
  await writeFile(inputsPath, inputsBytes, { mode: 0o600 });
  return {
    directory: evidenceDir,
    inputsPath,
    inputsSha256: sha256(inputsBytes),
    builds: entryEvidence,
  };
}
