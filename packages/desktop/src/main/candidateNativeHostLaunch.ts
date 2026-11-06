import { isAbsolute, relative, resolve } from "node:path";
import {
  assertNativeHostLaunchConfig,
  type NativeHostLaunchConfig,
} from "./nodeHostProcess.js";

/** Packaged candidate descriptor resolved only against the running Electron resources root. */
export interface PackagedNativeHostLaunchConfig {
  readonly kind: "packaged-resources";
  /** Fixed candidate UI identity resolved by the same compile-time seam. */
  readonly applicationName?: string;
  readonly launcherPathRelativeToResources: string;
  readonly cwdRelativeToResources: string;
  readonly entryName?: NativeHostLaunchConfig["entryName"];
  readonly bridgeFd?: NativeHostLaunchConfig["bridgeFd"];
  readonly launchMode?: NativeHostLaunchConfig["launchMode"];
  readonly env?: NativeHostLaunchConfig["env"];
}

export type CandidateNativeHostLaunchConfig =
  | NativeHostLaunchConfig
  | PackagedNativeHostLaunchConfig;

/**
 * Compile-time candidate composition seam.
 *
 * A candidate UI build may replace this identifier with an object literal containing
 * the fixed absolute launcher path and cwd from sealed resources. Normal builds leave
 * it undefined and keep the Electron utilityProcess path. Never read this from env,
 * argv, Renderer messages, or a runtime JSON file: those are routing inputs, not a
 * signature/audit-token proof.
 */
declare const __ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__:
  | CandidateNativeHostLaunchConfig
  | undefined;

function readCompileTimeCandidate(): CandidateNativeHostLaunchConfig | undefined {
  return typeof __ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__ === "undefined"
    ? undefined
    : __ZODY_CANDIDATE_NATIVE_HOST_LAUNCH__;
}

function isPackagedNativeHostLaunchConfig(
  configured: CandidateNativeHostLaunchConfig,
): configured is PackagedNativeHostLaunchConfig {
  return "kind" in configured && configured.kind === "packaged-resources";
}

/** Candidate-only UI identity; normal builds have no compile-time candidate seam. */
export function resolveCandidateApplicationName(
  configured: CandidateNativeHostLaunchConfig | undefined = readCompileTimeCandidate(),
): string | undefined {
  if (!configured || !isPackagedNativeHostLaunchConfig(configured)) {
    return undefined;
  }
  if (configured.applicationName !== undefined && typeof configured.applicationName !== "string") {
    throw new Error("candidate nativeHost.applicationName must be a string");
  }
  return configured.applicationName?.trim() || undefined;
}

function resolveResourcesRelativePath(
  resourcesPath: string,
  relativePath: string,
  field: string,
): string {
  if (!isAbsolute(resourcesPath)) {
    throw new Error(`candidate resourcesPath must be absolute, got: ${resourcesPath}`);
  }
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    throw new Error(`candidate nativeHost.${field} must be a non-empty relative path`);
  }
  const resolvedPath = resolve(resourcesPath, relativePath);
  const rootRelativePath = relative(resolve(resourcesPath), resolvedPath);
  if (rootRelativePath === ".." || rootRelativePath.startsWith("../") || isAbsolute(rootRelativePath)) {
    throw new Error(`candidate nativeHost.${field} must stay inside process.resourcesPath`);
  }
  return resolvedPath;
}

function resolvePackagedCandidate(
  configured: PackagedNativeHostLaunchConfig,
  resourcesPath: string | undefined,
): NativeHostLaunchConfig {
  if (!resourcesPath) {
    throw new Error("Packaged candidate native Host requires process.resourcesPath");
  }
  return {
    launcherPath: resolveResourcesRelativePath(
      resourcesPath,
      configured.launcherPathRelativeToResources,
      "launcherPathRelativeToResources",
    ),
    cwd: resolveResourcesRelativePath(
      resourcesPath,
      configured.cwdRelativeToResources,
      "cwdRelativeToResources",
    ),
    ...(configured.entryName !== undefined ? { entryName: configured.entryName } : {}),
    ...(configured.bridgeFd !== undefined ? { bridgeFd: configured.bridgeFd } : {}),
    ...(configured.launchMode !== undefined ? { launchMode: configured.launchMode } : {}),
    ...(configured.env !== undefined ? { env: configured.env } : {}),
  };
}

function readRuntimeResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
}

export function resolveCandidateNativeHostLaunch(
  configured: CandidateNativeHostLaunchConfig | undefined = readCompileTimeCandidate(),
  options: { resourcesPath?: string } = {},
): NativeHostLaunchConfig | undefined {
  if (!configured) return undefined;
  const resolvedConfig =
    isPackagedNativeHostLaunchConfig(configured)
      ? resolvePackagedCandidate(
          configured,
          options.resourcesPath ?? readRuntimeResourcesPath(),
        )
      : configured;
  assertNativeHostLaunchConfig(resolvedConfig);
  return resolvedConfig;
}
