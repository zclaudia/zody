import { statSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const ZODY_DIRECTORY_NAME = ".zody";
export const LEGACY_ZCODE_DIRECTORY_NAME = ".zcode";

export interface ProjectResourcePaths {
  /** Current effective file, or the future .zody write path when neither exists. */
  readPath: string;
  /** All reads and writes that create state must target this path. */
  writePath: string;
  /** Read-only compatibility candidate. */
  legacyPath: string;
}

export interface ProjectResourceRoots {
  /** Current writable root. */
  writePath: string;
  /** Read-only roots in priority order; callers merge distinct child names. */
  readPaths: [preferredPath: string, legacyPath: string];
  /** Read-only compatibility root. */
  legacyPath: string;
}

export function getUserZodyRoot(homeDirectory = homedir()): string {
  return join(homeDirectory, ZODY_DIRECTORY_NAME);
}

export function resolveProjectResourceRoots(
  workspacePath: string,
  ...resourceSegments: string[]
): ProjectResourceRoots {
  const writePath = join(workspacePath, ZODY_DIRECTORY_NAME, ...resourceSegments);
  const legacyPath = join(workspacePath, LEGACY_ZCODE_DIRECTORY_NAME, ...resourceSegments);
  return { writePath, readPaths: [writePath, legacyPath], legacyPath };
}

export function projectResourceBaseDir(resourcePath: string): string {
  const directory = dirname(resourcePath);
  return basename(directory) === ZODY_DIRECTORY_NAME ||
    basename(directory) === LEGACY_ZCODE_DIRECTORY_NAME
    ? dirname(directory)
    : directory;
}

export function resolveProjectResourcePaths(
  workspacePath: string,
  ...resourceSegments: string[]
): ProjectResourcePaths {
  const roots = resolveProjectResourceRoots(workspacePath, ...resourceSegments);
  const [preferredPath, legacyPath] = roots.readPaths;
  return {
    readPath: pathExistsSync(preferredPath)
      ? preferredPath
      : pathExistsSync(legacyPath)
        ? legacyPath
        : roots.writePath,
    writePath: roots.writePath,
    legacyPath,
  };
}

export async function resolveProjectResourcePathsAsync(
  workspacePath: string,
  ...resourceSegments: string[]
): Promise<ProjectResourcePaths> {
  const roots = resolveProjectResourceRoots(workspacePath, ...resourceSegments);
  const [preferredPath, legacyPath] = roots.readPaths;
  return {
    readPath: (await pathExists(preferredPath))
      ? preferredPath
      : (await pathExists(legacyPath))
        ? legacyPath
        : roots.writePath,
    writePath: roots.writePath,
    legacyPath,
  };
}

export function resolveProjectResourcePath(
  workspacePath: string,
  ...resourceSegments: string[]
): string {
  return resolveProjectResourcePaths(workspacePath, ...resourceSegments).readPath;
}

function pathExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
