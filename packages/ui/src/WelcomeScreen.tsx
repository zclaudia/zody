/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen —— 首启 BYOK（自带 API Key）provider 配置引导。
 *
 * fork（F4.1b）：官方账号入口摘除后，本页不再提供 OAuth 登录区（z.ai / BigModel
 * 账号登录、等待与错误态、loginEntryRequest 自动续接全部下线），只保留通用
 * provider 模板 + API Key 引导。原 OAuth 组件文件（useOAuth 等）留给 F4.5 删除。
 */
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LoginApiKeyForm } from "@/login/LoginApiKeyForm.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

/**
 * fork（F4.1b）："oauth" 原是 OAuth 登录完成的落点；入口摘除后不再产生，
 * 类型保留待 F4.5 清理（Root 的 onComplete 只区分日志语义）。
 */
export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <section className="relative z-10 w-full flex flex-col gap-10 max-w-sm rounded-2xl border border-popover-border bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
        <LoginPanel active onComplete={onComplete} />
      </section>
    </main>
  );
}

interface LoginPanelProps {
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export function LoginPanel({ active, onComplete }: LoginPanelProps) {
  const { intl } = useZCodeIntl();
  // fork（F4.1b）：active 原用于 OAuth 等待态的取消与 loginEntryRequest 消费；
  // BYOK 引导是纯表单，不依赖激活态。参数保留以稳定 WelcomeScreen 契约（Root 挂载点）。
  void active;
  return (
    <>
      <header className="flex flex-col items-center gap-3 text-center">
        <LoginPanelLogo />
        <div className="flex flex-col items-center gap-1 text-center">
          {/* i18n key 沿用原登录页文案（任务约定：F4.1b 不清理 i18n，F7.4 统一处理）。 */}
          <h1 className="text-3xl font-semibold tracking-tight">
            {intl.formatMessage({ id: "login.title" })}
          </h1>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "login.description" })}
          </p>
        </div>
      </header>
      <div className="space-y-6">
        <LoginApiKeyForm
          onSaved={() => onComplete("apiKey")}
          onSkipped={() => onComplete("skip")}
        />
      </div>
    </>
  );
}

function LoginPanelLogo() {
  return (
    // 登录 logo 壳是固定深色底，边框不能跟随浅色主题 token，否则浅色主题下边框过重。
    <div
      className="relative mb-1 flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
      aria-label="ZCode"
      role="img"
    >
      <ZCodeAboutLogo className="h-auto w-10" />
    </div>
  );
}
