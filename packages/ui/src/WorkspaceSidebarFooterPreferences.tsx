/**
 * 侧栏左下偏好面板内容（方案 1A：Labeled rows，spec: docs/ui/workspace-sidebar-footer.md）。
 *
 * 面板不持有偏好状态：主题、语言回写调用方回调，界面模式写 store，缩放执行桌面命令并订阅
 * 平台缩放事件；这里只负责展示与转发。
 */
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Locale } from "@zcode/shared";
import {
  DESKTOP_ZOOM_MAX_LEVEL,
  DESKTOP_ZOOM_MIN_LEVEL,
  DesktopCommandIds,
  resolveDesktopZoomFactorForLevel,
} from "@zcode/shared";
import { Minus, Monitor, Moon, Plus, Sun } from "lucide-react";
import { ZCODER_BRAND_NAME, zcoderLogoUrl } from "@/brand.js";
import { cn } from "@/components/lib/utils.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Separator } from "@/components/ui/separator.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { Theme } from "@/useTheme.js";

interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * 分段单选控件：选中项可 Tab 聚焦，左右（上下）方向键循环移动并立即生效，与原生 radio 一致。
 */
function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}) {
  const selectedIndex = options.findIndex((option) => option.value === value);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const nextIndex = (Math.max(selectedIndex, 0) + step + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 gap-0.5 rounded-md bg-background p-0.5"
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.icon ? option.label : undefined}
            title={option.icon ? option.label : undefined}
            tabIndex={checked || (selectedIndex < 0 && index === 0) ? 0 : -1}
            className={cn(
              "flex h-6 items-center justify-center rounded-sm text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              option.icon ? "w-7.5" : "px-2.5",
              checked
                ? "bg-card font-medium text-foreground shadow-xs"
                : "text-foreground-subtle hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.icon ?? option.label}
          </button>
        );
      })}
    </div>
  );
}

function PreferenceRow({
  pref,
  label,
  children,
}: {
  pref: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="sidebar-preference-row"
      data-pref={pref}
      className="flex h-10 items-center gap-3 px-2"
    >
      <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{label}</span>
      {children}
    </div>
  );
}

/** 仅在桌面端挂载（ZoomStepper 由 isDesktop 守卫），Web 装配不提供缩放能力。 */
function useDesktopZoomLevel(): number {
  const platform = usePlatform();
  const [zoomLevel, setZoomLevel] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 面板按需挂载：初始读取与变化事件可能交错，已收到事件后丢弃较早发起的读取结果，避免旧值覆盖新档位。
    let receivedChange = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!cancelled && !receivedChange && Number.isFinite(state.zoomLevel)) {
        setZoomLevel(state.zoomLevel);
      }
    });
    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        receivedChange = true;
        setZoomLevel(state.zoomLevel);
      }
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);

  return zoomLevel;
}

function ZoomStepper() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const zoomLevel = useDesktopZoomLevel();
  const zoomInShortcut = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcut = useShortcutCommandLabel("zoomOut");
  const resetShortcut = useShortcutCommandLabel("resetZoom");
  const percent = Math.round(resolveDesktopZoomFactorForLevel(zoomLevel) * 100);
  const run = (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
    void platform.executeDesktopCommand(command);
  };
  const withShortcut = (label: string, shortcut: string | null | undefined) =>
    shortcut ? `${label} (${shortcut})` : label;
  const zoomOutLabel = intl.formatMessage({ id: "titleBar.menu.view.zoomOut" });
  const zoomInLabel = intl.formatMessage({ id: "titleBar.menu.view.zoomIn" });
  const resetLabel = intl.formatMessage({ id: "titleBar.menu.view.actualSize" });
  const stepButtonClass =
    "flex size-6 items-center justify-center rounded-sm text-foreground outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-background p-0.5">
      <button
        type="button"
        aria-label={zoomOutLabel}
        title={withShortcut(zoomOutLabel, zoomOutShortcut)}
        disabled={zoomLevel <= DESKTOP_ZOOM_MIN_LEVEL}
        className={stepButtonClass}
        onClick={() => run(DesktopCommandIds.ZoomOut)}
      >
        <Minus className="size-3" />
      </button>
      <button
        type="button"
        data-testid="sidebar-zoom-reset"
        aria-label={resetLabel}
        title={withShortcut(resetLabel, resetShortcut)}
        disabled={zoomLevel === 0}
        className="h-6 min-w-11 rounded-sm font-mono text-ui-sm text-foreground tabular-nums outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        onClick={() => run(DesktopCommandIds.ResetZoom)}
      >
        {`${percent}%`}
      </button>
      <button
        type="button"
        aria-label={zoomInLabel}
        title={withShortcut(zoomInLabel, zoomInShortcut)}
        disabled={zoomLevel >= DESKTOP_ZOOM_MAX_LEVEL}
        className={stepButtonClass}
        onClick={() => run(DesktopCommandIds.ZoomIn)}
      >
        <Plus className="size-3" />
      </button>
    </div>
  );
}

export function WorkspaceSidebarFooterPreferences({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  isDesktop,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  isDesktop: boolean;
}) {
  const { intl } = useZCodeIntl();
  const interfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  const localeLabel = intl.formatMessage({ id: "settings.locale" });

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 px-2 py-2">
        <img src={zcoderLogoUrl} alt="" width={28} height={28} className="size-7 shrink-0" />
        <span className="text-ui-base font-semibold text-foreground">{ZCODER_BRAND_NAME}</span>
      </div>
      <Separator className="my-1" />
      <PreferenceRow pref="theme" label={intl.formatMessage({ id: "settings.themeMode" })}>
        <SegmentedControl<Theme>
          label={intl.formatMessage({ id: "settings.themeMode" })}
          value={theme}
          onChange={onThemeChange}
          options={[
            {
              value: "system",
              label: intl.formatMessage({ id: "sidebar.settings.systemDefault" }),
              icon: <Monitor className="size-3.5" />,
            },
            {
              value: "zai-light",
              label: intl.formatMessage({ id: "sidebar.settings.theme.zai-light" }),
              icon: <Sun className="size-3.5" />,
            },
            {
              value: "zai-dark",
              label: intl.formatMessage({ id: "sidebar.settings.theme.zai-dark" }),
              icon: <Moon className="size-3.5" />,
            },
          ]}
        />
      </PreferenceRow>
      <PreferenceRow pref="locale" label={localeLabel}>
        <Select value={localeMenuValue} onValueChange={onLocaleChange}>
          <SelectTrigger
            size="sm"
            className="w-auto border-0 bg-background"
            aria-label={localeLabel}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="system">
              {intl.formatMessage({ id: "sidebar.settings.systemDefault" })}
            </SelectItem>
            <SelectItem value="en-US">
              {intl.formatMessage({ id: "sidebar.settings.locale.en-US" })}
            </SelectItem>
            <SelectItem value="zh-CN">
              {intl.formatMessage({ id: "sidebar.settings.locale.zh-CN" })}
            </SelectItem>
          </SelectContent>
        </Select>
      </PreferenceRow>
      <PreferenceRow
        pref="interfaceMode"
        label={intl.formatMessage({ id: "settings.interfaceMode" })}
      >
        <SegmentedControl
          label={intl.formatMessage({ id: "settings.interfaceMode" })}
          value={interfaceMode}
          onChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
          options={[
            {
              value: "coding",
              label: intl.formatMessage({ id: "sidebar.preferences.mode.coding" }),
            },
            {
              value: "office",
              label: intl.formatMessage({ id: "sidebar.preferences.mode.office" }),
            },
          ]}
        />
      </PreferenceRow>
      {isDesktop ? (
        <PreferenceRow
          pref="zoom"
          label={intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
        >
          <ZoomStepper />
        </PreferenceRow>
      ) : null}
    </div>
  );
}
