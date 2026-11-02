import { Settings, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 已连接手机首页与聊天页共用的设置入口。
 *
 * 只保留一个“设置”动作，统一进入现有 SettingsPage；手机连接配置作为该页面的
 * 平台可见分区出现，不再在菜单里提供第二个“连接设置”入口。
 */
export function WebRemoteControlMobileSettingsMenu({
  className,
  onOpenAppSettings,
}: {
  className?: string;
  onOpenAppSettings?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (!onOpenAppSettings) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn("size-11", className)}
          aria-label={intl.formatMessage({ id: "webRemoteControl.mobileSettings.trigger" })}
        >
          <Settings className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem className="min-h-11" onSelect={onOpenAppSettings}>
          <Settings2 className="size-4" />
          {intl.formatMessage({ id: "webRemoteControl.mobileSettings.trigger" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
