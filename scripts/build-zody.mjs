#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { stageNodeNotices, readVerifiedNotices } from "./third-party-notices.mjs";
import {
  copyRuntimeNodeModules,
  patchNodePtyPrebuilds,
  stageTuiRuntime,
} from "./zody-distribution/assets.mjs";
import {
  archiveNameForTarget,
  assertDistributionVersion,
  nodeTargetForDistribution,
  parseDistributionArgs,
} from "./zody-distribution/targets.mjs";
import { collectSeaRuntimeToolAssets } from "../apps/zody-cli/packages/cli/scripts/sea-runtime-tool-assets.mjs";
import { resolveDownloadedNodeBinary } from "../apps/zody-cli/packages/cli/scripts/sea-node-download.mjs";
import { outputBinaryName } from "../apps/zody-cli/packages/cli/scripts/sea-targets.mjs";
import { seaBuildSteps } from "./zody-distribution/sea-build-steps.mjs";

const root = resolve(import.meta.dirname, "..");
const defaultOutDir = resolve(root, "dist", "zody");
const packageDirName = "zody";
const bundledNodeVersion = "24.14.0";
const cliRoot = resolve(root, "apps/zody-cli/packages/cli");
const usage = `Usage:
  pnpm run build:zody --all
  node scripts/build-zody.mjs --target darwin-arm64
  node scripts/build-zody.mjs --skip-build --target linux-x64

Options:
  --all               Build all supported CLI/Web targets.
  --target <target>   Build one target.
  --skip-build        Reuse existing Web, server, Agent, and SEA outputs.
  --version <text>    Release version. Defaults to root package.json version.
  --out-dir <path>   Output directory. Defaults to dist/zody.
  --help, -h          Show this help.
`;

const sha256File = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

function run(command, args, options = {}) {
  console.log(`[zody] ${[command, ...args].join(" ")}`);
  runCommand(command, args, { cwd: root, ...options });
}

async function assertFile(file, label) {
  const entry = await stat(file).catch(() => null);
  if (!entry?.isFile()) throw new Error(`Missing ${label}: ${file}`);
}

async function assertDirectory(directory, label) {
  const entry = await stat(directory).catch(() => null);
  if (!entry?.isDirectory()) throw new Error(`Missing ${label}: ${directory}`);
}

async function buildOutputs(skipBuild, targets) {
  if (skipBuild) return;
  for (const target of targets) {
    const [targetPlatform, arch] = target.split("-");
    const platform = targetPlatform === "win32" ? "win32" : targetPlatform;
    run(process.execPath, [
      resolve(root, "scripts/prepare-native-search-tools.mjs"),
      "--platform",
      platform,
      "--arch",
      arch,
    ]);
  }
  run("pnpm", ["--filter", "@zody/cli...", "build"]);
  await rm(resolve(root, "packages/server/dist"), { force: true, recursive: true });
  run("pnpm", ["--filter", "@zody/server", "build"]);
  run("pnpm", ["--filter", "@zody/web", "build"]);
}

function seaBinary(target) {
  return resolve(cliRoot, "dist", outputBinaryName(nodeTargetForDistribution(target)));
}

async function buildSea(target, skipBuild) {
  if (!skipBuild) {
    for (const step of seaBuildSteps({
      cliRoot,
      target,
      nodeExecutable: process.execPath,
    })) {
      run(step.command, step.args);
    }
  }
  const binary = seaBinary(target);
  await assertFile(binary, `SEA CLI for ${target}`);
  return binary;
}

async function stageZodyPackage({
  packageRoot,
  target,
  version,
  nodeCache,
  skipBuild,
  verificationOnly,
  reviewObligationCount,
}) {
  const webDist = resolve(root, "packages/web/dist");
  const serverDist = resolve(root, "packages/server/dist");
  const agentBundle = resolve(cliRoot, "dist/zody.cjs");
  const agentProvider = resolve(cliRoot, "dist/provider");
  await assertDirectory(webDist, "web dist");
  await assertDirectory(serverDist, "server dist");
  await assertDirectory(agentProvider, "Agent provider config");
  for (const [file, label] of [
    [resolve(serverDist, "entry-http.js"), "server HTTP entry"],
    [agentBundle, "Agent bundle"],
    [resolve(agentProvider, "zody-builtin.json"), "Agent provider config"],
  ])
    await assertFile(file, label);

  await rm(packageRoot, { force: true, recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await cp(webDist, resolve(packageRoot, "web"), { recursive: true });
  await cp(serverDist, resolve(packageRoot, "server"), { recursive: true });
  await mkdir(resolve(packageRoot, "agent"), { recursive: true });
  await cp(agentBundle, resolve(packageRoot, "agent/zody.cjs"));
  await cp(agentProvider, resolve(packageRoot, "agent/provider"), { recursive: true });
  await cp(
    resolve(cliRoot, "dist/THIRD-PARTY-NOTICES.md"),
    resolve(packageRoot, "THIRD-PARTY-NOTICES.md"),
  );

  const nodeTarget = nodeTargetForDistribution(target);
  const runtimeNode = await resolveDownloadedNodeBinary({
    nodeCache,
    nodeVersion: bundledNodeVersion,
    target: nodeTarget,
  });
  const nodeName = target.startsWith("win32-") ? "node.exe" : "node";
  await mkdir(resolve(packageRoot, "runtime"), { recursive: true });
  const packagedNode = resolve(packageRoot, "runtime", nodeName);
  await copyFile(runtimeNode, packagedNode);
  await chmod(packagedNode, 0o755);
  await stageNodeNotices(resolve(packageRoot, "licenses"), bundledNodeVersion, root);

  await stageTuiRuntime(packageRoot, nodeTarget);
  await copyRuntimeNodeModules(packageRoot);
  await patchNodePtyPrebuilds(packageRoot, nodeTarget);
  await stageRuntimeTools(packageRoot, nodeTarget);

  const cliTarget = await buildSea(target, skipBuild);
  const cliFileName = target.startsWith("win32-") ? "zody-cli.exe" : "zody-cli";
  await mkdir(resolve(packageRoot, "bin"), { recursive: true });
  const cliDestination = resolve(packageRoot, "bin", cliFileName);
  await copyFile(cliTarget, cliDestination);
  await chmod(cliDestination, 0o755);
  await cp(
    resolve(root, "scripts/zody-distribution/runner.mjs"),
    resolve(packageRoot, "bin/zody.mjs"),
  );
  await writeFile(
    resolve(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: "zody-runtime",
        private: true,
        type: "module",
        version,
        target,
        nodeVersion: bundledNodeVersion,
        verificationOnly,
        reviewObligationCount,
      },
      null,
      2,
    ),
  );
  await writeLaunchers(packageRoot, target);
}

async function stageRuntimeTools(packageRoot, target) {
  const stagingDirectory = resolve(packageRoot, ".runtime-tool-staging");
  const { assets, manifest } = await collectSeaRuntimeToolAssets({
    root,
    stagingDirectory,
    target,
  });
  const toolRoot = resolve(packageRoot, "runtime-tools");
  await mkdir(toolRoot, { recursive: true });
  await cp(
    assets["zody-runtime-tools/THIRD-PARTY-NOTICES.txt"],
    resolve(toolRoot, "THIRD-PARTY-NOTICES.txt"),
  );
  await cp(assets["zody-runtime-tools/SOURCES.json"], resolve(toolRoot, "SOURCES.json"));
  for (const tool of manifest.tools) {
    const assetKey = Object.keys(assets).find((key) =>
      key.endsWith(`/${tool.sha256}/${tool.binaryName}`),
    );
    if (!assetKey) throw new Error(`Missing staged native runtime tool ${tool.id} for ${target}`);
    const destination = resolve(toolRoot, tool.id, tool.binaryName);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(assets[assetKey], destination);
    await chmod(destination, 0o755);
  }
  await writeFile(resolve(toolRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  await rm(stagingDirectory, { force: true, recursive: true });
}

async function writeLaunchers(packageRoot, target) {
  const binDir = resolve(packageRoot, "bin");
  if (target.startsWith("win32-")) {
    await writeFile(
      resolve(binDir, "zody.cmd"),
      '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0zody.mjs" %*\r\n',
    );
    return;
  }
  const launcher = resolve(binDir, "zody");
  await writeFile(
    launcher,
    '#!/usr/bin/env sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/../runtime/node" "$HERE/zody.mjs" "$@"\n',
  );
  await chmod(launcher, 0o755);
}

async function createArchive({ packageParent, releaseDir, target, version }) {
  await mkdir(releaseDir, { recursive: true });
  const name = archiveNameForTarget(target, version);
  const archive = resolve(releaseDir, name);
  await rm(archive, { force: true });
  run("tar", ["-czf", archive, "-C", packageParent, packageDirName]);
  const hash = await sha256File(archive);
  await writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
  return { archive, hash, name };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDistributionArgs(argv);
  if (options.help) {
    console.log(usage);
    return;
  }
  await readVerifiedNotices(root);
  const inventory = JSON.parse(await readFile(resolve(root, "third-party/inventory.json"), "utf8"));
  const reviewObligationCount = Array.isArray(inventory.reviewRequired)
    ? inventory.reviewRequired.length
    : 0;
  const verificationOnly = reviewObligationCount > 0;
  if (verificationOnly) {
    console.warn(
      `[zody] verification-only candidate: ${reviewObligationCount} third-party material obligations remain unresolved`,
    );
  }
  if (process.versions.node !== bundledNodeVersion) {
    throw new Error(
      `Build with Node ${bundledNodeVersion}; current Node is ${process.versions.node}.`,
    );
  }
  const rootPackage = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = assertDistributionVersion(options.version ?? rootPackage.version);
  const outDir = options.outDir ?? defaultOutDir;
  const releaseDir = resolve(outDir, "releases", version);
  const workDir = resolve(outDir, ".work");
  const nodeCache = resolve(outDir, ".node-cache");
  await rm(releaseDir, { force: true, recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await buildOutputs(options.skipBuild, options.targets);
  const checksums = [];
  for (const target of options.targets) {
    const packageParent = resolve(workDir, target);
    const packageRoot = resolve(packageParent, packageDirName);
    await rm(packageParent, { force: true, recursive: true });
    await stageZodyPackage({
      packageRoot,
      target,
      version,
      nodeCache,
      skipBuild: options.skipBuild,
      verificationOnly,
      reviewObligationCount,
    });
    const result = await createArchive({ packageParent, releaseDir, target, version });
    checksums.push(`${result.hash}  ${result.name}`);
    console.log(`[zody] ${target}: ${result.archive}`);
  }
  await writeFile(resolve(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);
  await rm(workDir, { force: true, recursive: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
