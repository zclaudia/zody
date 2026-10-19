import { useEffect, useMemo } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ModelProviderNavGroup,
  ModelProviderNavItem,
} from "@/settings/model-provider-section/constants.js";
import { createCustomProviderNodeKey } from "@/settings/model-provider-section/utils.js";
import {
  sortModelProvidersForDisplay,
  type ProviderOrderView,
} from "@/lib/modelProviderOrdering.js";

interface UseModelProviderNavigationOptions {
  modelProviders: ProviderSettingsFormProvider[];
  modelProvidersLoading?: boolean;
  displayOrder?: ProviderOrderView;
  selectedNodeKey: string | null;
  setSelectedNodeKey: (key: string | null) => void;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}

/**
 * fork（F4.5）：官方 Coding Plan / Start Plan / Team Plan 导航项与连接方式切换已删除。
 * 导航只剩自定义（BYOK）provider 分组；预置品牌入口已随官方账号下线（F4.1b）。
 */
export function useModelProviderNavigation({
  modelProviders,
  modelProvidersLoading = false,
  displayOrder,
  selectedNodeKey,
  setSelectedNodeKey,
  intl,
}: UseModelProviderNavigationOptions) {
  const customProviders = useMemo(() => {
    const allCustomProviders = modelProviders.filter(
      (provider) => provider.config.group === "standard-personal",
    );
    // 这里复用模型菜单的展示排序，确保设置页和聊天框供应商顺序一致。
    return sortModelProvidersForDisplay(allCustomProviders, displayOrder);
  }, [displayOrder, modelProviders]);

  const navigationGroups = useMemo<ModelProviderNavGroup[]>(
    () => [
      {
        id: "custom",
        title: intl.formatMessage({ id: "settings.modelProvider.customTitle" }),
        items: customProviders.map((provider) => ({
          key: createCustomProviderNodeKey(provider.providerId),
          type: "custom" as const,
          label: getProviderFormLabel(provider),
          provider,
          statusActive: provider.executable === true,
        })),
      },
    ],
    [customProviders, intl],
  );

  const navigationItems = useMemo(
    () => navigationGroups.flatMap((group) => group.items),
    [navigationGroups],
  );

  const navigationItemByKey = useMemo(
    () => new Map(navigationItems.map((item) => [item.key, item])),
    [navigationItems],
  );

  const selectedNavItem: ModelProviderNavItem | null =
    selectedNodeKey && !modelProvidersLoading
      ? (navigationItemByKey.get(selectedNodeKey) ?? null)
      : null;

  const fallbackNodeKey = navigationItems[0]?.key ?? null;
  useEffect(() => {
    if (modelProvidersLoading) {
      return;
    }
    const hasSelectedNode = selectedNodeKey
      ? navigationItemByKey.has(selectedNodeKey)
      : false;
    if (hasSelectedNode) {
      return;
    }
    if (selectedNodeKey !== fallbackNodeKey) {
      setSelectedNodeKey(fallbackNodeKey);
    }
  }, [
    fallbackNodeKey,
    modelProvidersLoading,
    navigationItemByKey,
    selectedNodeKey,
    setSelectedNodeKey,
  ]);

  return {
    navigationGroups,
    navigationItems,
    selectedNavItem,
    navigationUnavailable: false,
  };
}
