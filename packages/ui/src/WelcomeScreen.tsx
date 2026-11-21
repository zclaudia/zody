/**
 * WelcomeScreen —— 首启 BYOK（自带 API Key）provider 配置引导。
 *
 * fork（F4.1b）：官方账号入口摘除后，本页不再提供 OAuth 登录区（z.ai / BigModel
 * 账号登录、等待与错误态、loginEntryRequest 自动续接全部下线），只保留通用
 * provider 模板 + API Key 引导。
 *
 * 布局为 Split onboarding：左侧 Zody 品牌栏（md 以下隐藏），右侧标题与表单
 * （spec: docs/ui/login-page.md）。
 */
import type { ReactNode } from "react";
import { ArrowLeftRightIcon, CpuIcon, GitForkIcon, LockIcon } from "lucide-react";
import { ZODY_BRAND_NAME, zodyLogoUrl } from "@/brand.js";
import { cn } from "@/components/lib/utils.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { LoginApiKeyForm } from "@/login/LoginApiKeyForm.js";

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
    <main className="relative flex h-full min-h-dvh overflow-hidden bg-background text-foreground">
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <WelcomeBrandPanel />
      <section className="relative z-0 flex min-w-0 flex-1 overflow-y-auto px-5 py-12 sm:px-8">
        <div className="m-auto flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-card-border bg-card">
          <LoginPanel active onComplete={onComplete} />
        </div>
      </section>
    </main>
  );
}

function WelcomeBrandPanel() {
  const { intl } = useZodyIntl();
  return (
    <aside
      data-testid="welcome-brand-panel"
      className="zody-brand-grid relative z-0 m-3 hidden w-[min(650px,46%)] shrink-0 flex-col gap-10 overflow-y-auto rounded-xl border border-brand-panel-line bg-brand-panel px-8 pb-8 pt-12 text-brand-panel-foreground md:flex lg:px-14 lg:pb-10 lg:pt-16"
    >
      <BrandMark />
      <div className="my-auto flex flex-col gap-7">
        <h2 className="max-w-sm text-ui-display font-semibold leading-tight tracking-tight">
          {intl.formatMessage({ id: "login.hero.title" })}
        </h2>
        <ul className="flex flex-col gap-5">
          <BrandFeature
            icon={<CpuIcon className="size-4" />}
            title={intl.formatMessage({ id: "login.hero.anyProvider.title" })}
            description={intl.formatMessage({ id: "login.hero.anyProvider.description" })}
          />
          <BrandFeature
            icon={<LockIcon className="size-4" />}
            title={intl.formatMessage({ id: "login.hero.localKeys.title" })}
            description={intl.formatMessage({ id: "login.hero.localKeys.description" })}
          />
          <BrandFeature
            icon={<ArrowLeftRightIcon className="size-4" />}
            title={intl.formatMessage({ id: "login.hero.switchModels.title" })}
            description={intl.formatMessage({ id: "login.hero.switchModels.description" })}
          />
        </ul>
      </div>
      {/* 纯装饰的会话预览，读屏无需朗读。 */}
      <div
        aria-hidden="true"
        className="rounded-lg border border-brand-panel-line bg-brand-panel px-4 py-3.5 font-mono text-ui-sm/relaxed text-brand-panel-muted"
      >
        <div className="mb-2 flex items-center gap-1 border-b border-brand-panel-line pb-2">
          <span className="size-1.5 rounded-full bg-brand-panel-accent" />
          <span className="size-1.5 rounded-full bg-brand-panel-line" />
          <span className="size-1.5 rounded-full bg-brand-panel-line" />
        </div>
        <div>
          <span className="text-brand-panel-accent">›</span>{" "}
          <span className="text-brand-panel-foreground">
            {intl.formatMessage({ id: "login.hero.preview.prompt" })}
          </span>
        </div>
        <div>● {intl.formatMessage({ id: "login.hero.preview.reading" })}</div>
        <div>
          ● {intl.formatMessage({ id: "login.hero.preview.editing" })}{" "}
          <span className="text-diff-added">+42</span>{" "}
          <span className="text-diff-removed">−18</span>
        </div>
      </div>
    </aside>
  );
}

function BrandFeature({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <li className="flex gap-3.5">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md border border-brand-panel-line bg-brand-panel text-brand-panel-accent"
      >
        {icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-ui-base font-medium">{title}</span>
        <span className="text-ui-caption/relaxed text-brand-panel-muted">{description}</span>
      </div>
    </li>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img src={zodyLogoUrl} alt="" width={36} height={36} className="size-9 shrink-0" />
      <span className="font-mono text-ui-lg font-semibold tracking-tight">
        {ZODY_BRAND_NAME}
      </span>
    </div>
  );
}

interface LoginPanelProps {
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export function LoginPanel({ active, onComplete }: LoginPanelProps) {
  const { intl } = useZodyIntl();
  // fork（F4.1b）：active 原用于 OAuth 等待态的取消与 loginEntryRequest 消费；
  // BYOK 引导是纯表单，不依赖激活态。参数保留以稳定 WelcomeScreen 契约（Root 挂载点）。
  void active;
  return (
    <>
      <header className="welcome-setup-header zody-brand-grid relative isolate flex flex-col gap-6 overflow-hidden border-b border-brand-panel-line px-6 pb-7 pt-5 sm:px-9 md:border-card-border md:pt-8">
        <GitForkIcon
          aria-hidden="true"
          strokeWidth={0.8}
          className="pointer-events-none absolute -right-3 -top-3 -z-10 size-36 -rotate-90 text-brand-panel-line md:hidden"
        />
        {/* 窄窗口隐藏左侧品牌栏，品牌行移到表单上方，DOM 顺序保持“品牌 → 标题 → 表单”。 */}
        <BrandMark className="md:hidden" />
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5 font-mono text-ui-xs font-semibold uppercase tracking-widest text-brand-panel-accent md:text-brand">
            <span aria-hidden="true" className="rounded-sm border border-current px-1.5 py-0.5">
              01
            </span>
            <span>{intl.formatMessage({ id: "login.setup.eyebrow" })}</span>
          </div>
          <h1 className="text-ui-display font-semibold leading-tight tracking-tight">
            {intl.formatMessage({ id: "login.title" })}
          </h1>
          <p className="max-w-xs text-ui-base/relaxed text-brand-panel-muted md:text-foreground-subtle">
            {intl.formatMessage({ id: "login.description" })}
          </p>
        </div>
      </header>
      <div className="welcome-setup-form px-6 pb-5 pt-6 sm:px-9">
        <LoginApiKeyForm onSaved={() => onComplete("apiKey")} onSkipped={() => onComplete("skip")} />
      </div>
    </>
  );
}
