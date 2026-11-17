// Shared build-time defaults for the distributable arm64/macOS CUA narrow build.
// 2026-11-16：默认输入切到已验收R2 AX资源的本地冻结归档；仅更新构建输入pin。
// 证书leaf/DR/Node身份及runtime授权不变。归档尚未上传，异机还原需显式提供
// ZODY_CUA_NARROW_FROZEN_ARCHIVE；不把尚不存在的远程release当成可用材料。
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { NarrowResourceError, sha256Bytes } from "./macos-cua-narrow-resources-base.mjs";
import { NARROW_MANIFEST_ENV, REPO_ROOT } from "./macos-cua-narrow-resources-constants.mjs";
import { validateNarrowManifest } from "./macos-cua-narrow-resources-validate.mjs";
import { createNormalHostNarrowProfile } from "./lib/normal-host-candidate-profile.mjs";

export const NARROW_AGENT_ENV = "ZODY_CUA_NARROW_AGENT_JSON";

// 2026-11-09 重建轮：sealed 快照已用当前源码（Zody Protocol + rev43）重建并
// 通过四项验收，默认装配恢复启用。历史：同日晚间曾因协议漂移事故回撤（见
// specs/computer-use-macos-phase1.md 对应小节）。
export const CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED = true;

export const CUA_NARROW_FROZEN_RESTORE_HINT =
  "pnpm --dir packages/desktop run fetch:cua-narrow-frozen";

export const CUA_DEMO_DEFAULT_PUBLIC_FACTS = Object.freeze({
  // 唯一默认装配输入：R2 prepared原字节及stage相对路径，身份pins随本地归档携带。
  // 旧pin已记录到本轮rollback，当前更改不更新已安装App或授予控制权限。
  manifestRelativePath: "output/cua-narrow-frozen/controller-prepared/manifest.json",
  manifestSha256: "9bcea0ea2e21d81a7f4f930a24672839e14ad17b43f29cfaf33b5bf47371cfcd",
});

function normalizeTargetOs(rawOs) {
  const value = String(rawOs ?? "").toLowerCase();
  if (value === "mac" || value === "macos" || value === "darwin" || value === "osx") {
    return "darwin";
  }
  if (value === "win" || value === "windows") return "win32";
  return value;
}

function normalizeTargetArch(rawArch) {
  const value = String(rawArch ?? "").toLowerCase();
  if (value === "amd64" || value === "x86_64") return "x64";
  if (value === "aarch64") return "arm64";
  return value;
}

export function isCuaDemoDefaultTarget(targetOs, targetArch) {
  return normalizeTargetOs(targetOs) === "darwin" && normalizeTargetArch(targetArch) === "arm64";
}

function readExplicitManifestPath({ cliManifestPath, env }) {
  const cliProvided = cliManifestPath !== undefined && cliManifestPath !== null;
  const cliPath = typeof cliManifestPath === "string" ? cliManifestPath.trim() : null;
  if (cliProvided && !cliPath) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      "cua-narrow manifest path must not be empty",
    );
  }
  const envPath = env[NARROW_MANIFEST_ENV]?.trim() || null;
  if (cliPath && envPath && resolve(cliPath) !== resolve(envPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-conflict",
      `conflicting cua-narrow manifests: CLI=${cliPath} env=${envPath}`,
    );
  }
  const manifestPath = cliPath ?? envPath;
  if (!manifestPath) return null;
  if (!isAbsolute(manifestPath)) {
    throw new NarrowResourceError(
      "narrow-manifest-required-absolute",
      `cua-narrow manifest must be an absolute path: ${manifestPath}`,
    );
  }
  return resolve(manifestPath);
}

function readExplicitProfile(env) {
  const profileJson = env[NARROW_AGENT_ENV]?.trim();
  if (!profileJson) return null;
  let profile;
  try {
    profile = JSON.parse(profileJson);
  } catch (error) {
    throw new NarrowResourceError(
      "cua-demo-profile-json",
      `${NARROW_AGENT_ENV} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    throw new NarrowResourceError(
      "cua-demo-profile-json",
      `${NARROW_AGENT_ENV} must be a JSON object`,
    );
  }
  return { profile, profileJson };
}

function assertProfileMatchesManifest(profile, validated) {
  const expectedManifestSha256 = validated.manifestSha256;
  const expectedLauncherSha256 = validated.identity?.signedBinarySha256;
  if (
    profile?.resourceManifest?.sha256 !== expectedManifestSha256 ||
    profile?.resourceManifest?.launcherSha256 !== expectedLauncherSha256
  ) {
    throw new NarrowResourceError(
      "cua-demo-profile-manifest-conflict",
      "explicit cua-narrow profile does not match the selected resource manifest",
      {
        expectedManifestSha256,
        profileManifest: profile?.resourceManifest,
      },
    );
  }
}

async function readPinnedBytes(path, label, expectedSha256) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new NarrowResourceError(
      "cua-demo-default-resource-missing",
      `enabled darwin/arm64 CUA build is missing ${label}: ${path}; restore the frozen archive first via ${CUA_NARROW_FROZEN_RESTORE_HINT}`,
      { path, cause: error?.code },
    );
  }
  const observedSha256 = sha256Bytes(bytes);
  if (observedSha256 !== expectedSha256) {
    throw new NarrowResourceError(
      "cua-demo-default-pin-mismatch",
      `enabled darwin/arm64 CUA build ${label} does not match the pinned digest: ${path}`,
      { path, observedSha256, expectedSha256 },
    );
  }
  return bytes;
}

async function resolveDefaultSelection({ env, repoRoot, targetPlatform, validateManifest, defaultFacts }) {
  const manifestPath = resolve(repoRoot, defaultFacts.manifestRelativePath);
  await readPinnedBytes(
    manifestPath,
    "cua-narrow manifest",
    defaultFacts.manifestSha256,
  );

  const validated = await validateManifest({
    manifestPath,
    targetPlatform,
    env,
  });
  const prepared = await createNormalHostNarrowProfile({
    narrowManifest: manifestPath,
  });
  const profile = prepared.profile;
  if (profile.resourceManifest.sha256 !== defaultFacts.manifestSha256) {
    throw new NarrowResourceError(
      "cua-demo-default-pin-mismatch",
      "enabled darwin/arm64 CUA profile does not match the pinned manifest digest",
    );
  }

  return {
    source: "default",
    manifestPath,
    manifestSha256: validated.manifestSha256,
    launcherSha256: validated.identity.signedBinarySha256,
    validated,
    profile,
    profileJson: JSON.stringify(profile),
  };
}

export async function resolveMacosCuaDemoBuildSelection({
  cliManifestPath = null,
  env = process.env,
  targetOs,
  targetArch,
  repoRoot = REPO_ROOT,
  validateManifest = validateNarrowManifest,
  // 构建期注入（测试用）：默认选择读取的 pin 事实。产品路径恒为模块常量。
  defaultFacts = CUA_DEMO_DEFAULT_PUBLIC_FACTS,
  // 构建期注入（测试用）：默认装配开关。产品路径恒为模块常量。
  defaultAssemblyEnabled = CUA_NARROW_DEFAULT_ASSEMBLY_ENABLED,
} = {}) {
  const observedTargetOs = targetOs ?? env.ZODY_TARGET_OS ?? process.platform;
  const observedTargetArch = targetArch ?? env.ZODY_TARGET_ARCH ?? process.arch;
  const normalizedOs = normalizeTargetOs(observedTargetOs);
  const normalizedArch = normalizeTargetArch(observedTargetArch);
  const targetPlatform = { os: normalizedOs, arch: normalizedArch };
  const manifestPath = readExplicitManifestPath({ cliManifestPath, env });
  const explicitProfile = readExplicitProfile(env);
  const absoluteRepoRoot = resolve(repoRoot);

  if (manifestPath) {
    const validated = await validateManifest({ manifestPath, targetPlatform, env });
    if (explicitProfile) assertProfileMatchesManifest(explicitProfile.profile, validated);
    return {
      source: "explicit",
      manifestPath,
      manifestSha256: validated.manifestSha256,
      launcherSha256: validated.identity.signedBinarySha256,
      validated,
      profile: explicitProfile?.profile ?? null,
      profileJson: explicitProfile?.profileJson ?? null,
    };
  }

  if (explicitProfile) {
    return {
      source: "explicit",
      manifestPath: null,
      manifestSha256: null,
      launcherSha256: null,
      validated: null,
      profile: explicitProfile.profile,
      profileJson: explicitProfile.profileJson,
    };
  }

  if (!isCuaDemoDefaultTarget(normalizedOs, normalizedArch)) return null;
  // 止血回撤：开关关闭时不做默认装配（返回 null = 不注入 profile、不带资源），
  // 显式 manifest/profile 输入不受影响。重建轮验收后翻回模块常量。
  if (!defaultAssemblyEnabled) return null;
  return resolveDefaultSelection({
    env,
    repoRoot: absoluteRepoRoot,
    targetPlatform,
    validateManifest,
    defaultFacts,
  });
}

export function createMacosCuaDemoBuildEnv(selection) {
  if (!selection) return {};
  return {
    ...(selection.manifestPath ? { [NARROW_MANIFEST_ENV]: selection.manifestPath } : {}),
    ...(selection.profileJson ? { [NARROW_AGENT_ENV]: selection.profileJson } : {}),
  };
}
