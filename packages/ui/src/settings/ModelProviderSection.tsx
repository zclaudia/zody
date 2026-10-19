/**
 * fork（F4.5）：官方 Coding Plan / Start Plan / Team Plan 导航、购买与 OAuth 连接方式
 * 编排已删除；设置页只保留 BYOK（自定义 provider）的增删改、排序与连通性测试。
 */
import { useCallback, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import type { SettingsModelProviderTarget } from "@/lib/settingsNavigation.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
import type { ModelProviderNavItem } from "./model-provider-section/constants.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

// 端点建议/模糊匹配的纯函数由本模块对外转发（既有消费方从设置页入口导入）。
export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(() => {
    const providerId = pendingModelProviderTarget?.providerId?.trim();
    if (!providerId) {
      return null;
    }
    // BYOK provider 的导航键固定为 custom:<providerId>；旧官方账号目标不再解析。
    return createCustomProviderNodeKey(providerId);
  });
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  const { navigationGroups, selectedNavItem } = useModelProviderNavigation({
    modelProviders,
    modelProvidersLoading: loading,
    displayOrder,
    selectedNodeKey,
    setSelectedNodeKey,
    intl,
  });

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        await saveProvider(config);
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleSelectNavItem = useCallback((item: ModelProviderNavItem) => {
    setSelectedNodeKey(item.key);
    setTemplatePickerOpen(false);
  }, []);

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(modelProviders, displayOrder).map(
        (provider) => provider.providerId,
      );
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, modelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // 首屏慢网时先渲染布局壳子并展示分组 loading，避免整块设置页空白。
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={false}
      customLoading={customLoading}
      onRefresh={() => {
        void refresh();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={handleSelectNavItem}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => handleCreateProvider({ templateId })}
          onCreateCustom={(label) => handleCreateProvider({ providerName: label })}
        />
      ) : (
        <ModelProviderSectionDetail
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
