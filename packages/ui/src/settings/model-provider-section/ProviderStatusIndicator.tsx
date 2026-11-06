import { CircleIcon } from "lucide-react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";

const presentation = {
  disabled: { label: "settings.modelProvider.disabledStatus", color: "text-foreground-subtlest" },
  unavailable: { label: "settings.modelProvider.unavailableStatus", color: "text-warning" },
  ready: { label: "settings.modelProvider.readyStatus", color: "text-success" },
} as const;

export function ProviderStatusIndicator({
  provider,
  inline = false,
}: {
  provider?: Pick<ProviderSettingsFormProvider, "enabled" | "executable"> | null;
  /** 手机完整文字列表把状态点放回行内，避免命中窄图标栏时的绝对定位规则。 */
  inline?: boolean;
}) {
  const { intl } = useZodyIntl();
  // 只做展示映射，不能在 UI 再检查 Key、权益或模型成员。
  const status =
    provider?.enabled === false ? "disabled" : provider?.executable ? "ready" : "unavailable";
  const { label, color } = presentation[status];
  return (
    <CircleIcon
      data-provider-status={status}
      aria-label={intl.formatMessage({ id: label })}
      className={`size-2 shrink-0 fill-current ${
        inline ? "" : "max-md:absolute max-md:right-1 max-md:bottom-1 max-md:rounded-full max-md:ring-2 max-md:ring-card"
      } ${color}`}
    />
  );
}
