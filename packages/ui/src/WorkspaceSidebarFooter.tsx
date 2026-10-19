import type { Locale } from "@zcode/shared";
import { memo, useState, type ReactNode } from "react";
import { TID_LOGIN_TRIGGER, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { ChevronUp, Settings } from "lucide-react";
import { ZCODER_BRAND_NAME, zcoderLogoUrl } from "@/brand.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { Theme } from "@/useTheme.js";
import { WorkspaceSidebarFooterPreferences } from "@/WorkspaceSidebarFooterPreferences.js";
import { WorkspaceWebRemoteControlTrigger } from "@/WorkspaceWebRemoteControlTrigger.js";

/**
 * 侧栏左下：zcoder 品牌触发器 + 偏好面板（方案 1A，spec: docs/ui/workspace-sidebar-footer.md）。
 * fork（F4.1b / F4.7）：官方账号下线后 UI 不再持有 UserInfo，头像、Connect 文案与账号头部
 * （昵称、用户 ID 复制）一并删除。
 */
export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  settingsButtonMode = "settings",
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  isDesktop = false,
  banner,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  settingsButtonMode?: "settings" | "back";
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  banner?: ReactNode;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}>
      {banner}
      <div className="flex min-w-0 gap-2">
        <Popover open={preferencesOpen} onOpenChange={setPreferencesOpen}>
          <PopoverTrigger asChild>
            {/* data-testid 沿用历史 TID_LOGIN_TRIGGER 以保持 E2E 选择器稳定，不代表登录语义。 */}
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="-ml-2 min-w-0 flex-1 justify-start gap-2.5 overflow-hidden rounded-lg px-2 data-[state=open]:bg-hover"
              data-testid={TID_LOGIN_TRIGGER}
              aria-label={intl.formatMessage({ id: "sidebar.preferences.title" })}
            >
              <img src={zcoderLogoUrl} alt="" width={24} height={24} className="size-6 shrink-0" />
              {/* Button 默认 whitespace-nowrap；文本列允许收缩，避免窄侧栏被撑出。 */}
              <span className="min-w-0 flex-1 truncate text-left text-ui-base font-semibold text-foreground">
                {ZCODER_BRAND_NAME}
              </span>
              <ChevronUp className="size-3.5 shrink-0 text-foreground-subtle" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-72 max-w-[calc(100vw-2rem)] gap-0 p-1.5"
          >
            <WorkspaceSidebarFooterPreferences
              theme={theme}
              localeMenuValue={localeMenuValue}
              onLocaleChange={onLocaleChange}
              onThemeChange={onThemeChange}
              isDesktop={isDesktop}
            />
          </PopoverContent>
        </Popover>
        <div className="flex shrink-0 items-center gap-1.5">
          {isDesktop && workspacePath ? (
            <WorkspaceWebRemoteControlTrigger
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              remoteSessionId={workspaceRemoteSessionId}
              initialTaskId={activeTaskId ?? undefined}
              compact
            />
          ) : null}
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
