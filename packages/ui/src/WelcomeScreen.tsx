/**
 * WelcomeScreen —— 首启 BYOK（自带 API Key）provider 配置引导。
 *
 * fork（F4.1b）：官方账号入口摘除后，本页不再提供 OAuth 登录区（z.ai / BigModel
 * 账号登录、等待与错误态、loginEntryRequest 自动续接全部下线），只保留通用
 * provider 模板 + API Key 引导。
 *
 * 布局为 Split onboarding：左侧 zcoder 品牌栏（md 以下隐藏），右侧标题与表单
 * （spec: docs/ui/login-page.md）。
 */
import type { ReactNode } from "react";
import { ArrowLeftRightIcon, CpuIcon, LockIcon } from "lucide-react";
import zcoderLogoUrl from "@/assets/brand/zcoder-logo.png";
import { cn } from "@/components/lib/utils.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LoginApiKeyForm } from "@/login/LoginApiKeyForm.js";

interface WelcomeScreenProps {
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

/**
 * fork（F4.1b）："oauth" 原是 OAuth 登录完成的落点；入口摘除后不再产生，
 * 类型保留待 F4.5 清理（Root 的 onComplete 只区分日志语义）。
 */
export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

/** 品牌名是专有名词，不进入 i18n，各语言一致。 */
const BRAND_NAME = "zcoder";

export function WelcomeScreen({ onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh overflow-hidden bg-background text-foreground">
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      <WelcomeBrandPanel />
      <section className="relative z-0 flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-4 py-12 sm:px-6">
        <div className="flex w-full max-w-sm flex-col gap-8">
          <LoginPanel active onComplete={onComplete} />
        </div>
      </section>
    </main>
  );
}

function WelcomeBrandPanel() {
  const { intl } = useZCodeIntl();
  return (
    <aside
      data-testid="welcome-brand-panel"
      className="relative z-0 hidden w-[min(600px,46%)] shrink-0 flex-col justify-between gap-10 overflow-y-auto border-r border-border bg-sidebar px-12 pb-12 pt-24 md:flex lg:px-16"
    >
      <div className="flex flex-col gap-9">
        <BrandMark />
        <h2 className="text-3xl font-semibold leading-tight tracking-tight text-foreground">
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
        className="rounded-lg border border-card-border bg-background px-4 py-3.5 font-mono text-ui-sm/relaxed text-foreground-subtle"
      >
        <div>
          <span className="text-logo-accent">›</span>{" "}
          <span className="text-foreground">
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
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-card-border bg-card text-logo-accent"
      >
        {icon}
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-ui-base font-medium text-foreground">{title}</span>
        <span className="text-ui-caption/relaxed text-foreground-subtle">{description}</span>
      </div>
    </li>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img src={zcoderLogoUrl} alt="" width={36} height={36} className="size-9 shrink-0" />
      <span className="text-ui-lg font-semibold tracking-tight text-foreground">{BRAND_NAME}</span>
    </div>
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
      <header className="flex flex-col gap-6">
        {/* 窄窗口隐藏左侧品牌栏，品牌行移到表单上方，DOM 顺序保持“品牌 → 标题 → 表单”。 */}
        <BrandMark className="md:hidden" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-ui-xl font-semibold tracking-tight text-foreground">
            {intl.formatMessage({ id: "login.title" })}
          </h1>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "login.description" })}
          </p>
        </div>
      </header>
      <LoginApiKeyForm onSaved={() => onComplete("apiKey")} onSkipped={() => onComplete("skip")} />
    </>
  );
}
