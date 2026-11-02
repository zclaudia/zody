// 窄 CUA manifest 相关 API 的稳定入口；实现按准备/校验/身份拆在有限文件中。
export { verifyNarrowApp } from "./macos-cua-narrow-resources-verify-app.mjs";
export { createNarrowManifest } from "./macos-cua-narrow-resources-prepare-core.mjs";
export {
  assertPackagedNarrowResource,
  validateNarrowManifest,
  writeNarrowBuildAudit,
} from "./macos-cua-narrow-resources-validate.mjs";
