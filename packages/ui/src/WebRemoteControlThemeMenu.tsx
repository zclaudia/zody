import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { useZodyStore } from "@/store/StoreProvider.js";
import type { Theme } from "@/useTheme.js";

const MOBILE_THEME_OPTIONS: Theme[] = [
  "system",
  "zai-dark",
  "zai-light",
];

export function WebRemoteControlThemeMenu({ className }: { className?: string }) {
  const { intl } = useZodyIntl();
  const theme = useZodyStore((state) => state.theme);
  const setTheme = useZodyStore((state) => state.setTheme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* home-6/settings-2：触发器内部尺寸（icon-sm，24px 视觉）保持不变，
          由调用方透传命中区类（如 size-11）扩到 ≥44px，适配所在页面的按钮排布。
          本组件只在手机远控壳（StartPage / 任务首页 / 聊天页顶栏）渲染。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={className}
          aria-label={intl.formatMessage({ id: "webRemoteControl.themeMenu.trigger" })}
        >
          <Palette className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (MOBILE_THEME_OPTIONS.includes(value as Theme)) {
              setTheme(value as Theme);
            }
          }}
        >
          {/* settings-2：纯触屏下菜单行原先仅 min-h-7（28px）；本组件是手机专属入口，
            选项行直接抬到 44px 触屏高度，避免与相邻 24px 图标按钮之间误触。 */}
          {MOBILE_THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} className="min-h-11">
              {option === "system"
                ? intl.formatMessage({ id: "sidebar.settings.systemDefault" })
                : intl.formatMessage({ id: `sidebar.settings.theme.${option}` })}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
