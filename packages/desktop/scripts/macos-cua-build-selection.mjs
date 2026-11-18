// 构建入口负责准备；纯选择器仍供 restore 和离线校验使用。
import process from "node:process";
import { ensureCuaNarrowFrozen } from "./macos-cua-auto-prepare.mjs";
import {
  createMacosCuaDemoBuildEnv,
  isCuaDemoDefaultTarget,
  resolveMacosCuaDemoBuildSelection as selectVerified,
} from "./macos-cua-demo-defaults.mjs";
import { NARROW_MANIFEST_ENV } from "./macos-cua-narrow-resources-constants.mjs";

export { createMacosCuaDemoBuildEnv };

export async function resolveMacosCuaDemoBuildSelection(options = {}) {
  const {
    autoPrepare = true,
    ensureFrozenInputs = ensureCuaNarrowFrozen,
    ...selectionOptions
  } = options;
  try {
    return await selectVerified(selectionOptions);
  } catch (error) {
    const env = selectionOptions.env ?? process.env;
    const os = selectionOptions.targetOs ?? env.ZODY_TARGET_OS ?? process.platform;
    const arch = selectionOptions.targetArch ?? env.ZODY_TARGET_ARCH ?? process.arch;
    if (
      !autoPrepare ||
      !isCuaDemoDefaultTarget(os, arch) ||
      selectionOptions.cliManifestPath != null ||
      env[NARROW_MANIFEST_ENV]?.trim() ||
      env.ZODY_CUA_NARROW_AGENT_JSON?.trim() ||
      error?.code !== "cua-demo-default-resource-missing" ||
      error?.details?.cause !== "ENOENT"
    ) {
      throw error;
    }
    await ensureFrozenInputs({ repoRoot: selectionOptions.repoRoot, env });
    return selectVerified(selectionOptions);
  }
}
