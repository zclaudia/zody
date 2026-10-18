import type { IServiceAccessor } from "@zcode/services";
import type { OAuthProviderId } from "@zcode/shared";
import { resolveProviderFamilyDomainFromOAuthProvider } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { ModelProviderFamilyConnectionSelection } from "@/lib/modelProviderFamilyConnectionSelection.js";

/**
 * fork（F4.5）：官方 Coding Plan / Start Plan 权益与企业 pricing 查询已删除，
 * 登录/启动后不再自动推导官方套餐连接。保留已保存连接，文件由 F4.7 统一删除。
 */
export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) return null;
  try {
    await params.services.providerSettingsService.refresh("oauth-login-entitlement");
  } catch (error) {
    logger.warn("[Root] 刷新登录后 Provider 状态失败", { error });
  }
  const settings = await params.services.settingService.get();
  return settings.providerFamilyConnectionSelections?.[domain] ?? null;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  return null;
}
