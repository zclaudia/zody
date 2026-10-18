import { isRequestSecuritySpec } from "./request-security-edition/index.js";
export interface E2EStartupCredentialSeedOptions {
  specs?: string[];
  legacyAuthToken: string;
  restoredOAuthCredentials: Record<string, string>;
}

// F4.1c：E2E 基座默认「无官方账号」——credentials.json 一律空凭据启动，模型来源只有
// wdio.conf seedUpstreamE2EModelConfig 种入的本地桩 BYOK provider。仅下列仍在待删清单
// （test/e2e/pending-official-account-removal.txt）里的 spec 保留官方账号种子，
// 由对应删除任务随 spec 一起移除。
//
// 级别 2（OAuth + 旧式 JWT/auth_token）：断言直接依赖登录态/JWT 契约的认证与领取专项。
const OFFICIAL_ACCOUNT_SEED_WITH_JWT_SPEC_NAMES = new Set([
  // fork（F4.4）：marketing-touch-entitlement / marketing-touch-rewards 随营销 spec 删除。
  "jwt-401-auto-logout.test.ts",
  "provider-family-responsive.test.ts",
]);
// 级别 1（仅 OAuth 展示态，不带 zcodejwttoken——假 JWT 打到未 mock 的官方路径会 401
// 弹登录过期框，历史合并时已按此隔离）：Coding Plan 团队/升级 spec 走本地 team mock，
// 只需要 bigmodel 账号展示态。fork（F4.1a）：「旧版本升级」场景也种官方账号存量，
// 供 Host 启动迁移在真实启动路径上清理（spec 断言清理后的最终态）。
const OFFICIAL_ACCOUNT_SEED_OAUTH_ONLY_SPEC_NAMES = new Set([
  "official-account-removal-upgrade.test.ts",
]);

export function createE2EStartupCredentialSeed(
  options: E2EStartupCredentialSeedOptions,
): Record<string, string> {
  const specFileName = (spec: string) => spec.replaceAll("\\", "/").split("/").at(-1);
  const requiresZCodeJwt = options.specs?.some((spec) => {
    const fileName = specFileName(spec);
    return (
      fileName !== undefined &&
      // request-security 专项已在 F2 阶段被置空（isRequestSecuritySpec 恒 false），
      // 保留判断仅为兼容残留调用。
      (OFFICIAL_ACCOUNT_SEED_WITH_JWT_SPEC_NAMES.has(fileName) || isRequestSecuritySpec(fileName))
    );
  });
  const requiresOfficialAccountSeed =
    requiresZCodeJwt ||
    options.specs?.some((spec) => {
      const fileName = specFileName(spec);
      return fileName !== undefined && OFFICIAL_ACCOUNT_SEED_OAUTH_ONLY_SPEC_NAMES.has(fileName);
    }) ||
    false;
  if (!requiresOfficialAccountSeed) {
    // F4.1c 修复依据：基座默认不得携带官方账号身份。空凭据同时避免假 JWT 访问真实
    // 控制面触发 401 弹窗遮挡被测交互（与历史 PERSONAL_PROVIDER_ONLY/ACCOUNTLESS
    // 白名单的动机一致，只是把「白名单例外」翻转成「默认行为」）。
    return {};
  }
  const restoredOAuthCredentials = { ...options.restoredOAuthCredentials };
  // 合并时遗漏了普通 E2E 的 JWT 隔离：假的 JWT 会访问真实套餐接口并弹出登录失效提示。
  // 保留 OAuth 展示态；只有认证专项、本地 mock 的领取与响应式用例需要 JWT。
  if (!requiresZCodeJwt) delete restoredOAuthCredentials.zcodejwttoken;
  return {
    auth_token: options.legacyAuthToken,
    ...restoredOAuthCredentials,
  };
}
