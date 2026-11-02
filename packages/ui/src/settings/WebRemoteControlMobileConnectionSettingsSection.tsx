import { useEffect, useRef, type FormEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isWebRemoteControlMobileSettingsHistoryState } from "@/mobileNavigationHistory.js";
import {
  useWebRemoteControlMobileSettingsForm,
  WebRemoteControlMobileSettingsFields,
  type WebRemoteControlMobileSettingsDraft,
  type WebRemoteControlMobileSettingsFormInitial,
} from "@/WebRemoteControlMobileSettingsForm.js";

/**
 * 已连接手机 Web Remote Control 的“连接”设置分区。
 *
 * 只由 mobile bootstrap 通过 Root props 注入连接能力；packages/ui 不感知
 * `MobileRemoteConfigStore` 或 secureStore 实现。保存仍走注入的唯一 helper
 * （web 侧 `saveMobileRemoteSettingsDraft`），本组件只负责：
 * - 复用首次配置页的字段/校验/错误展示；
 * - 无有效变化时回到设置首页；
 * - 有效变化时先把设置首页/分区条目回退到宿主条目，popstate 落回宿主后再触发调用方
 *   唯一一次 reopenSetup("auto")。
 */
export interface WebRemoteControlMobileConnectionSettingsApi {
  initial: WebRemoteControlMobileSettingsFormInitial;
  allowInsecureTransport: boolean;
  /** 校验并写入 MobileRemoteConfigStore；scopeChanged 决定是否重建会话。 */
  save(draft: WebRemoteControlMobileSettingsDraft): Promise<{ scopeChanged: boolean }>;
  /** 有效连接变化后重建当前会话（bootstrap → reopenSetup("auto")）。 */
  reconnect(): void;
}

export interface WebRemoteControlMobileConnectionSettingsSectionProps {
  settings: WebRemoteControlMobileConnectionSettingsApi;
  /** 取消/返回：只回设置首页，不 dispose 会话。 */
  onBack(): void;
  /** 无有效变化保存成功：回设置首页。 */
  onSaved(): void;
  /** 每次从分区离开回设置首页时递增；用于丢弃未保存草稿（含顶部/系统返回）。 */
  resetToken?: number;
  /** 把持久化错误翻译成用户可读文案；缺省直接展示错误信息。 */
  formatError?(error: unknown): string;
}

export function WebRemoteControlMobileConnectionSettingsSection({
  settings,
  onBack,
  onSaved,
  resetToken = 0,
  formatError,
}: WebRemoteControlMobileConnectionSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const form = useWebRemoteControlMobileSettingsForm({
    initial: settings.initial,
    allowInsecureTransport: settings.allowInsecureTransport,
    onSubmit: settings.save,
    formatError,
  });
  // SettingsPage 在 index 下只隐藏分区、不卸载，所以顶部返回、浏览器/Android 返回
  // 必须由 resetToken 触发丢弃草稿；用 ref 保证 effect 只依赖 token，不会因每次渲染
  // 新建 reset 函数而反复清空输入。
  const resetRef = useRef(form.reset);
  useEffect(() => {
    resetRef.current = form.reset;
  });
  useEffect(() => {
    resetRef.current();
  }, [resetToken]);

  const recycleSettingsHistoryThenReconnect = () => {
    if (typeof window === "undefined") {
      settings.reconnect();
      return;
    }
    const state = window.history.state;
    if (!isWebRemoteControlMobileSettingsHistoryState(state)) {
      settings.reconnect();
      return;
    }
    const steps = state.zcodeMobileSettings.view === "section" ? 2 : 1;
    const handlePopState = (event: PopStateEvent) => {
      // go(-2) 的目标是宿主条目；若浏览器先落在中间的设置首页，继续等下一次 popstate。
      if (isWebRemoteControlMobileSettingsHistoryState(event.state)) {
        return;
      }
      window.removeEventListener("popstate", handlePopState);
      settings.reconnect();
    };
    window.addEventListener("popstate", handlePopState);
    window.history.go(-steps);
  };

  const handleSubmit = async (event: FormEvent) => {
    const result = await form.submit(event);
    if (!result) {
      return;
    }
    if (!result.scopeChanged) {
      // 分区在设置首页下只隐藏不卸载；无变化返回时丢弃草稿，避免再次进入看到旧凭证。
      form.reset();
      onSaved();
      return;
    }
    // 有效连接变化会销毁并重建整个远控会话。先按真实返回语义弹掉设置条目：
    // 分区条目下方必然有设置首页条目（pushSection 保证），所以 go(-2) 直达宿主；
    // 首页条目只需 go(-1)。必须等 popstate 落回宿主后再重连，否则新 Root 挂载会
    // 清掉当前条目，而旧 go 仍可能多退一层。无设置条目时直接重连，避免挂起。
    recycleSettingsHistoryThenReconnect();
  };

  return (
    <section
      className="space-y-4"
      aria-label={intl.formatMessage({ id: "webRemoteControl.mobileSettings.connectionSection" })}
      data-mobile-connection-settings-section="true"
    >
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({
          id: "webRemoteControl.mobileSettings.connectionSection.description",
        })}
      </p>

      <form
        onSubmit={(event) => void handleSubmit(event)}
        data-mobile-connection-settings-form="true"
      >
        <WebRemoteControlMobileSettingsFields
          gatewayUrl={form.gatewayUrl}
          namespace={form.namespace}
          credential={form.credential}
          credentialConfigured={form.credentialConfigured}
          allowInsecureTransport={settings.allowInsecureTransport}
          disabled={form.pending}
          onGatewayUrlChange={form.setGatewayUrl}
          onNamespaceChange={form.setNamespace}
          onCredentialChange={form.setCredential}
        />

        {form.error ? (
          <p
            ref={form.errorRef}
            role="alert"
            className="mt-4 rounded-lg border border-destructive/40 bg-card px-3 py-2.5 text-ui-base text-destructive"
          >
            {form.error}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-20"
            onClick={() => {
              form.reset();
              onBack();
            }}
            disabled={form.pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="submit"
            className="h-11 min-w-20 gap-2"
            aria-busy={form.pending}
            disabled={form.pending}
            data-mobile-connection-settings-submit="true"
          >
            {form.pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {intl.formatMessage({
              id: form.pending
                ? "webRemoteControl.mobileSettings.saving"
                : "webRemoteControl.mobileSettings.save",
            })}
          </Button>
        </div>
      </form>
    </section>
  );
}
