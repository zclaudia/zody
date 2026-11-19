import { ZODY_BRAND_NAME, zodyLogoUrl } from "@/brand.js";
import { useEffect, useState } from "react";
import { logger } from "@/logger.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { resolveWorkspaceShellPanelRadiusPx } from "@/app-shell/workspaceShellWindowChrome.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";

export function OccupationOnboardingVisual({
  isMacDesktop,
  isWindowsDesktop,
}: {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const platform = usePlatform();
  const [macOSMajorVersion, setMacOSMajorVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!isMacDesktop || !platform.getDesktopWindowChromeState) return;
    let disposed = false;
    // 系统版本在会话内固定；复用主界面的版本查询和圆角规则，未知版本沿用其保守值。
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed) setMacOSMajorVersion(state.macOSMajorVersion ?? null);
      },
      (error) => logger.warn("[onboarding] 读取窗口圆角信息失败", { error }),
    );
    return () => {
      disposed = true;
    };
  }, [isMacDesktop, platform]);
  const borderRadius = resolveWorkspaceShellPanelRadiusPx({
    isMacDesktop,
    isWindowsDesktop,
    macOSMajorVersion,
  });
  const { intl } = useZodyIntl();
  return (
    <aside
      style={{ borderRadius }}
      className="zody-brand-grid relative hidden min-h-0 flex-col overflow-y-auto border border-brand-panel-line bg-brand-panel px-12 py-12 text-brand-panel-foreground lg:flex xl:px-16"
    >
      <div className="flex items-center gap-2.5 font-mono text-ui-lg font-semibold tracking-tight">
        <img src={zodyLogoUrl} alt="" width={36} height={36} className="size-9 shrink-0" />
        {ZODY_BRAND_NAME}
      </div>
      <div className="my-auto flex w-full max-w-md shrink-0 flex-col items-start gap-5 py-10">
        <div aria-hidden="true" className="h-1 w-10 rounded-full bg-brand-panel-accent" />
        <h2 className="text-ui-display font-semibold leading-tight tracking-tight">
          {intl.formatMessage({ id: "occupationOnboarding.heroTitle" })}
        </h2>
        <p className="text-ui-base leading-relaxed text-brand-panel-muted">
          {intl.formatMessage({ id: "occupationOnboarding.heroDescription" })}
        </p>
      </div>
    </aside>
  );
}
