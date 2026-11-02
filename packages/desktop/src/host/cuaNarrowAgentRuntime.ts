import { resolve } from "node:path";
import type { ModelSelection } from "@zody/shared";
import type {
  ZodyAgentCommandResolverContext,
  ZodyAgentNativeRuntimeConfig,
  ZCodeAgentNativeRuntimeResolver,
  ZCodeAgentNativeRuntimeResolverContext,
  ZodyAgentNativeRuntimeStartupContext,
} from "@zody/services/node";
import {
  digestCuaNarrowNetworkConfig,
  normalizeCuaNarrowSelection,
  parseCuaNarrowAgentBuildProfile,
  readCuaNarrowAgentBuildProfile,
  type CuaNarrowAgentBuildProfile,
} from "./cuaNarrowAgentProfile.js";
import {
  assertManifestShape,
  canonicalize,
  defaultRuntimeFileDependencies,
  readMacOSVersion,
  resolveCuaNarrowLauncherPath,
  resolveCuaNarrowManifestPath,
  sha256,
  type CuaNarrowRuntimeFileDependencies,
} from "./cuaNarrowAgentResources.js";

export * from "./cuaNarrowAgentProfile.js";
export * from "./cuaNarrowAgentResources.js";

/**
 * Single-line bounded diagnostic marker. The payload intentionally contains only the
 * opaque provider digest, normalized selection, and normalized network digest.
 */
export const CUA_NARROW_STARTUP_SNAPSHOT_LOG_MARKER = "cua-narrow-startup-snapshot:";

export type CuaNarrowUnsupportedReason =
  | "invalid-build-profile"
  | "target-platform"
  | "target-arch"
  | "target-macos-version"
  | "resources-path"
  | "launcher-missing"
  | "launcher-digest-mismatch"
  | "manifest-missing"
  | "manifest-digest-mismatch"
  | "manifest-shape"
  | "startup-context-unavailable"
  | "provider-revision-mismatch"
  | "provider-selection-mismatch"
  | "network-digest-mismatch"
  | "no-prepared-workspace";

export interface CuaNarrowDecisionEvent {
  readonly kind:
    | "narrow-runtime-startup-snapshot"
    | "narrow-runtime-prepared"
    | "narrow-runtime-eligible"
    | "narrow-runtime-fallback";
  readonly reason: string;
  readonly workspacePath?: string;
  readonly snapshotSource: "build-profile" | "existing-host-services";
  readonly taskTimeProviderGuard: false;
  readonly providerRevisionSha256?: string;
  readonly selection?: ModelSelection | null;
  readonly networkDigestSha256?: string;
}

export interface CuaNarrowAgentRuntime {
  readonly launcherPath: string;
  readonly profile: CuaNarrowAgentBuildProfile;
  readonly resolve: ZCodeAgentNativeRuntimeResolver;
}

export type CuaNarrowPrepareResult =
  | { readonly status: "disabled"; readonly reason: "no-build-profile" }
  | {
      readonly status: "unsupported";
      readonly reason: CuaNarrowUnsupportedReason;
      readonly detail?: string;
    }
  | { readonly status: "eligible"; readonly runtime: CuaNarrowAgentRuntime };

export interface PrepareCuaNarrowAgentRuntimeOptions {
  buildProfile?: unknown;
  platform?: NodeJS.Platform;
  arch?: string;
  macOSVersion?: string;
  resourcesPath?: string;
  preparedWorkspacePaths?: readonly string[];
  /** Actual facts read once from the existing Host services before services are published. */
  startupContext?: ZodyAgentNativeRuntimeStartupContext;
  report?: (event: CuaNarrowDecisionEvent) => void;
  deps?: CuaNarrowRuntimeFileDependencies;
}

type StartupMismatchReason =
  | "startup-context-unavailable"
  | "provider-revision-mismatch"
  | "provider-selection-mismatch"
  | "network-digest-mismatch";

function selectionDigest(selection: ModelSelection | null | undefined): string {
  return JSON.stringify(normalizeCuaNarrowSelection(selection));
}

function compareStartupContext(
  profile: CuaNarrowAgentBuildProfile,
  context: ZodyAgentNativeRuntimeStartupContext | undefined,
): StartupMismatchReason | null {
  if (!context) return "startup-context-unavailable";
  if (context.providerRevisionSha256 !== profile.provider.revisionSha256) {
    return "provider-revision-mismatch";
  }
  if (selectionDigest(context.selection) !== selectionDigest(profile.provider.selection)) {
    return "provider-selection-mismatch";
  }
  if (digestCuaNarrowNetworkConfig(context.network) !== profile.network.digestSha256) {
    return "network-digest-mismatch";
  }
  return null;
}

/**
 * Startup eligibility. The actual provider/model/network values are read from the Host's
 * existing services and compared to the build profile; no values in this object are treated
 * as self-attested proof.
 */
export async function prepareCuaNarrowAgentRuntime(
  options: PrepareCuaNarrowAgentRuntimeOptions = {},
): Promise<CuaNarrowPrepareResult> {
  const buildProfile = options.buildProfile ?? readCuaNarrowAgentBuildProfile();
  if (buildProfile === undefined) {
    return { status: "disabled", reason: "no-build-profile" };
  }
  const report = options.report ?? (() => undefined);
  const reportEvent = (event: CuaNarrowDecisionEvent) => {
    try {
      report(event);
    } catch {
      // Logging is diagnostic only and must not change routing.
    }
  };
  // Emit the bounded readback even when the pinned profile later mismatches. This lets the
  // controller rebuild from the real startup facts without copying provider/network config.
  if (options.startupContext) {
    reportEvent({
      kind: "narrow-runtime-startup-snapshot",
      reason: "read-before-eligibility-compare",
      providerRevisionSha256: options.startupContext.providerRevisionSha256,
      selection: options.startupContext.selection,
      networkDigestSha256: digestCuaNarrowNetworkConfig(options.startupContext.network),
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    });
  }
  const unsupported = (
    reason: CuaNarrowUnsupportedReason,
    detail?: string,
  ): CuaNarrowPrepareResult => {
    reportEvent({
      kind: "narrow-runtime-prepared",
      reason,
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    });
    return detail ? { status: "unsupported", reason, detail } : { status: "unsupported", reason };
  };

  let profile: CuaNarrowAgentBuildProfile;
  try {
    profile = parseCuaNarrowAgentBuildProfile(buildProfile);
  } catch (error) {
    return unsupported(
      "invalid-build-profile",
      error instanceof Error ? error.message : String(error),
    );
  }

  const platform = options.platform ?? process.platform;
  if (platform !== profile.testedTarget.os) return unsupported("target-platform");
  const arch = options.arch ?? process.arch;
  if (arch !== profile.testedTarget.arch) return unsupported("target-arch");
  const macOSVersion = options.macOSVersion ?? readMacOSVersion();
  if (!macOSVersion || macOSVersion !== profile.testedTarget.macOSVersion) {
    return unsupported("target-macos-version");
  }

  const startupMismatch = compareStartupContext(profile, options.startupContext);
  if (startupMismatch) return unsupported(startupMismatch);

  const resourcesPath = options.resourcesPath;
  if (!resourcesPath) return unsupported("resources-path");
  let launcherPath: string;
  let manifestPath: string;
  try {
    launcherPath = resolveCuaNarrowLauncherPath(resourcesPath);
    manifestPath = resolveCuaNarrowManifestPath(resourcesPath);
  } catch {
    return unsupported("resources-path");
  }

  const deps = defaultRuntimeFileDependencies();
  const readFileDep = options.deps?.readFile ?? deps.readFile;
  const statFileDep = options.deps?.statFile ?? deps.statFile;
  const realpathDep = options.deps?.realpath ?? deps.realpath;

  try {
    const launcherInfo = await statFileDep(launcherPath);
    if (!launcherInfo.isFile()) return unsupported("launcher-missing");
    const launcherBytes = await readFileDep(launcherPath);
    if (sha256(launcherBytes) !== profile.resourceManifest.launcherSha256) {
      return unsupported("launcher-digest-mismatch");
    }
  } catch {
    return unsupported("launcher-missing");
  }

  try {
    const manifestInfo = await statFileDep(manifestPath);
    if (!manifestInfo.isFile()) return unsupported("manifest-missing");
    const manifestBytes = await readFileDep(manifestPath);
    if (sha256(manifestBytes) !== profile.resourceManifest.sha256) {
      return unsupported("manifest-digest-mismatch");
    }
    try {
      assertManifestShape(
        JSON.parse(manifestBytes.toString("utf8")),
        profile.resourceManifest.launcherSha256,
      );
    } catch {
      return unsupported("manifest-shape");
    }
  } catch {
    return unsupported("manifest-missing");
  }

  const allowlist = new Set(
    await Promise.all(profile.workspaceAllowlist.map((path) => canonicalize(path, realpathDep))),
  );
  const prepared = new Set(
    await Promise.all(
      (options.preparedWorkspacePaths ?? []).map((path) => canonicalize(path, realpathDep)),
    ),
  );
  let hasPreparedAllowlistedWorkspace = false;
  for (const workspace of allowlist) {
    if (prepared.has(workspace)) {
      hasPreparedAllowlistedWorkspace = true;
      break;
    }
  }
  if (!hasPreparedAllowlistedWorkspace) return unsupported("no-prepared-workspace");

  reportEvent({
    kind: "narrow-runtime-prepared",
    reason: "eligible",
    snapshotSource: "existing-host-services",
    taskTimeProviderGuard: false,
  });

  const resolveWorkspace: ZCodeAgentNativeRuntimeResolver = async (
    context: ZodyAgentCommandResolverContext,
    runtimeContext?: ZCodeAgentNativeRuntimeResolverContext,
  ): Promise<ZodyAgentNativeRuntimeConfig | null> => {
    let spawnContext: ZodyAgentNativeRuntimeStartupContext;
    try {
      if (!runtimeContext) throw new Error("startup context reader unavailable");
      spawnContext = await runtimeContext.readStartupContext();
    } catch {
      reportEvent({
        kind: "narrow-runtime-fallback",
        reason: "startup-context-unavailable",
        workspacePath: context.workspacePath,
        snapshotSource: "existing-host-services",
        taskTimeProviderGuard: false,
      });
      return null;
    }
    const spawnMismatch = compareStartupContext(profile, spawnContext);
    if (spawnMismatch) {
      reportEvent({
        kind: "narrow-runtime-fallback",
        reason: spawnMismatch,
        workspacePath: context.workspacePath,
        snapshotSource: "existing-host-services",
        taskTimeProviderGuard: false,
      });
      return null;
    }

    let workspacePath: string;
    try {
      workspacePath = await canonicalize(context.workspacePath, realpathDep);
    } catch {
      workspacePath = resolve(context.workspacePath);
    }
    if (!allowlist.has(workspacePath)) {
      reportEvent({
        kind: "narrow-runtime-fallback",
        reason: "workspace-not-allowlisted",
        workspacePath: context.workspacePath,
        snapshotSource: "build-profile",
        taskTimeProviderGuard: false,
      });
      return null;
    }
    if (!prepared.has(workspacePath)) {
      reportEvent({
        kind: "narrow-runtime-fallback",
        reason: "workspace-storage-not-prepared",
        workspacePath: context.workspacePath,
        snapshotSource: "build-profile",
        taskTimeProviderGuard: false,
      });
      return null;
    }
    reportEvent({
      kind: "narrow-runtime-eligible",
      reason: "workspace-allowlisted-and-startup-profile-matched",
      workspacePath: context.workspacePath,
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    });
    return {
      launcherPath,
      entryName: "cli-entry.mjs",
      cliInFd: 6,
      cliOutFd: 7,
      launchMode: "workspace-relay",
    };
  };

  return Object.freeze({
    status: "eligible",
    runtime: Object.freeze({ launcherPath, profile, resolve: resolveWorkspace }),
  });
}
