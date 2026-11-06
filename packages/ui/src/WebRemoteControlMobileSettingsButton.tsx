import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";

/**
 * 已连接手机首页与聊天页共用的设置入口。
 *
 * 只有一个“设置”动作：点击齿轮直接进入现有 SettingsPage，不再先展开单项菜单。
 * 手机连接配置作为该页面的平台可见分区出现，不提供第二个“连接设置”入口。
 */
export function WebRemoteControlMobileSettingsButton({
  className,
  onOpenAppSettings,
}: {
  className?: string;
  onOpenAppSettings?: () => void;
}) {
  const { intl } = useZodyIntl();
  if (!onOpenAppSettings) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className={cn("size-11", className)}
      aria-label={intl.formatMessage({ id: "webRemoteControl.mobileSettings.trigger" })}
      onClick={onOpenAppSettings}
    >
      <Settings className="size-4" />
    </Button>
  );
}
