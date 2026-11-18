// 只约束本次构建选择；资源 manifest 与环境变量不能创建新的代码身份信任根。
import { NarrowResourceError } from "./macos-cua-narrow-resources-base.mjs";
import { resolveIdentityProfileName } from "./macos-cua-narrow-identity-profile.mjs";

export function assertMacosCuaReleaseRequest({ identityProfile, manifestPath, targetPlatform }) {
  if (identityProfile !== "developer-id") return;
  if (targetPlatform.os !== "darwin" || targetPlatform.arch !== "arm64")
    throw new NarrowResourceError(
      "narrow-target-unsupported",
      "Developer ID CUA requires darwin/arm64",
    );
  if (!manifestPath)
    throw new NarrowResourceError(
      "narrow-release-manifest-required",
      "Developer ID CUA requires an explicit prepared manifest; local default inputs cannot be used",
    );
}

export function assertMacosCuaSigningSelection({ env, validated }) {
  const requested = resolveIdentityProfileName(env.ZODY_CUA_NARROW_IDENTITY_PROFILE);
  if (requested !== "developer-id" && !(validated && env.ZODY_ENABLE_MAC_SIGN === "1")) return;
  const pins = validated?.pins;
  const signer = env.APPLE_SIGNING_IDENTITY || env.CSC_NAME;
  // 修复依据：只签外层会把本地自签 Helper 装入正式包，必须在签名前阻断这种混装。
  if (
    requested !== "developer-id" ||
    pins?.identityProfile !== "developer-id" ||
    env.ZODY_ENABLE_MAC_SIGN !== "1" ||
    !signer ||
    !/^[A-Z0-9]{10}$/.test(pins.teamIdentifier) ||
    !signer.endsWith(` (${pins.teamIdentifier})`) ||
    (signer.includes(":") && !signer.startsWith("Developer ID Application: "))
  )
    throw new NarrowResourceError(
      "narrow-release-signing-required",
      "Developer ID CUA requires configured release inputs and an enabled matching Developer ID Application signer",
    );
}
