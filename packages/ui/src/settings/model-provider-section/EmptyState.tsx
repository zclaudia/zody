/**
 * 空列表时占满原分栏区域，避免留下空白侧栏和分栏分隔线。
 * 添加入口只在页头保留一个，空状态内不再重复主按钮。
 */
import { BoxesIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ModelProviderEmptyState() {
  const { intl } = useZCodeIntl();

  return (
    <div
      className="flex min-h-[26rem] flex-col items-center justify-center gap-4 text-center"
      data-model-provider-empty="true"
    >
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-foreground-subtle"
        aria-hidden="true"
      >
        <BoxesIcon className="size-6" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-ui-lg font-semibold text-foreground" role="status">
          {intl.formatMessage({ id: "settings.modelProvider.empty" })}
        </h2>
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.emptyDescription" })}
        </p>
      </div>
    </div>
  );
}
