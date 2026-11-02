import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useWebRemoteControlMobileSettingsForm,
  WebRemoteControlMobileSettingsFields,
  type WebRemoteControlMobileSettingsDraft,
  type WebRemoteControlMobileSettingsFormInitial,
} from "@/WebRemoteControlMobileSettingsForm.js";

export type {
  WebRemoteControlMobileSettingsDraft,
  WebRemoteControlMobileSettingsFormInitial,
} from "@/WebRemoteControlMobileSettingsForm.js";

/**
 * 手机端 gateway 首次配置页（T4.2）。
 *
 * 只负责页面外壳与独立设置流程的提交按钮；字段、本地校验和错误展示复用
 * `WebRemoteControlMobileSettingsForm`，与已连接会话内的设置分区保持同一实现。
 * 持久化由调用方（web 的 mobile-remote bootstrap）经
 * `IPlatformService.secureStore` 完成。release 构建缺少原生桥时保存会失败，
 * 这里把错误原样展示，绝不静默降级到 localStorage。
 */

export interface WebRemoteControlMobileSettingsScreenProps {
  initial?: WebRemoteControlMobileSettingsFormInitial;
  /** 本地开发允许 http；release 构建要求 https。 */
  allowInsecureTransport: boolean;
  onSubmit(draft: WebRemoteControlMobileSettingsDraft): Promise<void>;
  /** 已有配置时允许返回上一页；首次设置不提供。 */
  onBack?(): void;
  /** 把持久化错误翻译成用户可读文案；缺省直接展示错误信息。 */
  formatError?(error: unknown): string;
}

export function WebRemoteControlMobileSettingsScreen({
  initial,
  allowInsecureTransport,
  onSubmit,
  onBack,
  formatError,
}: WebRemoteControlMobileSettingsScreenProps) {
  const { intl } = useZCodeIntl();
  const form = useWebRemoteControlMobileSettingsForm({
    initial,
    allowInsecureTransport,
    onSubmit,
    formatError,
  });

  return (
    // min-h-dvh（spec D3）：#root 固定 100dvh + overflow:hidden，min-h-screen(100vh) 在
    // iOS Safari 工具栏展开时比 #root 高出约一个工具栏高度，底部提交按钮被裁剪且根节点
    // 不可滚动，首次配置无法完成（走查 viewport-1/settings-1）。
    <section
      className="flex min-h-dvh flex-col bg-background text-foreground"
      data-mobile-remote-page="settings"
    >
      {/* 开屏首屏：hero 头部直接坐在页面背景上，表单收进卡片，
          用背景→卡片的层次代替横条 header，避免和后续操作页的 header 带同质化。 */}
      <header className="shrink-0 px-5 pt-7 pb-5">
        <div className="flex size-12 items-center justify-center rounded-xl bg-accent">
          <ShieldCheck className="size-6 text-icon-blue" />
        </div>
        <h1 className="mt-4 text-ui-xl font-semibold tracking-tight">
          {intl.formatMessage({ id: "webRemoteControl.mobileSetup.title" })}
        </h1>
        <p className="mt-1.5 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileSetup.description" })}
        </p>
      </header>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void form.submit(event)}>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <WebRemoteControlMobileSettingsFields
            gatewayUrl={form.gatewayUrl}
            namespace={form.namespace}
            credential={form.credential}
            credentialConfigured={form.credentialConfigured}
            allowInsecureTransport={allowInsecureTransport}
            disabled={form.pending}
            onGatewayUrlChange={form.setGatewayUrl}
            onNamespaceChange={form.setNamespace}
            onCredentialChange={form.setCredential}
          />

          {/* home-2/settings-3：错误就地渲染在提交按钮正上方——手机上键盘弹出、视野只剩下半屏，
              点提交失败后错误必须出现在按钮附近（视口内），而不是滚动容器顶部（视口外）；
              showError 还会在按钮行恰好在视口外时把错误滚动进视野。 */}
          {form.error ? (
            <p
              ref={form.errorRef}
              role="alert"
              className="mt-4 rounded-lg border border-destructive/40 bg-card px-3 py-2.5 text-ui-base text-destructive"
            >
              {form.error}
            </p>
          ) : null}

          {/* 用户指定的继续形态：紧随输入卡片下方的居中圆形箭头主按钮；图标按钮用 aria-label 保住可访问名。 */}
          <div className="mt-4 flex items-center justify-center gap-2 pb-6">
            {onBack ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-0"
                onClick={onBack}
                disabled={form.pending}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            ) : null}
            <Button
              type="submit"
              aria-label={intl.formatMessage({
                id: form.pending
                  ? "webRemoteControl.mobileSetup.saving"
                  : "webRemoteControl.mobileSetup.save",
              })}
              aria-busy={form.pending}
              className="size-12 shrink-0 rounded-full p-0"
              disabled={form.pending}
              data-mobile-remote-settings-submit="true"
            >
              {form.pending ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <ArrowRight className="size-5" />
              )}
            </Button>
          </div>
          {/* spec §2.5：viewport-fit=cover 下 iPhone 底部 home 指示条（inset≈34px）大于 pb-6 的 24px
              余量，滚动容器末尾垫一层纯安全区 padding（零高度、无其他 padding-bottom，不产生同层叠加），
              保证提交按钮可完整点按。 */}
          <div className="zcode-safe-area-bottom" aria-hidden="true" />
        </div>
      </form>
    </section>
  );
}
