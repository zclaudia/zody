import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

export interface V4ModelTriggerDisplay {
  fullLabel: string;
  modelLabel: string;
  providerPrefix?: string;
}

export function formatModelChangeLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
  _intl: Pick<IntlInstance, "formatMessage">,
): string {
  // fork（F4.11）：官方账号套餐身份（Individual/Team/Start Plan）随账号体系删除，
  // 历史切换记录不再有套餐后缀；统一按 provider/model 通用格式展示。
  return formatProviderModelLabel(providerId, providerName, modelName);
}

export function formatProviderModelLabel(
  providerId: string | undefined,
  providerName: string | undefined,
  modelName: string,
): string {
  // fork（F4.11）：官方账号内置连接（Z.ai / BigModel 套餐）已删除，不再需要按家族隐藏
  // 内置连接名；BYOK/自定义 provider 统一按 providerName/model 展示。
  const normalizedProviderName = providerName?.trim();
  return normalizedProviderName ? `${normalizedProviderName}/${modelName}` : modelName;
}

export function resolveV4ModelTriggerLabel({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): string {
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return fallbackLabel;
  }

  // 仅当前菜单中存在的连接按 ID 兜底；历史记录的通用格式化保留原有语义。
  return formatProviderModelLabel(
    providerId,
    providerName?.trim() || providerId,
    selectedItem.name,
  );
}

export function resolveV4ModelTriggerDisplay({
  modelGroups,
  normalizedValue,
  fallbackLabel,
  providerId,
  providerName,
}: {
  modelGroups: readonly ModelSelectGroup[];
  normalizedValue: string;
  fallbackLabel: string;
  providerId: string | undefined;
  providerName?: string;
}): V4ModelTriggerDisplay {
  // 把 provider/model 预先拼成单一字符串后，响应式布局只能整段隐藏或依赖
  // 平台 JS 分支裁剪；这里保留结构化前缀，让 composer 容器断点统一决定可见密度。
  const fullLabel = resolveV4ModelTriggerLabel({
    modelGroups,
    normalizedValue,
    fallbackLabel,
    providerId,
    providerName,
  });
  const selectedGroup = modelGroups.find((group) =>
    group.items.some((item) => item.value === normalizedValue),
  );
  const selectedItem = selectedGroup?.items.find((item) => item.value === normalizedValue);
  if (!selectedGroup || !selectedItem) {
    return { fullLabel, modelLabel: fallbackLabel };
  }

  const modelLabel = selectedItem.name;
  const normalizedProviderName = providerName?.trim() || providerId;
  if (!normalizedProviderName) {
    return { fullLabel, modelLabel };
  }

  return {
    fullLabel,
    providerPrefix: `${normalizedProviderName}/`,
    modelLabel,
  };
}
