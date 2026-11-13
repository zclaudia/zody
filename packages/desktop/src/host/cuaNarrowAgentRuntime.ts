import { resolve } from "node:path";
import type { ModelSelection } from "@zody/shared";
import type {
  ZodyAgentCommandResolverContext,
  ZodyAgentNativeRuntimeConfig,
  ZodyAgentNativeRuntimeResolver,
  ZodyAgentNativeRuntimeResolverContext,
  ZodyAgentNativeRuntimeStartupContext,
} from "@zody/services/node";
import { digestZodyAgentNativeRuntimeNetwork } from "@zody/services/node";
import {
  CUA_NARROW_MINIMUM_MACOS_VERSION,
  parseCuaNarrowAgentBuildProfile,
  readCuaNarrowAgentBuildProfile,
  type CuaNarrowAgentBuildProfile,
} from "./cuaNarrowAgentProfile.js";
import {
  assertManifestShape,
  canonicalize,
  defaultRuntimeFileDependencies,
  isMacOSVersionAtLeast,
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
  | "macos-below-minimum"
  | "resources-path"
  | "launcher-missing"
  | "launcher-digest-mismatch"
  | "manifest-missing"
  | "manifest-digest-mismatch"
  | "manifest-shape";

/**
 * 动态 workspace 准入（2026-11-09 spec 追加小节）：对未命中 prepared 集合的本地
 * workspace，由 Host 接线注入「现场 session 存储准备」。返回 true 表示已准备完成，
 * resolver 将该 workspace 纳入集合并路由窄链；false 表示本次回退普通 Agent。
 */
export type CuaNarrowWorkspaceStoragePreparer = (workspacePath: string) => Promise<boolean>;

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
  // 中文注释：字段旧名前缀撞上 M2 已退出标识，更名详见 ZodyAgentNativeRuntimeStartupContext
  // 处注释；语义是对 provider 配置快照的 SHA-256 digest，与同事件 networkDigestSha256 命名对齐。
  // v2 起仅随 startup-snapshot 诊断事件出现，不再参与 eligibility 比较。
  readonly providerDigestSha256?: string;
  readonly selection?: ModelSelection | null;
  readonly networkDigestSha256?: string;
}

export interface CuaNarrowAgentRuntime {
  readonly launcherPath: string;
  readonly profile: CuaNarrowAgentBuildProfile;
  readonly resolve: ZodyAgentNativeRuntimeResolver;
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
  /** Host init 时已准备的种子集合；resolver 期间动态扩充。 */
  preparedWorkspacePaths?: readonly string[];
  /** 未命中集合时的现场存储准备（Host 接线注入；测试可不注入保持回退语义）。 */
  prepareWorkspaceStorage?: CuaNarrowWorkspaceStoragePreparer;
  /**
   * Actual facts read once from the existing Host services. Diagnostic only since profile
   * schemaVersion 2: the startup snapshot is logged for post-hoc audit of the sealed agent's
   * effective provider/network config and never compared against build-time pins.
   */
  startupContext?: ZodyAgentNativeRuntimeStartupContext;
  report?: (event: CuaNarrowDecisionEvent) => void;
  deps?: CuaNarrowRuntimeFileDependencies;
}

/**
 * Startup eligibility. Content pins (manifest bytes + signed launcher digest) are the only
 * integrity anchors; the Host-side workspace gate is the prepared-storage snapshot taken
 * at Host init. Remote workspaces never route here (caller-side check).
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
  // 诊断性 readback：无论 eligibility 结果如何都记录一次有界 startup 事实，
  // 供事后审计 sealed agent 实际运行配置；读取失败只跳过日志，不影响路由。
  if (options.startupContext) {
    reportEvent({
      kind: "narrow-runtime-startup-snapshot",
      reason: "diagnostic-readback",
      providerDigestSha256: options.startupContext.providerDigestSha256,
      selection: options.startupContext.selection,
      networkDigestSha256: digestZodyAgentNativeRuntimeNetwork(options.startupContext.network),
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
  if (platform !== profile.minimumTarget.os) return unsupported("target-platform");
  const arch = options.arch ?? process.arch;
  if (arch !== profile.minimumTarget.arch) return unsupported("target-arch");
  const macOSVersion = options.macOSVersion ?? readMacOSVersion();
  if (!macOSVersion) return unsupported("macos-below-minimum");
  if (!isMacOSVersionAtLeast(macOSVersion, CUA_NARROW_MINIMUM_MACOS_VERSION)) {
    return unsupported("macos-below-minimum");
  }

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

  // 准入集合：Host init 种子 + spawn 期动态准备（同一 canonical 键 in-flight 去重）。
  const prepared = new Set(
    await Promise.all(
      (options.preparedWorkspacePaths ?? []).map((path) => canonicalize(path, realpathDep)),
    ),
  );
  const prepareWorkspaceStorage = options.prepareWorkspaceStorage;
  const storagePreparations = new Map<string, Promise<boolean>>();
  const ensureWorkspacePrepared = (canonicalWorkspacePath: string): Promise<boolean> => {
    if (prepared.has(canonicalWorkspacePath)) return Promise.resolve(true);
    if (!prepareWorkspaceStorage) return Promise.resolve(false);
    const inflight = storagePreparations.get(canonicalWorkspacePath);
    if (inflight) return inflight;
    const preparation = Promise.resolve(prepareWorkspaceStorage(canonicalWorkspacePath))
      .then((ok) => {
        if (ok) prepared.add(canonicalWorkspacePath);
        return ok;
      })
      .finally(() => {
        storagePreparations.delete(canonicalWorkspacePath);
      });
    storagePreparations.set(canonicalWorkspacePath, preparation);
    return preparation;
  };

  reportEvent({
    kind: "narrow-runtime-prepared",
    reason: "eligible",
    snapshotSource: "existing-host-services",
    taskTimeProviderGuard: false,
  });

  const resolveWorkspace: ZodyAgentNativeRuntimeResolver = async (
    context: ZodyAgentCommandResolverContext,
    _runtimeContext?: ZodyAgentNativeRuntimeResolverContext,
  ): Promise<ZodyAgentNativeRuntimeConfig | null> => {
    let workspacePath: string;
    try {
      workspacePath = await canonicalize(context.workspacePath, realpathDep);
    } catch {
      workspacePath = resolve(context.workspacePath);
    }
    if (!(await ensureWorkspacePrepared(workspacePath))) {
      reportEvent({
        kind: "narrow-runtime-fallback",
        reason: prepareWorkspaceStorage
          ? "workspace-storage-preparation-failed"
          : "workspace-storage-not-prepared",
        workspacePath: context.workspacePath,
        snapshotSource: "build-profile",
        taskTimeProviderGuard: false,
      });
      return null;
    }
    reportEvent({
      kind: "narrow-runtime-eligible",
      reason: "workspace-prepared",
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
