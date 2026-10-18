import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

/**
 * fork（F4.5）：官方 Coding Plan / Start Plan 品牌入口、连接方式与额度状态类型已删除，
 * 模型提供方导航只保留通用 provider（preset 载体的自定义 provider 列表）与自定义分组。
 */
export type ModelProviderNavItem =
  | {
      key: string;
      type: "preset";
      /** 品牌入口图标。 */
      logo?: ProviderSettingsFormProvider["config"]["logo"];
      /** 状态圆点展示的 provider。 */
      statusProvider?: ProviderSettingsFormProvider | null;
      label: string;
      provider: ProviderSettingsFormProvider | null;
      displayName: string;
      statusActive: boolean;
    }
  | {
      key: string;
      type: "custom";
      label: string;
      provider: ProviderSettingsFormProvider;
      statusActive: boolean;
    };

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  return getProviderFormLabel(provider);
}
