import { isAbsolute } from "node:path";
import type { ModelSelection } from "@zcode/shared";
import {
  digestZCodeAgentNativeRuntimeNetwork,
  normalizeZCodeAgentNativeRuntimeNetwork,
} from "@zcode/services/node";

/** Fixed compile-time opt-in. Missing/undefined keeps the normal Electron utility Host path. */
declare const __ZCODE_CUA_NARROW_AGENT__: unknown;

export const CUA_NARROW_PROFILE_KIND = "zody-cua-narrow-agent-profile";
export const CUA_NARROW_PROFILE_SCHEMA_VERSION = 1;
export const CUA_NARROW_CAPABILITY = "screenshot.single-window";
export const CUA_NARROW_RESOURCES_SLOT = "cua-narrow";
export const CUA_NARROW_APP_NAME = "Zody CUA Desktop Session.app";
export const CUA_NARROW_LAUNCHER_RELATIVE_PATH = "Contents/MacOS/macos-cua-desktop-session";
export const CUA_NARROW_MANIFEST_RELATIVE_PATH = `${CUA_NARROW_RESOURCES_SLOT}/manifest.json`;
export const CUA_NARROW_MANIFEST_KIND = "zody-cua-narrow-resource-manifest";
export const CUA_NARROW_MINIMUM_MACOS_VERSION = "14.2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CuaNarrowAgentBuildProfile {
  readonly kind: typeof CUA_NARROW_PROFILE_KIND;
  readonly schemaVersion: typeof CUA_NARROW_PROFILE_SCHEMA_VERSION;
  readonly capability: typeof CUA_NARROW_CAPABILITY;
  readonly testedTarget: {
    readonly os: "darwin";
    readonly arch: "arm64";
    readonly macOSVersion: string;
  };
  readonly workspaceAllowlist: readonly string[];
  readonly resourceManifest: {
    readonly sha256: string;
    readonly launcherSha256: string;
  };
  /**
   * Content digest of normalized public provider/model facts. The provider registry's
   * numeric revision is process-local and therefore deliberately not pinned.
   */
  readonly provider: {
    readonly revisionSha256: string;
    readonly selection: ModelSelection;
  };
  readonly network: { readonly digestSha256: string };
}

function fail(message: string): never {
  throw new Error(`cua-narrow build profile: ${message}`);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unsupported field ${key}`);
  }
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function readAbsolutePath(value: unknown, label: string): string {
  const path = readString(value, label);
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  return path;
}

function readSha256(value: unknown, label: string): string {
  const digest = readString(value, label);
  if (!SHA256_PATTERN.test(digest)) fail(`${label} must be a lowercase sha256 digest`);
  return digest;
}

export function normalizeCuaNarrowSelection(
  selection: ModelSelection | null | undefined,
): ModelSelection | null {
  if (!selection) return null;
  const providerId = selection.providerId?.trim();
  const modelId = selection.modelId?.trim();
  if (!providerId || !modelId) return null;
  const reasoningLevel = selection.options?.reasoningLevel?.trim();
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

function readSelection(value: unknown, label: string): ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["providerId", "modelId", "options"], label);
  let options: ModelSelection["options"];
  if (record.options !== undefined) {
    if (
      typeof record.options !== "object" ||
      record.options === null ||
      Array.isArray(record.options)
    ) {
      fail(`${label}.options must be an object`);
    }
    const optionsRecord = record.options as Record<string, unknown>;
    assertOnlyKeys(optionsRecord, ["reasoningLevel"], `${label}.options`);
    const reasoningLevel = readString(
      optionsRecord.reasoningLevel,
      `${label}.options.reasoningLevel`,
    );
    options = { reasoningLevel };
  }
  const normalized = normalizeCuaNarrowSelection({
    providerId: readString(record.providerId, `${label}.providerId`),
    modelId: readString(record.modelId, `${label}.modelId`),
    ...(options ? { options } : {}),
  });
  if (!normalized) fail(`${label} is invalid`);
  return normalized;
}

export interface CuaNarrowNetworkConfig {
  readonly httpProxy?: string | null;
  readonly noProxy?: string | null;
  readonly caCertPath?: string | null;
}

export type CuaNarrowNormalizedNetworkConfig = ReturnType<
  typeof normalizeZCodeAgentNativeRuntimeNetwork
>;

/** Same normalization used by the services readback digest and the build profile. */
export function normalizeCuaNarrowNetworkConfig(
  input: CuaNarrowNetworkConfig,
): CuaNarrowNormalizedNetworkConfig {
  return normalizeZCodeAgentNativeRuntimeNetwork(input);
}

export function digestCuaNarrowNetworkConfig(input: CuaNarrowNetworkConfig): string {
  return digestZCodeAgentNativeRuntimeNetwork(input);
}

export function parseCuaNarrowAgentBuildProfile(value: unknown): CuaNarrowAgentBuildProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("profile.kind is required and profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  assertOnlyKeys(
    profile,
    [
      "kind",
      "schemaVersion",
      "capability",
      "testedTarget",
      "workspaceAllowlist",
      "resourceManifest",
      "provider",
      "network",
    ],
    "profile",
  );
  if (profile.kind !== CUA_NARROW_PROFILE_KIND) fail("kind mismatch");
  if (profile.schemaVersion !== CUA_NARROW_PROFILE_SCHEMA_VERSION) fail("schemaVersion mismatch");
  if (profile.capability !== CUA_NARROW_CAPABILITY) fail("capability mismatch");

  if (
    typeof profile.testedTarget !== "object" ||
    profile.testedTarget === null ||
    Array.isArray(profile.testedTarget)
  ) {
    fail("testedTarget must be an object");
  }
  const target = profile.testedTarget as Record<string, unknown>;
  assertOnlyKeys(target, ["os", "arch", "macOSVersion"], "testedTarget");
  if (target.os !== "darwin") fail("testedTarget.os mismatch");
  if (target.arch !== "arm64") fail("testedTarget.arch mismatch");
  const macOSVersion = readString(target.macOSVersion, "testedTarget.macOSVersion");

  if (!Array.isArray(profile.workspaceAllowlist) || profile.workspaceAllowlist.length === 0) {
    fail("workspaceAllowlist must be a non-empty array");
  }
  const workspaceAllowlist = [
    ...new Set(
      profile.workspaceAllowlist.map((entry, index) =>
        readAbsolutePath(entry, `workspaceAllowlist[${index}]`),
      ),
    ),
  ];

  if (
    typeof profile.resourceManifest !== "object" ||
    profile.resourceManifest === null ||
    Array.isArray(profile.resourceManifest)
  ) {
    fail("resourceManifest must be an object");
  }
  const resourceManifest = profile.resourceManifest as Record<string, unknown>;
  assertOnlyKeys(resourceManifest, ["sha256", "launcherSha256"], "resourceManifest");

  if (
    typeof profile.provider !== "object" ||
    profile.provider === null ||
    Array.isArray(profile.provider)
  ) {
    fail("provider must be an object");
  }
  const provider = profile.provider as Record<string, unknown>;
  assertOnlyKeys(provider, ["revisionSha256", "selection"], "provider");
  const revisionSha256 = readSha256(provider.revisionSha256, "provider.revisionSha256");
  const selection = readSelection(provider.selection, "provider.selection");

  if (
    typeof profile.network !== "object" ||
    profile.network === null ||
    Array.isArray(profile.network)
  ) {
    fail("network must be an object");
  }
  const network = profile.network as Record<string, unknown>;
  assertOnlyKeys(network, ["digestSha256"], "network");

  return Object.freeze({
    kind: CUA_NARROW_PROFILE_KIND,
    schemaVersion: CUA_NARROW_PROFILE_SCHEMA_VERSION,
    capability: CUA_NARROW_CAPABILITY,
    testedTarget: Object.freeze({ os: "darwin", arch: "arm64", macOSVersion }),
    workspaceAllowlist: Object.freeze(workspaceAllowlist),
    resourceManifest: Object.freeze({
      sha256: readSha256(resourceManifest.sha256, "resourceManifest.sha256"),
      launcherSha256: readSha256(
        resourceManifest.launcherSha256,
        "resourceManifest.launcherSha256",
      ),
    }),
    provider: Object.freeze({
      revisionSha256,
      selection: Object.freeze(selection),
    }),
    network: Object.freeze({
      digestSha256: readSha256(network.digestSha256, "network.digestSha256"),
    }),
  });
}

export function readCuaNarrowAgentBuildProfile(): unknown {
  return typeof __ZCODE_CUA_NARROW_AGENT__ === "undefined" ? undefined : __ZCODE_CUA_NARROW_AGENT__;
}
