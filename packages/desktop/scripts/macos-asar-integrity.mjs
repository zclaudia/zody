// Shared macOS ASAR integrity owner for electron-builder and the normal Host candidate.
// Electron hashes the raw ASAR header string, not the whole archive. The plist hash must be
// refreshed after the last ASAR rewrite and before any signing step.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import asar from "@electron/asar";

const execFileAsync = promisify(execFile);
const PLISTBUDDY_PATH = "/usr/libexec/PlistBuddy";
const ASAR_INTEGRITY_KEY_PATH = ":ElectronAsarIntegrity:Resources/app.asar";

export class MacosAsarIntegrityError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "MacosAsarIntegrityError";
    this.code = code;
  }
}

function integrityError(code, message, cause) {
  return new MacosAsarIntegrityError(code, message, cause);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRawHeader(rawHeader) {
  if (typeof rawHeader?.headerString !== "string" || rawHeader.headerString.length === 0) {
    throw integrityError("asar-integrity-invalid-header", "ASAR raw header string is missing");
  }
  if (!Number.isInteger(rawHeader.headerSize) || rawHeader.headerSize <= 0) {
    throw integrityError("asar-integrity-invalid-header", "ASAR raw header size is invalid");
  }
  if (!isPlainObject(rawHeader.header) || !isPlainObject(rawHeader.header.files)) {
    throw integrityError("asar-integrity-invalid-header", "ASAR header has no filesystem root");
  }
  return Buffer.from(rawHeader.headerString, "utf8");
}

export async function readMacosAsarIntegrity(appAsarPath) {
  if (!isAbsolute(appAsarPath)) {
    throw integrityError("asar-integrity-path", "app.asar path must be absolute");
  }

  let archiveInfo;
  try {
    archiveInfo = await stat(appAsarPath);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      throw integrityError(
        "asar-integrity-missing-archive",
        `app.asar is missing: ${appAsarPath}`,
        cause,
      );
    }
    throw integrityError(
      "asar-integrity-unreadable-archive",
      `app.asar is unreadable: ${appAsarPath}`,
      cause,
    );
  }
  if (!archiveInfo.isFile()) {
    throw integrityError(
      "asar-integrity-unreadable-archive",
      `app.asar is not a file: ${appAsarPath}`,
    );
  }
  let archiveSha256;
  try {
    archiveSha256 = await sha256File(appAsarPath);
  } catch (cause) {
    throw integrityError(
      "asar-integrity-unreadable-archive",
      `app.asar is unreadable: ${appAsarPath}`,
      cause,
    );
  }

  let rawHeader;
  try {
    rawHeader = asar.getRawHeader(appAsarPath);
  } catch (cause) {
    throw integrityError(
      "asar-integrity-invalid-header",
      `app.asar header is invalid: ${appAsarPath}`,
      cause,
    );
  }
  const headerBytes = assertRawHeader(rawHeader);

  return Object.freeze({
    // 修复依据：app-builder-lib 的 hashHeader 读取 readAsarHeader().header，即
    // getRawHeader().headerString 的 UTF-8 字节；whole-archive SHA 只能单独记录。
    algorithm: "SHA256",
    headerBytes: headerBytes.length,
    headerSha256: sha256(headerBytes),
    archiveBytes: archiveInfo.size,
    archiveSha256,
  });
}

async function runPlistBuddyCommand(args) {
  const { stdout } = await execFileAsync(PLISTBUDDY_PATH, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return stdout;
}

async function readIntegrityPlistValue(infoPlistPath, key, runPlistBuddy) {
  let value;
  try {
    value = await runPlistBuddy(["-c", `Print ${ASAR_INTEGRITY_KEY_PATH}:${key}`, infoPlistPath]);
  } catch (cause) {
    throw integrityError(
      "asar-integrity-plist-entry",
      `Info.plist lacks ${ASAR_INTEGRITY_KEY_PATH}:${key}`,
      cause,
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw integrityError(
      "asar-integrity-plist-entry",
      `Info.plist has an empty ${ASAR_INTEGRITY_KEY_PATH}:${key}`,
    );
  }
  return normalized;
}

export async function refreshMacosAsarIntegrity({
  appAsarPath,
  infoPlistPath,
  runPlistBuddy = runPlistBuddyCommand,
}) {
  if (!isAbsolute(infoPlistPath)) {
    throw integrityError("asar-integrity-path", "Info.plist path must be absolute");
  }

  const integrity = await readMacosAsarIntegrity(appAsarPath);
  const previousAlgorithm = await readIntegrityPlistValue(
    infoPlistPath,
    "algorithm",
    runPlistBuddy,
  );
  // 未知算法不能静默改写成 SHA256 后宣称校验通过；只有既有 SHA256 条目可刷新。
  if (previousAlgorithm !== "SHA256") {
    throw integrityError(
      "asar-integrity-plist-algorithm",
      `Info.plist ASAR algorithm is unsupported: ${previousAlgorithm}`,
    );
  }
  await readIntegrityPlistValue(infoPlistPath, "hash", runPlistBuddy);

  await runPlistBuddy([
    "-c",
    `Set ${ASAR_INTEGRITY_KEY_PATH}:hash ${integrity.headerSha256}`,
    infoPlistPath,
  ]);
  await runPlistBuddy([
    "-c",
    `Set ${ASAR_INTEGRITY_KEY_PATH}:algorithm ${integrity.algorithm}`,
    infoPlistPath,
  ]);

  const refreshedHash = await readIntegrityPlistValue(infoPlistPath, "hash", runPlistBuddy);
  const refreshedAlgorithm = await readIntegrityPlistValue(
    infoPlistPath,
    "algorithm",
    runPlistBuddy,
  );
  if (refreshedHash !== integrity.headerSha256 || refreshedAlgorithm !== integrity.algorithm) {
    throw integrityError(
      "asar-integrity-refresh-mismatch",
      "Info.plist ASAR integrity did not persist the refreshed values",
    );
  }
  return integrity;
}
