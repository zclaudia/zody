#!/usr/bin/env node
// 按 build/cua-narrow-frozen.json 的 pin 获取冻结归档并还原默认装配材料。
// 下载优先用 gh release download（私有 release 由 GH_TOKEN/GITHUB_TOKEN 授权）；
// ZODY_CUA_NARROW_FROZEN_ARCHIVE 指向本地归档时跳过下载。归档 sha 与 manifest sha
// 双重校验后交给 restore-cua-narrow-frozen（还原后仍会按当前 pin 复验），本脚本
// 不新建信任根、不做网络回退源。
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants as fsConstants, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { restoreCuaNarrowFrozen } from "./restore-cua-narrow-frozen.mjs";

const PIN_FILE_PATH = resolve(import.meta.dirname, "../build/cua-narrow-frozen.json");

export class FetchFrozenError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "FetchFrozenError";
    this.code = code;
    this.details = details;
  }
}

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

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseFrozenPinFile(raw) {
  let pin;
  try {
    pin = JSON.parse(raw);
  } catch (error) {
    throw new FetchFrozenError(
      "frozen-pin-json",
      `cua-narrow-frozen.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof pin !== "object" || pin === null || Array.isArray(pin)) {
    throw new FetchFrozenError("frozen-pin-json", "cua-narrow-frozen.json must be a JSON object");
  }
  const fields = [
    "releaseTag",
    "archiveAsset",
    "archiveSha256",
    "manifestRelativePath",
    "manifestSha256",
  ];
  for (const field of fields) {
    if (typeof pin[field] !== "string" || !pin[field].trim()) {
      throw new FetchFrozenError(
        "frozen-pin-json",
        `cua-narrow-frozen.json field ${field} must be a non-empty string`,
      );
    }
  }
  for (const digestField of ["archiveSha256", "manifestSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(pin[digestField])) {
      throw new FetchFrozenError(
        "frozen-pin-json",
        `cua-narrow-frozen.json ${digestField} must be a lowercase sha256 digest`,
      );
    }
  }
  return pin;
}

async function downloadArchiveWithGh(pin, downloadDir, { env, cwd }) {
  try {
    await execFile(
      "gh",
      [
        "release",
        "download",
        pin.releaseTag,
        "--pattern",
        pin.archiveAsset,
        "--output",
        join(downloadDir, pin.archiveAsset),
        "--clobber",
      ],
      {
        env,
        cwd,
      },
    );
  } catch (error) {
    throw new FetchFrozenError(
      "frozen-archive-download",
      `gh release download failed for tag ${pin.releaseTag} (asset ${pin.archiveAsset}); publish the frozen archive to the release first, or set ZODY_CUA_NARROW_FROZEN_ARCHIVE to a local tar.gz`,
      { stderr: String(error?.stderr ?? error?.message ?? error).slice(0, 2000) },
    );
  }
  return join(downloadDir, pin.archiveAsset);
}

export async function fetchCuaNarrowFrozen({
  env = process.env,
  repoRoot = resolve(import.meta.dirname, "../../.."),
  pinFilePath = PIN_FILE_PATH,
  force = false,
  deps = {},
}) {
  const pin = parseFrozenPinFile(await readFile(pinFilePath, "utf8"));
  const absoluteRepoRoot = resolve(repoRoot);

  const localArchive = env.ZODY_CUA_NARROW_FROZEN_ARCHIVE?.trim() || null;
  let archivePath;
  let downloadDir = null;
  if (localArchive) {
    archivePath = resolve(localArchive);
    try {
      await access(archivePath, fsConstants.F_OK);
    } catch (error) {
      throw new FetchFrozenError(
        "frozen-archive-missing",
        `ZODY_CUA_NARROW_FROZEN_ARCHIVE is unreadable: ${archivePath}`,
        { cause: error?.code },
      );
    }
  } else {
    downloadDir = await mkdtemp(join(tmpdir(), "zody-cua-narrow-fetch-"));
    archivePath = await (deps.downloadArchive ?? downloadArchiveWithGh)(pin, downloadDir, {
      env,
      cwd: resolve(dirname(pinFilePath), "../../.."),
    });
  }

  try {
    const observed = await sha256File(archivePath);
    if (observed !== pin.archiveSha256) {
      throw new FetchFrozenError(
        "frozen-archive-sha-mismatch",
        "downloaded archive does not match the pinned archiveSha256",
        { observed, expected: pin.archiveSha256 },
      );
    }
    const result = await restoreCuaNarrowFrozen({
      archivePath,
      expectedSha256: pin.archiveSha256,
      repoRoot: absoluteRepoRoot,
      force,
      env,
    });
    if (result.manifestSha256 !== pin.manifestSha256) {
      throw new FetchFrozenError(
        "frozen-manifest-sha-mismatch",
        "restored manifest does not match the pinned manifestSha256",
        { observed: result.manifestSha256, expected: pin.manifestSha256 },
      );
    }
    return { ...result, pin };
  } finally {
    if (downloadDir) {
      await rm(downloadDir, { recursive: true, force: true });
    }
  }
}

const USAGE = `Usage:
  pnpm --dir packages/desktop run fetch:cua-narrow-frozen [--force]

Reads packages/desktop/build/cua-narrow-frozen.json, downloads the pinned frozen
archive via gh release download (or uses ZODY_CUA_NARROW_FROZEN_ARCHIVE=<local
tar.gz>), verifies both sha256 pins, and restores the default darwin/arm64
cua-narrow assembly inputs. CI passes GH_TOKEN/GITHUB_TOKEN for private releases.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  try {
    const result = await fetchCuaNarrowFrozen({ force: process.argv.includes("--force") });
    process.stdout.write(`${JSON.stringify({ status: "pass", ...result }, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: "fail", code: error?.code, message: error?.message ?? String(error), details: error?.details })}\n`,
    );
    process.exit(1);
  }
}
