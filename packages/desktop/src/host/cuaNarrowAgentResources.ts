import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import {
  CUA_NARROW_APP_NAME,
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_MANIFEST_KIND,
  CUA_NARROW_MINIMUM_MACOS_VERSION,
  CUA_NARROW_RESOURCES_SLOT,
} from "./cuaNarrowAgentProfile.js";

export interface CuaNarrowRuntimeFileDependencies {
  readFile?: (path: string) => Promise<Buffer>;
  statFile?: (path: string) => Promise<{ isFile(): boolean }>;
  realpath?: (path: string) => Promise<string>;
}

export function resolveInsideResources(resourcesPath: string, ...segments: string[]): string {
  if (!isAbsolute(resourcesPath)) throw new Error("resourcesPath must be absolute");
  const root = resolve(resourcesPath);
  const target = resolve(root, ...segments);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("cua-narrow path escapes resourcesPath");
  }
  return target;
}

export function resolveCuaNarrowLauncherPath(resourcesPath: string): string {
  return resolveInsideResources(
    resourcesPath,
    CUA_NARROW_RESOURCES_SLOT,
    CUA_NARROW_APP_NAME,
    CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  );
}

export function resolveCuaNarrowManifestPath(resourcesPath: string): string {
  return resolveInsideResources(resourcesPath, CUA_NARROW_RESOURCES_SLOT, "manifest.json");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readMacOSVersion(): string | undefined {
  const getSystemVersion = (process as NodeJS.Process & { getSystemVersion?: () => string })
    .getSystemVersion;
  try {
    return typeof getSystemVersion === "function" ? getSystemVersion.call(process) : undefined;
  } catch {
    return undefined;
  }
}

// 数值化逐段比较，缺省段按 0 处理；非数值段按 NaN 排最后（保守视为不满足下限）。
// 中文注释：macOS 版本号存在 26.x 跳跃编号，不能按字典序比较（"9.1" > "14.2" 是错的）。
export function compareMacOSVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split(".")
      .map((segment) => Number.parseInt(segment, 10))
      .map((segment) => (Number.isNaN(segment) ? Number.NaN : segment));
  const leftSegments = parse(left);
  const rightSegments = parse(right);
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftSegments[index] ?? 0;
    const b = rightSegments[index] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (Number.isNaN(a) === Number.isNaN(b)) continue;
      return Number.isNaN(a) ? -1 : 1;
    }
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

export function isMacOSVersionAtLeast(current: string, minimum: string): boolean {
  return compareMacOSVersions(current, minimum) >= 0;
}

export function assertManifestShape(manifest: unknown, launcherSha256: string): void {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  const record = manifest as Record<string, unknown>;
  if (record.kind !== CUA_NARROW_MANIFEST_KIND) throw new Error("manifest kind mismatch");
  if (record.status !== "pass" || record.schemaVersion !== 1) {
    throw new Error("manifest status/schema mismatch");
  }
  const target = record.target as Record<string, unknown> | undefined;
  if (target?.os !== "darwin" || target?.arch !== "arm64") {
    throw new Error("manifest target mismatch");
  }
  if (target?.minimumMacOSVersion !== CUA_NARROW_MINIMUM_MACOS_VERSION) {
    throw new Error("manifest minimum macOS mismatch");
  }
  const slot = record.slot as Record<string, unknown> | undefined;
  if (
    slot?.resourcesRelativePath !== CUA_NARROW_RESOURCES_SLOT ||
    slot?.appName !== CUA_NARROW_APP_NAME
  ) {
    throw new Error("manifest slot mismatch");
  }
  const identity = record.identity as Record<string, unknown> | undefined;
  if (identity?.signedBinarySha256 !== launcherSha256) {
    throw new Error("manifest launcher identity mismatch");
  }
}

export async function canonicalize(
  path: string,
  resolveRealpath: (path: string) => Promise<string>,
): Promise<string> {
  try {
    return await resolveRealpath(path);
  } catch {
    return resolve(path);
  }
}

export function defaultRuntimeFileDependencies(): Required<CuaNarrowRuntimeFileDependencies> {
  return { readFile, statFile: stat, realpath };
}
