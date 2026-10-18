import type { ModelSelectionView } from "@zcode/services";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

// fork（F4.1b）：resolveLoginApiKeyDefaultProvider / resolveLoginApiKeyTemplateId /
// resolveLoginApiKeyProviderLabel / resolveLoginApiKeyProviderFamilyDomain /
// buildLoginApiKeySkipSettings / resolveHydratedLoginApiKeyValue 随官方账号入口摘除
// （zai/bigmodel 硬编码选择、providerFamilyDomain 写入、旧表单回填）一并删除；
// API Key 模板列表改由 Host providerTemplates 驱动。

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  // fork（F4.1b）：模板的 apiKeyManagementUrl 在 provider schema 中 nullable().optional()
  // （provider-data-schema），实际取值为 string | null | undefined；Boolean() 已兼容 null。
  apiKeyUrl: string | null | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
