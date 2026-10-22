import { useState, type FormEvent } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 手机端 gateway 设置页（T4.2）。
 *
 * 只负责表单与本地校验；持久化由调用方（web 的 mobile-remote bootstrap）经
 * `IPlatformService.secureStore` 完成。release 构建缺少原生桥时保存会失败，
 * 这里把错误原样展示，绝不静默降级到 localStorage。
 */

export interface WebRemoteControlMobileSettingsDraft {
  gatewayUrl: string;
  namespace: string;
  credential: string;
}

export interface WebRemoteControlMobileSettingsScreenProps {
  initial?: {
    gatewayUrl?: string;
    namespace?: string;
    /** 已保存的凭证不回显，只提示「已保存」。 */
    credentialConfigured?: boolean;
  };
  /** 本地开发允许 http；release 构建要求 https。 */
  allowInsecureTransport: boolean;
  onSubmit(draft: WebRemoteControlMobileSettingsDraft): Promise<void>;
  /** 已有配置时允许返回上一页；首次设置不提供。 */
  onBack?(): void;
  /** 把持久化错误翻译成用户可读文案；缺省直接展示错误信息。 */
  formatError?(error: unknown): string;
}

function readGatewayUrlError(
  value: string,
  allowInsecureTransport: boolean,
): "required" | "invalid" | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return "required";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  const protocol = parsed.protocol;
  const allowed = allowInsecureTransport
    ? protocol === "http:" || protocol === "https:" || protocol === "ws:" || protocol === "wss:"
    : protocol === "https:" || protocol === "wss:";
  if (!allowed || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return "invalid";
  }
  return null;
}

export function WebRemoteControlMobileSettingsScreen({
  initial,
  allowInsecureTransport,
  onSubmit,
  onBack,
  formatError,
}: WebRemoteControlMobileSettingsScreenProps) {
  const { intl } = useZCodeIntl();
  const [gatewayUrl, setGatewayUrl] = useState(initial?.gatewayUrl ?? "");
  const [namespace, setNamespace] = useState(initial?.namespace ?? DEFAULT_REMOTE_ACCESS_NAMESPACE);
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credentialConfigured = initial?.credentialConfigured === true;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) {
      return;
    }
    const gatewayUrlError = readGatewayUrlError(gatewayUrl, allowInsecureTransport);
    if (gatewayUrlError) {
      setError(
        intl.formatMessage({
          id:
            gatewayUrlError === "required"
              ? "webRemoteControl.mobileSetup.gatewayUrl.required"
              : "webRemoteControl.mobileSetup.gatewayUrl.invalid",
        }),
      );
      return;
    }
    const trimmedCredential = credential.trim();
    if (!trimmedCredential && !credentialConfigured) {
      setError(intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.required" }));
      return;
    }
    if (trimmedCredential && !trimmedCredential.startsWith("zgd_")) {
      setError(intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.invalid" }));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        gatewayUrl: gatewayUrl.trim(),
        namespace: namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE,
        credential: trimmedCredential,
      });
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setError(
        formatError
          ? formatError(submitError)
          : message === MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE
            ? intl.formatMessage({ id: "webRemoteControl.mobileSetup.storageUnavailable" })
            : intl.formatMessage(
                { id: "webRemoteControl.mobileSetup.saveFailed" },
                { error: message },
              ),
      );
      setPending(false);
    }
  };

  return (
    <section
      className="flex min-h-screen flex-col bg-background text-foreground"
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

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void handleSubmit(event)}>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? (
            <p
              role="alert"
              className="mb-3 rounded-lg border border-destructive/40 bg-card px-3 py-2.5 text-ui-base text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="rounded-xl border border-card-border bg-card">
            <div className="divide-y divide-border">
              <div className="px-4 py-4">
                <Label htmlFor="mobile-remote-gateway-url">
                  {intl.formatMessage({ id: "webRemoteControl.mobileSetup.gatewayUrl.label" })}
                </Label>
                <Input
                  id="mobile-remote-gateway-url"
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "webRemoteControl.mobileSetup.gatewayUrl.placeholder",
                  })}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="url"
                  className="mt-2 h-11 rounded-lg font-mono text-mobile-input-safe leading-6"
                  disabled={pending}
                />
                <p className="mt-1.5 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({
                    id: allowInsecureTransport
                      ? "webRemoteControl.mobileSetup.gatewayUrl.description.development"
                      : "webRemoteControl.mobileSetup.gatewayUrl.description",
                  })}
                </p>
              </div>

              <div className="px-4 py-4">
                <Label htmlFor="mobile-remote-namespace">
                  {intl.formatMessage({ id: "webRemoteControl.mobileSetup.namespace.label" })}
                </Label>
                <Input
                  id="mobile-remote-namespace"
                  value={namespace}
                  onChange={(event) => setNamespace(event.target.value)}
                  placeholder={DEFAULT_REMOTE_ACCESS_NAMESPACE}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-2 h-11 rounded-lg font-mono text-mobile-input-safe leading-6"
                  disabled={pending}
                />
                <p className="mt-1.5 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "webRemoteControl.mobileSetup.namespace.description" })}
                </p>
              </div>

              <div className="px-4 py-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor="mobile-remote-credential">
                    {intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.label" })}
                  </Label>
                  {credentialConfigured ? (
                    <span className="rounded-full border border-border bg-surface px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtle">
                      {intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.saved" })}
                    </span>
                  ) : null}
                </div>
                <Input
                  id="mobile-remote-credential"
                  type="password"
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: credentialConfigured
                      ? "webRemoteControl.mobileSetup.credential.savedPlaceholder"
                      : "webRemoteControl.mobileSetup.credential.placeholder",
                  })}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-2 h-11 rounded-lg font-mono text-mobile-input-safe leading-6"
                  disabled={pending}
                />
                <p className="mt-1.5 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.description" })}
                </p>
              </div>
            </div>
          </div>

          {/* 用户指定的继续形态：紧随输入卡片下方的居中圆形箭头主按钮；图标按钮用 aria-label 保住可访问名。 */}
          <div className="mt-4 flex items-center justify-center gap-2 pb-6">
            {onBack ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 min-w-0"
                onClick={onBack}
                disabled={pending}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            ) : null}
            <Button
              type="submit"
              aria-label={intl.formatMessage({
                id: pending
                  ? "webRemoteControl.mobileSetup.saving"
                  : "webRemoteControl.mobileSetup.save",
              })}
              aria-busy={pending}
              className="size-12 shrink-0 rounded-full p-0"
              disabled={pending}
              data-mobile-remote-settings-submit="true"
            >
              {pending ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <ArrowRight className="size-5" />
              )}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}
