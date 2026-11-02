import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ClosureBlockedError,
  ClosureVerificationError,
  isSafeExternalMemberPath,
} from "./cua-driver-closure-core.mjs";
import { probeToolchain } from "./cua-helper-diagnostic-toolchain.mjs";
import {
  baseClosureEnvironment,
  copyTreeSafe,
  findAncestorCargoConfigs,
  runClosureCommand,
} from "./cua-driver-closure-command.mjs";
import { auditRegistryCache, verifyExternalMember } from "./cua-driver-closure-cache.mjs";
import { assertTargetArchiveCoverage } from "./cua-driver-closure-cache-rebuild.mjs";
import { runDriverBuild } from "./cua-driver-closure-prepare.mjs";

export { auditRegistryCache } from "./cua-driver-closure-cache.mjs";

const PYTHON_TOML = [
  "import json, sys, tomllib",
  "with open(sys.argv[1], 'rb') as handle:",
  "    value = tomllib.load(handle)",
  "print(json.dumps(value, sort_keys=True))",
].join("\n");

export async function readTomlJson(path) {
  const result = await runClosureCommand("python3", ["-c", PYTHON_TOML, path], {
    env: baseClosureEnvironment(),
    timeoutMs: 15_000,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ClosureVerificationError("Python tomllib returned invalid JSON");
  }
}

export function parseCargoTree(text) {
  const byPackage = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const deduplicated = line.trimEnd().endsWith("(*)");
    const normalizedLine = deduplicated ? line.trimEnd().slice(0, -4).trimEnd() : line.trim();
    const [left, featureText = ""] = normalizedLine.split("|", 2);
    const match = /^(.+?) v([^\s]+)(?: \(([^)]*)\))?$/.exec(left);
    if (!match) throw new ClosureVerificationError(`unrecognized cargo tree line: ${line.trim()}`);
    const [, name, version, location = ""] = match;
    const key = `${name}@${version}\0${location}`;
    if (deduplicated) {
      if (!byPackage.has(key)) {
        throw new ClosureVerificationError(
          `cargo tree deduplication references an unknown package: ${name}@${version}`,
        );
      }
      continue;
    }
    const existing = byPackage.get(key) ?? {
      name,
      version,
      path: null,
      kind: null,
      features: new Set(),
    };
    if (location === "proc-macro") existing.kind = "proc-macro";
    else if (location) existing.path = location;
    for (const feature of featureText.split(",").map((value) => value.trim())) {
      if (feature) existing.features.add(feature);
    }
    byPackage.set(key, existing);
  }
  const packages = [...byPackage.values()]
    .map((entry) => ({ ...entry, features: [...entry.features].sort() }))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  if (packages.length === 0)
    throw new ClosureVerificationError("cargo tree did not contain a package graph");
  return { packages };
}

export function assertCargoTreeRoot(parsed, packageName) {
  const roots = parsed.packages.filter((entry) => entry.name === packageName);
  if (roots.length !== 1 || !roots[0].path) {
    throw new ClosureVerificationError(`cargo tree root is missing or ambiguous: ${packageName}`);
  }
  return roots[0];
}

export function assertUniqueGraphPackages(parsed) {
  const identities = new Set();
  for (const entry of parsed.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (identities.has(identity)) {
      throw new ClosureVerificationError(`ambiguous package identity in cargo tree: ${identity}`);
    }
    identities.add(identity);
  }
}

export function toolchainDelta({ upstreamDeclared, auditedVersion, auditedCommit = null }) {
  const exactMatch = upstreamDeclared === auditedVersion;
  return {
    upstreamDeclared,
    auditedVersion,
    auditedCommit,
    exactMatch,
    status: exactMatch ? "pass" : "blocked",
    reason: exactMatch
      ? "audited toolchain matches the upstream declaration"
      : "audited toolchain differs from the upstream declaration; no closure claim is made",
  };
}

export function toolchainDeltaFromProbe({ upstreamDeclared, toolchain }) {
  return toolchainDelta({
    upstreamDeclared,
    auditedVersion: toolchain?.rustc?.version ?? "unavailable",
    auditedCommit: toolchain?.rustc?.commit ?? null,
  });
}

async function assertMissingCargoConfig(path) {
  try {
    await lstat(path);
    throw new ClosureVerificationError(`Cargo configuration injection is not allowed: ${path}`);
  } catch (error) {
    if (error instanceof ClosureVerificationError) throw error;
    if (error?.code !== "ENOENT") {
      throw new ClosureVerificationError(`cannot inspect Cargo configuration: ${path}`);
    }
  }
}

async function prepareWorkspace({ candidateRoot, cargoHome, externalMembers, tempRoot }) {
  const candidate = await realpath(candidateRoot);
  const cache = await realpath(cargoHome);
  const candidateName = basename(candidate);
  if (candidateName !== "full-source") {
    throw new ClosureVerificationError("candidate root must be the frozen full-source directory");
  }
  const sourceCopy = join(tempRoot, candidateName);
  const cargoHomeCopy = join(tempRoot, "cargo-home");
  await copyTreeSafe(candidate, sourceCopy);
  await copyTreeSafe(join(cache, "registry"), join(cargoHomeCopy, "registry"));
  const externalEvidence = [];
  for (const member of externalMembers ?? []) {
    if (!isSafeExternalMemberPath(member.path)) {
      throw new ClosureVerificationError("invalid external workspace member path");
    }
    const relativeMember = member.path.slice(3);
    const source = join(dirname(candidate), relativeMember);
    const destination = join(tempRoot, relativeMember);
    await copyTreeSafe(source, destination);
    const evidence = await verifyExternalMember({
      root: destination,
      expectedFiles: member.expectedFiles,
      manifestSha256: member.manifestSha256,
      treeSha256: member.treeSha256,
    });
    externalEvidence.push({ path: member.path, ...evidence });
  }
  for (const path of [
    join(cargoHomeCopy, "config.toml"),
    join(cargoHomeCopy, "config"),
    ...(await findAncestorCargoConfigs(sourceCopy)),
  ]) {
    await assertMissingCargoConfig(path);
  }
  return { sourceCopy, cargoHomeCopy, externalEvidence };
}

function cargoEnvironment(toolchain, cargoHome) {
  const environment = baseClosureEnvironment();
  environment.PATH = `${join(toolchain.sysroot, "bin")}:${environment.PATH}`;
  if (typeof toolchain.selected === "string") environment.RUSTUP_TOOLCHAIN = toolchain.selected;
  environment.RUSTUP_AUTO_INSTALL = "0";
  environment.CARGO_HOME = cargoHome;
  environment.CARGO_NET_OFFLINE = "true";
  environment.CARGO_TERM_COLOR = "never";
  environment.CARGO_INCREMENTAL = "0";
  return environment;
}

export function canExecuteBuild(registry, targetGraph) {
  return registry?.status === "pass" && targetGraph?.status === "pass";
}

export async function auditLockedCargoGraph({
  candidateRoot,
  cargoHome,
  externalMembers,
  packageName,
  target,
  tempRoot,
  toolchain: explicitToolchain,
  lockPackages,
  reconstructedKeys,
  build,
}) {
  let toolchain = explicitToolchain;
  if (!toolchain) {
    try {
      toolchain = await probeToolchain({ selected: "stable" });
    } catch (error) {
      throw new ClosureBlockedError("toolchain-unavailable", error.message);
    }
  }
  const workspace = await prepareWorkspace({ candidateRoot, cargoHome, externalMembers, tempRoot });
  const env = cargoEnvironment(toolchain, workspace.cargoHomeCopy);
  const commandOptions = {
    cwd: workspace.sourceCopy,
    env,
    timeoutMs: 60_000,
    maxOutputBytes: 64 * 1024 * 1024,
  };
  const metadata = await runClosureCommand(
    toolchain.cargoPath,
    ["metadata", "--no-deps", "--locked", "--offline", "--format-version", "1"],
    commandOptions,
  );
  const tree = await runClosureCommand(
    toolchain.cargoPath,
    [
      "tree",
      "--locked",
      "--offline",
      "--target",
      target,
      "--package",
      packageName,
      "--edges",
      "normal,build",
      "--prefix",
      "none",
      "--format",
      "{p}|{f}",
    ],
    commandOptions,
  );
  const parsedMetadata = JSON.parse(metadata.stdout);
  const parsedTree = parseCargoTree(tree.stdout);
  assertUniqueGraphPackages(parsedTree);
  const rootPackage = assertCargoTreeRoot(parsedTree, packageName);
  const lock = await readTomlJson(join(workspace.sourceCopy, "Cargo.lock"));
  let targetGraph;
  try {
    targetGraph = reconstructedKeys
      ? assertTargetArchiveCoverage({
          graph: parsedTree.packages,
          lockPackages: lockPackages ?? lock.package,
          reconstructedKeys,
        })
      : { status: "pass", mode: "legacy-cache-copy" };
  } catch (error) {
    targetGraph = {
      status: "blocked",
      error: { code: error.code ?? "target-graph-failed", message: error.message },
    };
  }
  let registry;
  try {
    registry = await auditRegistryCache({
      graph: parsedTree.packages,
      lockPackages: lock.package,
      cargoHome: workspace.cargoHomeCopy,
      workRoot: tempRoot,
    });
  } catch (error) {
    registry = {
      status: error instanceof ClosureBlockedError ? "blocked" : "fail",
      error: {
        code: error.code ?? "cache-verification-failed",
        message: error.message,
      },
      checked: 0,
      packages: [],
    };
  }
  let buildResult = null;
  if (build) {
    const mode = build.mode === "build" ? "build-library" : "check-build";
    // 依赖门未同时通过时绝不执行编译，避免用未闭合或漂移的 cache 生成产物。
    if (!canExecuteBuild(registry, targetGraph)) {
      buildResult = {
        status: "blocked",
        mode,
        error: {
          code: "dependency-gate-blocked",
          message:
            "compilation requires both reconstructed registry cache and target graph to pass",
        },
        executedUpstreamApplication: false,
        executedTests: false,
      };
    } else {
      try {
        buildResult = await runDriverBuild({
          toolchain,
          sourceRoot: workspace.sourceCopy,
          cargoHome: workspace.cargoHomeCopy,
          tempRoot,
          mode: build.mode,
          target,
          packageName,
          packageVersion: rootPackage.version,
          logPath: build.logPath,
        });
      } catch (error) {
        buildResult = {
          status: "blocked",
          mode,
          error: { code: error.code ?? "build-failed", message: error.message },
          executedUpstreamApplication: false,
          executedTests: false,
        };
      }
    }
  }
  const dependencyStatus =
    registry.status === "pass" && targetGraph.status === "pass" ? "pass" : "blocked";
  return {
    status: dependencyStatus,
    targetGraph,
    build: buildResult,
    toolchain: {
      rustc: toolchain.rustc,
      cargo: toolchain.cargo,
      sysroot: toolchain.sysroot,
    },
    workspace: {
      sourceCopy: workspace.sourceCopy,
      cargoHomeCopy: workspace.cargoHomeCopy,
      cargoConfigIsolation: true,
      externalMembers: workspace.externalEvidence,
    },
    metadata: {
      workspaceMembers: parsedMetadata.workspace_members,
      packages: parsedMetadata.packages.map((entry) => ({
        name: entry.name,
        version: entry.version,
        license: entry.license,
        manifestPath: entry.manifest_path,
        targets: entry.targets.map((targetEntry) => ({
          name: targetEntry.name,
          kinds: targetEntry.kind,
        })),
      })),
    },
    lock: {
      entryCount: lock.package.length,
      checksumEntries: lock.package.filter((entry) => typeof entry.checksum === "string").length,
      packages: lock.package,
    },
    graph: {
      target,
      package: packageName,
      packageCount: parsedTree.packages.length,
      root: `${rootPackage.name}@${rootPackage.version}`,
      packages: parsedTree.packages,
    },
    registry,
  };
}

export function deriveClosureGates(parts) {
  const sourceStatus = parts.source?.status ?? "blocked";
  const requiredGates = ["dependencies", "licenses", "toolchain"];
  const verificationFailed = Object.values(parts).some((value) => value?.status === "fail");
  const evidenceComplete =
    sourceStatus === "pass" && requiredGates.every((name) => parts[name]?.status === "pass");
  return {
    source: sourceStatus,
    dependencies: parts.dependencies?.status ?? "blocked",
    licenses: parts.licenses?.status ?? "blocked",
    toolchain: parts.toolchain?.status ?? "blocked",
    build: parts.build?.status ?? "not-requested",
    sourceAuditComplete: sourceStatus === "pass",
    evidenceComplete,
    productAdoption: "blocked",
    productAdoptionReason:
      "closure audit never authorizes product adoption; native, signing, TCC and runtime evidence remain separate gates",
    verificationFailed,
    exitCode: sourceStatus === "pass" && !verificationFailed ? 0 : 1,
  };
}
