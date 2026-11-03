import {
  SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
  updatePreparationResultSchema,
  type ReleaseManifest,
} from "../contracts.js";
import { isControlEndpointUnavailable, requestControl } from "../ipc/controlClient.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { createServiceLogger } from "@zcode/services/node";
import { isAbsolute } from "node:path";
import { currentServerTarget } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("Running tasks require --force for update")
  );
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

// 与上游 shared 的 compareCompatibilityVersions 同算法（a60ba6a7）：semver 严格比较，
// prerelease 按数字/字典序；解析失败由调用方按“无法证明方向”处理。
function parseVersion(value: string): ParsedVersion {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u);
  if (!match) throw new Error(`Invalid compatibility version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.localeCompare(right);
}

function compareCompatibilityVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = compareIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/** 返回被替换的版本；无法证明方向（首装或非 semver 历史版本）时不视为降级。 */
function readDowngradedFromVersion(
  previous: ReleaseManifest | null,
  target: ReleaseManifest,
): string | undefined {
  if (!previous) return undefined;
  try {
    return compareCompatibilityVersions(target.version, previous.version) < 0
      ? previous.version
      : undefined;
  } catch {
    return undefined;
  }
}

function readSingleOption(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

const log = createServiceLogger("server-update-command");

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // 准备产物清理属于非关键收尾；直接 await discard 会让清理失败覆盖
    // running-task guard 或 control socket 的原始错误，导致用户看到错误的排障方向。
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<number>,
): Promise<number> {
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate 会下载、解压并写入 pending release；旧流程在准备完成后
    // 才由 apply-update 检查运行任务，导致 guard 拒绝时仍留下网络和磁盘副作用。先检查已知的
    // 运行任务，并在准备完成后再次检查；最终 apply-update guard 仍覆盖最后一小段竞态。
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw new Error("Running tasks require --force for update");
  }
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `Zody Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw new Error("Running tasks require --force for update");
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    const result = await applyUpdate();
    discardPreparedUpdate = undefined;
    return result;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}

/**
 * `update --from-archive`：从本地 archive 强制安装并应用（a60ba6a7）。daemon 在线时走 apply-update，
 * 离线时走本地事务切换。降级必须显式 `--allow-downgrade` 确认并写 downgrade 标记。
 */
export async function runLocalArchiveUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<number>,
): Promise<number> {
  const archivePath = readSingleOption(argv, "--from-archive");
  if (!archivePath) throw new Error("--from-archive requires a path");
  if (!isAbsolute(archivePath)) throw new Error("--from-archive must be an absolute path");
  const force = argv.includes("--force");
  let daemonOnline = false;
  if (!force) {
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      daemonOnline = true;
      if (result.status === "blocked") throw new Error("Running tasks require --force for update");
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  } else {
    try {
      await requestControl(layout.controlEndpoint, { command: "status" });
      daemonOnline = true;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  }
  const releaseManager = new ReleaseManager(layout);
  const previous = await releaseManager.readCurrent();
  const prepared = await new ReleaseInstaller(layout).installArchive({
    archivePath,
    target: currentServerTarget(),
  });
  // 降级只能由用户显式确认。方向在安装完成后按真实 current 判定：调用方的版本探测结果
  // 可能已过时（其他设备刚升级远端），不能让普通更新把更新的远端静默降级。
  const downgradedFrom = readDowngradedFromVersion(previous, prepared);
  if (downgradedFrom && !argv.includes("--allow-downgrade")) {
    await releaseManager.removePending();
    throw new ControlRequestError(
      SOURCE_SERVER_DOWNGRADE_UNCONFIRMED_ERROR_CODE,
      `Downgrading Zody Server from ${downgradedFrom} to ${prepared.version} requires --allow-downgrade`,
      false,
    );
  }
  if (downgradedFrom) await releaseManager.markDowngrade(prepared, downgradedFrom);
  if (daemonOnline) {
    if (!force) {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") throw new Error("Running tasks require --force for update");
    }
    await applyUpdate();
    const result = { applied: true, installed: false, version: prepared.version };
    if (json) stdout(io, result);
    else stdout(io, `Zody Server ${prepared.version} updated`);
    return 0;
  }
  await releaseManager.applyPendingWithTransaction(previous);
  await releaseManager.completeUpdate();
  const result = { applied: true, installed: previous === null, version: prepared.version };
  if (json) stdout(io, result);
  else stdout(io, `Zody Server ${prepared.version} ${previous ? "updated" : "installed"}`);
  return 0;
}
