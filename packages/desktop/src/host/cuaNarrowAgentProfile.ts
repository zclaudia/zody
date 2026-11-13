// 分发轮次（2026-11-09 spec）：schemaVersion 2 只保留内容 pin 与最低目标地板，
// 不再携带构建机事实（workspaceAllowlist/provider/network/startup snapshot 均已删除）。
// v1 profile 在本 parser 下 fail 为 invalid-build-profile，Host 回退普通 Agent 路径。

export const CUA_NARROW_PROFILE_KIND = "zody-cua-narrow-agent-profile";
export const CUA_NARROW_PROFILE_SCHEMA_VERSION = 2;
export const CUA_NARROW_CAPABILITY = "screenshot.single-window";
export const CUA_NARROW_RESOURCES_SLOT = "cua-narrow";
export const CUA_NARROW_APP_NAME = "Zody CUA Desktop Session.app";
export const CUA_NARROW_LAUNCHER_RELATIVE_PATH = "Contents/MacOS/macos-cua-desktop-session";
export const CUA_NARROW_MANIFEST_RELATIVE_PATH = `${CUA_NARROW_RESOURCES_SLOT}/manifest.json`;
export const CUA_NARROW_MANIFEST_KIND = "zody-cua-narrow-resource-manifest";
export const CUA_NARROW_MINIMUM_MACOS_VERSION = "14.2";

/** Fixed compile-time opt-in. Missing/undefined keeps the normal Electron utility Host path. */
declare const __ZODY_CUA_NARROW_AGENT__: unknown;

export interface CuaNarrowAgentBuildProfile {
  readonly kind: typeof CUA_NARROW_PROFILE_KIND;
  readonly schemaVersion: typeof CUA_NARROW_PROFILE_SCHEMA_VERSION;
  readonly capability: typeof CUA_NARROW_CAPABILITY;
  readonly minimumTarget: {
    readonly os: "darwin";
    readonly arch: "arm64";
    readonly minimumMacOSVersion: string;
  };
  readonly resourceManifest: {
    readonly sha256: string;
    readonly launcherSha256: string;
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

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

function readSha256(value: unknown, label: string): string {
  const digest = readString(value, label);
  if (!SHA256_PATTERN.test(digest)) fail(`${label} must be a lowercase sha256 digest`);
  return digest;
}

export function parseCuaNarrowAgentBuildProfile(value: unknown): CuaNarrowAgentBuildProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("profile.kind is required and profile must be an object");
  }
  const profile = value as Record<string, unknown>;
  assertOnlyKeys(profile, ["kind", "schemaVersion", "capability", "minimumTarget", "resourceManifest"], "profile");
  if (profile.kind !== CUA_NARROW_PROFILE_KIND) fail("kind mismatch");
  if (profile.schemaVersion !== CUA_NARROW_PROFILE_SCHEMA_VERSION) {
    // 中文注释：v1（self-use 轮，2026-10-31）在这里显式失败，Host 以 invalid-build-profile
    // 回退普通 Agent 路径；不存在 v1/v2 双读路径，避免旧机器绑定语义静默复活。
    fail("schemaVersion mismatch (expected 2)");
  }
  if (profile.capability !== CUA_NARROW_CAPABILITY) fail("capability mismatch");

  if (
    typeof profile.minimumTarget !== "object" ||
    profile.minimumTarget === null ||
    Array.isArray(profile.minimumTarget)
  ) {
    fail("minimumTarget must be an object");
  }
  const target = profile.minimumTarget as Record<string, unknown>;
  assertOnlyKeys(target, ["os", "arch", "minimumMacOSVersion"], "minimumTarget");
  if (target.os !== "darwin") fail("minimumTarget.os mismatch");
  if (target.arch !== "arm64") fail("minimumTarget.arch mismatch");
  // 与随包 manifest 的 target.minimumMacOSVersion 同源常量严格相等：profile pin 的就是
  // 这份 manifest，地板不同说明 pin 与资源错配。
  if (readString(target.minimumMacOSVersion, "minimumTarget.minimumMacOSVersion") !== CUA_NARROW_MINIMUM_MACOS_VERSION) {
    fail("minimumTarget.minimumMacOSVersion mismatch");
  }

  if (
    typeof profile.resourceManifest !== "object" ||
    profile.resourceManifest === null ||
    Array.isArray(profile.resourceManifest)
  ) {
    fail("resourceManifest must be an object");
  }
  const resourceManifest = profile.resourceManifest as Record<string, unknown>;
  assertOnlyKeys(resourceManifest, ["sha256", "launcherSha256"], "resourceManifest");

  return Object.freeze({
    kind: CUA_NARROW_PROFILE_KIND,
    schemaVersion: CUA_NARROW_PROFILE_SCHEMA_VERSION,
    capability: CUA_NARROW_CAPABILITY,
    minimumTarget: Object.freeze({
      os: "darwin" as const,
      arch: "arm64" as const,
      minimumMacOSVersion: CUA_NARROW_MINIMUM_MACOS_VERSION,
    }),
    resourceManifest: Object.freeze({
      sha256: readSha256(resourceManifest.sha256, "resourceManifest.sha256"),
      launcherSha256: readSha256(
        resourceManifest.launcherSha256,
        "resourceManifest.launcherSha256",
      ),
    }),
  });
}

export function readCuaNarrowAgentBuildProfile(): unknown {
  return typeof __ZODY_CUA_NARROW_AGENT__ === "undefined" ? undefined : __ZODY_CUA_NARROW_AGENT__;
}
