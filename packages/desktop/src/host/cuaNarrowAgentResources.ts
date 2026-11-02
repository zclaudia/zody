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
