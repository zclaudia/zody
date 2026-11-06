import type { ReactNode } from "react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@zody/shared";
import { cn } from "@/components/lib/utils.js";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { useSettingsPresentation } from "@/settings/SettingsPresentationContext.js";

interface ModelProviderSectionLayoutProps {
  description: string;
  refreshLabel: string;
  loadingLabel: string;
  presetLoading: boolean;
  customLoading: boolean;
  onRefresh: () => void;
  addProviderLabel: string;
  onAddProvider: () => void;
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavGroup["items"][number]) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  /** 空列表时整块展示空状态或模板选择器，不渲染空白侧栏与分栏。 */
  empty?: boolean;
  /** 手机呈现：列表 → 单个 Provider 详情。仅控制显示层，不改 selectedNodeKey 或草稿。 */
  mobileDetailOpen?: boolean;
  /** 手机详情页返回列表（SettingsBreadcrumbReporter 的父级返回动作）。 */
  onCloseMobileDetail?: () => void;
  /** 模板选择器自身投影面包屑；此时不再上报 Provider 详情层级。 */
  mobileTemplateOpen?: boolean;
  children: ReactNode;
}

export function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  return params.presetLoading || params.customLoading;
}

export function ModelProviderSectionLayout({
  description,
  refreshLabel,
  loadingLabel,
  presetLoading,
  customLoading,
  onRefresh,
  addProviderLabel,
  onAddProvider,
  navigationGroups,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  empty = false,
  mobileDetailOpen = false,
  onCloseMobileDetail,
  mobileTemplateOpen = false,
  children,
}: ModelProviderSectionLayoutProps) {
  const { isMobile } = useSettingsPresentation();
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });
  // 手机端面包屑只投影“当前 Provider”，由通用手机 header 负责父级返回；
  // selectedNodeKey 仍归 ModelProviderSection，本组件不缓存第二份选择状态。
  const selectedLabel = navigationGroups
    .flatMap((group) => group.items)
    .find((item) => item.key === selectedNodeKey)?.label;

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "flex gap-3",
          isMobile ? "flex-col items-stretch" : "items-start justify-between",
        )}
      >
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={onRefresh}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        {empty ? (
          <div
            className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
            data-model-provider-detail-scroll="true"
          >
            <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
              {children}
            </ProviderDetailFeedbackBoundary>
          </div>
        ) : isMobile ? (
          <>
            {/* 手机列表与详情都保持挂载，只用 hidden 切换可见性。
                详情表单草稿（名称/Base URL/API Key 等）归 InlineEditableProviderCard 内部状态，
                返回列表时卸载详情会静默丢失草稿；同 key 的反馈边界也不能重建。 */}
            <div
              className={cn("min-w-0", mobileDetailOpen && "hidden")}
              data-model-provider-mobile-list="true"
            >
              <ModelProviderSectionNavigation
                navigationGroups={navigationGroups}
                selectedNodeKey={selectedNodeKey}
                customLoading={customLoading}
                onSelectNavItem={onSelectNavItem}
                onReorderProviderIds={onReorderProviderIds}
                reorderableProviderIds={reorderableProviderIds}
                mobileList
              />
            </div>
            <div
              className={cn(mobileDetailOpen ? "" : "hidden")}
              data-model-provider-mobile-detail="true"
            >
              {/* 只有详情可见时才上报 Provider 层级，隐藏详情不得覆盖列表 header。 */}
              {mobileDetailOpen && selectedLabel && !mobileTemplateOpen ? (
                <SettingsBreadcrumbReporter
                  items={[{ label: selectedLabel }]}
                  onSectionSelect={onCloseMobileDetail}
                />
              ) : null}
              <div
                className="relative min-w-0 p-4 pb-20"
                data-model-provider-detail-scroll="true"
              >
                <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
                  {children}
                </ProviderDetailFeedbackBoundary>
              </div>
            </div>
          </>
        ) : (
          <div
            className="grid min-h-[36rem] grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
            data-model-provider-split-panel="true"
          >
            <div
              className="min-w-0 border-r border-border"
              data-model-provider-navigation-scroll="true"
            >
              <ModelProviderSectionNavigation
                navigationGroups={navigationGroups}
                selectedNodeKey={selectedNodeKey}
                customLoading={customLoading}
                onSelectNavItem={onSelectNavItem}
                onReorderProviderIds={onReorderProviderIds}
                reorderableProviderIds={reorderableProviderIds}
              />
            </div>
            <div
              className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
              data-model-provider-detail-scroll="true"
            >
              <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
                {children}
              </ProviderDetailFeedbackBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
