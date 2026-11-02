// Shared build-time defaults for the tested arm64/macOS self-use CUA demo.
// This module only selects public build inputs and emits a fixed Host profile/resource
// selection. Runtime eligibility, native confirmation, and Stop remain owned elsewhere.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import {
  NarrowResourceError,
  sha256Bytes,
} from "./macos-cua-narrow-resources-base.mjs";
import {
  NARROW_MANIFEST_ENV,
  REPO_ROOT,
} from "./macos-cua-narrow-resources-constants.mjs";
import { validateNarrowManifest } from "./macos-cua-narrow-resources-validate.mjs";
import { createNormalHostNarrowProfile } from "./lib/normal-host-candidate-profile.mjs";

export const NARROW_AGENT_ENV = "ZCODE_CUA_NARROW_AGENT_JSON";

export const CUA_DEMO_DEFAULT_PUBLIC_FACTS = Object.freeze({
  testedTarget: Object.freeze({ os: "darwin", arch: "arm64", macOSVersion: "26.6.2" }),
  workspaceRelativePath: ".",
  // 中文注释：App 内确认弹窗轮次（cua-inapp-confirm）替换 pin。W8 标准权限策略轮次
  // （允许一次/总是允许/Full access/拒绝）只改动了 CLI core/bootstrap 与 UI，sealed
  // host/cli/session entry 输入随之变化；native 源自 W6 后未变，Helper 二进制 hash 的
  // 变化仅来自 pins 头文件内嵌的 entry SHA-256。签名身份（证书 leaf、DR、Node CDHash）
  // 沿用 round11 冻结 pins，未做任何改动。
  // 2026-10-31 图标轮（cua-app-icon）v4：builder 给 Helper bundle 增补
  // CFBundleIconFile + Contents/Resources/AppIcon.icns（主应用图标原样复制，仅展示资源）。
  // 相比 v3：host-entry 与 Node 不变；cli/session entry 随当日工作区源码（mobile-remote
  // 等未提交改动）重新封装，Helper 二进制 hash 变化仅来自 pins 头内嵌 entry SHA-256 与
  // plist/资源清单；签名身份沿用 round11 冻结 pins，未做任何改动。
  manifestRelativePath: "output/cua-app-icon/controller-prepared/manifest.json",
  // 中文注释：用户在本轮开工前修改了 provider 注册表（新增/调整条目），默认选择
  // （deepseek/deepseek-flash max）与网络摘要未变，但 providerRevisionSha256 变为
  // 545008f5…，旧 snapshot pin 触发了设计内的 provider-revision-mismatch 回退。
  // 这里按同一测量语义重新固定 Host 于 2026-10-31 18:12 实测记录的当前配置快照。
  startupSnapshotRelativePath: "output/cua-inapp-confirm/startup-snapshot-current.json",
  manifestSha256: "48a657bb2883ed18801dd52e13425c360e03c90ae2f66f1f6f77231108af1a10",
  startupSnapshotSha256: "754d672286692bea5933d8a3ae33935fbb94b05f0ca56ff78995fe31e8ded2e9",
  providerRevisionSha256: "545008f54fef4247ffcaaa7772eebba31d475cca2b0abc7d869a18fcf142a4a2",
  providerSelection: Object.freeze({
    providerId: "deepseek",
    modelId: "deepseek-flash",
    options: Object.freeze({ reasoningLevel: "max" }),
  }),
  networkDigestSha256: "b00aea09d9ade210b21d3acefe42819409f10b035a0779f48d550f77ec55d5fa",
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
        expectedLauncherSha256,
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
      `enabled darwin/arm64 CUA build is missing ${label}: ${path}`,
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

async function resolveDefaultSelection({ env, repoRoot, targetPlatform, validateManifest }) {
  const manifestPath = resolve(repoRoot, CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestRelativePath);
  const startupSnapshotPath = resolve(
    repoRoot,
    CUA_DEMO_DEFAULT_PUBLIC_FACTS.startupSnapshotRelativePath,
  );
  await readPinnedBytes(
    manifestPath,
    "cua-narrow manifest",
    CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256,
  );
  await readPinnedBytes(
    startupSnapshotPath,
    "startup snapshot",
    CUA_DEMO_DEFAULT_PUBLIC_FACTS.startupSnapshotSha256,
  );

  const validated = await validateManifest({
    manifestPath,
    targetPlatform,
    env,
  });
  const prepared = await createNormalHostNarrowProfile({
    narrowManifest: manifestPath,
    workspaceAllowlist: [repoRoot],
    startupSnapshot: startupSnapshotPath,
    testedMacOSVersion: CUA_DEMO_DEFAULT_PUBLIC_FACTS.testedTarget.macOSVersion,
  });
  const profile = prepared.profile;
  const expectedSelection = CUA_DEMO_DEFAULT_PUBLIC_FACTS.providerSelection;
  const observedSelection = profile.provider.selection;
  if (
    profile.resourceManifest.sha256 !== CUA_DEMO_DEFAULT_PUBLIC_FACTS.manifestSha256 ||
    profile.provider.revisionSha256 !==
      CUA_DEMO_DEFAULT_PUBLIC_FACTS.providerRevisionSha256 ||
    observedSelection.providerId !== expectedSelection.providerId ||
    observedSelection.modelId !== expectedSelection.modelId ||
    observedSelection.options?.reasoningLevel !== expectedSelection.options.reasoningLevel ||
    profile.network.digestSha256 !== CUA_DEMO_DEFAULT_PUBLIC_FACTS.networkDigestSha256
  ) {
    throw new NarrowResourceError(
      "cua-demo-default-pin-mismatch",
      "enabled darwin/arm64 CUA profile does not match the pinned public startup facts",
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
} = {}) {
  const observedTargetOs = targetOs ?? env.ZCODE_TARGET_OS ?? process.platform;
  const observedTargetArch = targetArch ?? env.ZCODE_TARGET_ARCH ?? process.arch;
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
  return resolveDefaultSelection({
    env,
    repoRoot: absoluteRepoRoot,
    targetPlatform,
    validateManifest,
  });
}

export function createMacosCuaDemoBuildEnv(selection) {
  if (!selection) return {};
  return {
    ...(selection.manifestPath ? { [NARROW_MANIFEST_ENV]: selection.manifestPath } : {}),
    ...(selection.profileJson ? { [NARROW_AGENT_ENV]: selection.profileJson } : {}),
  };
}
