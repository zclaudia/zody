export interface E2EStartupCredentialSeedOptions {
  specs?: string[];
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}

// F4.1c：E2E 基座默认「无官方账号」——credentials.json 一律空凭据启动，模型来源只有
// wdio.conf seedUpstreamE2EModelConfig 种入的本地桩 BYOK provider。
// fork（F4.7）：OAuth/JWT 专项 spec 已随账号链删除，仅保留「旧版本升级」场景的
// 官方账号存量种子，供 Host 启动迁移在真实启动路径上清理（spec 断言清理后的最终态）。
const OFFICIAL_ACCOUNT_SEED_OAUTH_ONLY_SPEC_NAMES = new Set([
  "official-account-removal-upgrade.test.ts",
]);

export function createE2EStartupCredentialSeed(
  options: E2EStartupCredentialSeedOptions,
): Record<string, string> {
  const specFileName = (spec: string) => spec.replaceAll("\\", "/").split("/").at(-1);
  const requiresOfficialAccountSeed =
    options.specs?.some((spec) => {
      const fileName = specFileName(spec);
      return fileName !== undefined && OFFICIAL_ACCOUNT_SEED_OAUTH_ONLY_SPEC_NAMES.has(fileName);
    }) ?? false;
  if (!requiresOfficialAccountSeed) {
    // F4.1c 修复依据：基座默认不得携带官方账号身份。空凭据同时避免假 JWT 访问真实
    // 控制面触发 401 弹窗遮挡被测交互。
    return {};
  }
  const restoredOAuthCredentials = { ...options.restoredOAuthCredentials };
  // 升级场景只需要 OAuth 展示态；不注入 JWT，避免访问真实套餐接口弹登录失效提示。
  delete restoredOAuthCredentials.zcodejwttoken;
  return {
    auth_token: options.legacyAuthToken,
    ...restoredOAuthCredentials,
  };
}
