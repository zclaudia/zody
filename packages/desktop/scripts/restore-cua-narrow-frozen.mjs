#!/usr/bin/env node
// 从窄 CUA 冻结归档还原默认装配材料，并立即用当前 pin 复核。
// 归档内容只是字节搬运；信任判定始终来自 validateNarrowManifest/codesign 与
// macos-cua-demo-defaults 的固定 pin，本脚本不新建任何信任根。
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants as fsConstants, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  CUA_DEMO_DEFAULT_PUBLIC_FACTS,
  resolveMacosCuaDemoBuildSelection,
} from "./macos-cua-demo-defaults.mjs";
import { REPO_ROOT } from "./macos-cua-narrow-resources-constants.mjs";

const execFile = (command, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFileCallback(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

export class NarrowFrozenRestoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NarrowFrozenRestoreError";
    this.code = code;
    this.details = details;
  }
}

export function parseSha256File(text) {
  const match = String(text).match(/([0-9a-f]{64})/i);
  if (!match) {
    throw new NarrowFrozenRestoreError(
      "restore-sha-file-invalid",
      "sha256 sidecar does not contain a 64-hex digest",
    );
  }
  return match[1].toLowerCase();
}

// 归档只允许携带仓库相对 output/ 前缀的普通路径，拒绝绝对路径、.. 逃逸与设备节点。
export function assertSafeTarEntries(entryNames) {
  const unsafe = [];
  for (const raw of entryNames) {
    const name = raw.replace(/\/$/, "");
    if (
      !name ||
      isAbsolute(name) ||
      name.split(/[\\/]/).some((part) => part === "..") ||
      name.split(/[\\/]/).some((part) => part === "." && name !== ".") ||
      !(name === "output" || name.startsWith(`output${sep}`) || name.startsWith("output/"))
    ) {
      unsafe.push(raw);
    }
  }
  if (unsafe.length > 0) {
    throw new NarrowFrozenRestoreError(
      "restore-archive-path-unsafe",
      "archive contains entries outside the repo output/ tree",
      { entries: unsafe.slice(0, 8) },
    );
  }
  return true;
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function restoreCuaNarrowFrozen({
  archivePath,
  expectedSha256 = null,
  repoRoot = REPO_ROOT,
  force = false,
  targetOs = "darwin",
  targetArch = "arm64",
  deps = {},
}) {
  if (process.platform !== "darwin") {
    throw new NarrowFrozenRestoreError(
      "restore-platform-unsupported",
      "frozen narrow materials only restore onto darwin build machines",
    );
  }
  const absoluteArchive = resolve(archivePath);
  let archiveInfo;
  try {
    archiveInfo = await stat(absoluteArchive);
  } catch (error) {
    throw new NarrowFrozenRestoreError(
      "restore-archive-missing",
      `archive is unreadable: ${absoluteArchive}`,
      { cause: error?.code },
    );
  }
  if (!archiveInfo.isFile()) {
    throw new NarrowFrozenRestoreError("restore-archive-missing", `archive is not a file: ${absoluteArchive}`);
  }
  let expected = typeof expectedSha256 === "string" && expectedSha256.trim()
    ? expectedSha256.trim().toLowerCase()
    : null;
  if (!expected) {
    try {
      expected = parseSha256File(await readFile(`${absoluteArchive}.sha256`, "utf8"));
    } catch {
      throw new NarrowFrozenRestoreError(
        "restore-sha-required",
        "pass --sha256 or provide a <archive>.sha256 sidecar",
      );
    }
  }
  const observed = await sha256File(absoluteArchive);
  if (observed !== expected) {
    throw new NarrowFrozenRestoreError(
      "restore-archive-sha-mismatch",
      "archive bytes do not match the expected sha256",
      { observed, expected },
    );
  }

  const absoluteRepoRoot = resolve(repoRoot ?? REPO_ROOT);
  const manifestDestination = resolve(
    absoluteRepoRoot,
    CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath,
  );
  if (!force && (await access(manifestDestination, fsConstants.F_OK).then(() => true).catch(() => false))) {
    throw new NarrowFrozenRestoreError(
      "restore-destination-exists",
      `pinned manifest already exists at ${manifestDestination}; pass --force to overwrite`,
    );
  }

  const list = await (deps.execFile ?? execFile)("tar", ["-tzf", absoluteArchive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  assertSafeTarEntries(
    list.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
  );
  await (deps.execFile ?? execFile)("tar", ["-xzf", absoluteArchive, "-C", absoluteRepoRoot]);

  // 还原后立即走默认选择解析：pin、manifest 树、codesign 身份全部复验，
  // 通过才算还原成功；不通过即报错，不留下"看似还原"的状态。
  const selection = await resolveMacosCuaDemoBuildSelection({
    targetOs,
    targetArch,
    repoRoot: absoluteRepoRoot,
  });
  if (!selection || selection.source !== "default") {
    throw new NarrowFrozenRestoreError(
      "restore-verification-failed",
      "default darwin/arm64 build selection did not resolve after restore",
    );
  }
  return {
    archivePath: absoluteArchive,
    archiveSha256: observed,
    manifestPath: selection.manifestPath,
    manifestSha256: selection.manifestSha256,
    launcherSha256: selection.launcherSha256,
    stageAppPath: selection.validated.stageAppPath,
  };
}

function parseArgs(argv) {
  const options = { force: false, expectedSha256: null, archivePath: null, repoRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      const arg = argv[index + 1];
      if (!arg) throw new Error(`${value} requires a value`);
      index += 1;
      return arg;
    };
    if (value === "--archive") options.archivePath = next();
    else if (value === "--sha256") options.expectedSha256 = next();
    else if (value === "--repo-root") options.repoRoot = resolve(next());
    else if (value === "--force") options.force = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.archivePath) throw new Error("--archive is required");
  return options;
}

const USAGE = `Usage:
  node packages/desktop/scripts/restore-cua-narrow-frozen.mjs --archive <narrow-frozen tar.gz> [--sha256 <hex>] [--repo-root <dir>] [--force]

Restores the pinned cua-narrow frozen materials (prepared manifest + stage app +
startup snapshot) from a verified archive, then re-runs the default darwin/arm64
build selection so the restored bytes are proven against the current pins.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "fail", message: error.message })}\n`);
    process.exit(1);
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  try {
    const result = await restoreCuaNarrowFrozen(options);
    process.stdout.write(`${JSON.stringify({ status: "pass", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "fail", code: error.code, message: error?.message ?? String(error), details: error.details })}\n`,
    );
    process.exit(1);
  }
}
