import { useRef, useState, type FormEvent, type RefObject } from "react";
import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
} from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveUnsavedSettingsBlockReason,
  useMobileRemoteRefreshGuard,
} from "@/mobileRemoteRefreshGuards.js";

/**
 * 手机连接设置表单的共享实现。
 *
 * 首次配置页（`WebRemoteControlMobileSettingsScreen`）与已连接会话内的设置分区
 * （`WebRemoteControlMobileConnectionSettingsSection`）必须复用同一套字段、校验和
 * 错误展示，避免两条入口得到不同的归一化结果。这里只处理本地草稿与提交时序，
 * 持久化仍由调用方注入（mobile bootstrap → `MobileRemoteConfigStore`）。
 */

export interface WebRemoteControlMobileSettingsDraft {
  gatewayUrl: string;
  namespace: string;
  credential: string;
}

export interface WebRemoteControlMobileSettingsFormInitial {
  gatewayUrl?: string;
  namespace?: string;
  /** 已保存的凭证不回显，只提示「已保存」。 */
  credentialConfigured?: boolean;
}

export interface WebRemoteControlMobileSettingsFormOptions<T> {
  initial?: WebRemoteControlMobileSettingsFormInitial;
  /** 本地开发允许 http；release 构建要求 https。 */
  allowInsecureTransport: boolean;
  onSubmit(draft: WebRemoteControlMobileSettingsDraft): Promise<T>;
  /** 把持久化错误翻译成用户可读文案；缺省直接展示错误信息。 */
  formatError?(error: unknown): string;
}

export interface WebRemoteControlMobileSettingsFormController<T> {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  pending: boolean;
  error: string | null;
  errorRef: RefObject<HTMLParagraphElement | null>;
  credentialConfigured: boolean;
  setGatewayUrl(value: string): void;
  setNamespace(value: string): void;
  setCredential(value: string): void;
  /** 丢弃本次未保存输入，恢复初始值（取消/无变化返回时使用）。 */
  reset(): void;
  /** 校验并提交；校验/保存失败返回 undefined，成功返回 onSubmit 的结果。 */
  submit(event: FormEvent): Promise<T | undefined>;
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

export function useWebRemoteControlMobileSettingsForm<T>({
  initial,
  allowInsecureTransport,
  onSubmit,
  formatError,
}: WebRemoteControlMobileSettingsFormOptions<T>): WebRemoteControlMobileSettingsFormController<T> {
  const { intl } = useZCodeIntl();
  const [gatewayUrl, setGatewayUrl] = useState(initial?.gatewayUrl ?? "");
  const [namespace, setNamespace] = useState(initial?.namespace ?? DEFAULT_REMOTE_ACCESS_NAMESPACE);
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // home-2/settings-3：错误块渲染在提交动作上方，保留引用用于渲染后滚动定位，
  // 保证按钮在视口外（小屏/横屏）时错误依然可见。
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const credentialConfigured = initial?.credentialConfigured === true;

  // 连接设置草稿只由本 hook 持有；guard 读取同一状态，保存/取消 reset 后自动解除。
  useMobileRemoteRefreshGuard("mobile-settings-draft", () =>
    resolveUnsavedSettingsBlockReason({
      current: { gatewayUrl, namespace, credential },
      initial: {
        ...(initial?.gatewayUrl === undefined ? {} : { gatewayUrl: initial.gatewayUrl }),
        ...(initial?.namespace === undefined ? {} : { namespace: initial.namespace }),
        credentialConfigured,
      },
    }),
  );

  const reset = () => {
    setGatewayUrl(initial?.gatewayUrl ?? "");
    setNamespace(initial?.namespace ?? DEFAULT_REMOTE_ACCESS_NAMESPACE);
    setCredential("");
    setError(null);
    setPending(false);
  };

  const showError = (message: string) => {
    setError(message);
    // scrollIntoView 在 jsdom 等测试环境不存在，可选链兜底；block:"nearest" 已可见时不滚动。
    requestAnimationFrame(() =>
      errorRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }),
    );
  };

  const submit = async (event: FormEvent): Promise<T | undefined> => {
    event.preventDefault();
    if (pending) {
      return undefined;
    }
    const gatewayUrlError = readGatewayUrlError(gatewayUrl, allowInsecureTransport);
    if (gatewayUrlError) {
      showError(
        intl.formatMessage({
          id:
            gatewayUrlError === "required"
              ? "webRemoteControl.mobileSetup.gatewayUrl.required"
              : "webRemoteControl.mobileSetup.gatewayUrl.invalid",
        }),
      );
      return undefined;
    }
    const trimmedCredential = credential.trim();
    if (!trimmedCredential && !credentialConfigured) {
      showError(intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.required" }));
      return undefined;
    }
    if (trimmedCredential && !trimmedCredential.startsWith("zgd_")) {
      showError(intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.invalid" }));
      return undefined;
    }
    setPending(true);
    setError(null);
    try {
      return await onSubmit({
        gatewayUrl: gatewayUrl.trim(),
        namespace: namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE,
        credential: trimmedCredential,
      });
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      showError(
        formatError
          ? formatError(submitError)
          : message === MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE
            ? intl.formatMessage({ id: "webRemoteControl.mobileSetup.storageUnavailable" })
            : intl.formatMessage(
                { id: "webRemoteControl.mobileSetup.saveFailed" },
                { error: message },
              ),
      );
      return undefined;
    } finally {
      setPending(false);
    }
  };

  return {
    gatewayUrl,
    namespace,
    credential,
    pending,
    error,
    errorRef,
    credentialConfigured,
    setGatewayUrl,
    setNamespace,
    setCredential,
    reset,
    submit,
  };
}

/**
 * 三个连接字段的设置卡片。首次配置页和设置分区共用，保证标签、说明、44px 输入高度
 * 与凭证「已保存」占位一致。
 */
export function WebRemoteControlMobileSettingsFields({
  gatewayUrl,
  namespace,
  credential,
  credentialConfigured,
  allowInsecureTransport,
  disabled,
  onGatewayUrlChange,
  onNamespaceChange,
  onCredentialChange,
}: {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  credentialConfigured: boolean;
  allowInsecureTransport: boolean;
  disabled: boolean;
  onGatewayUrlChange(value: string): void;
  onNamespaceChange(value: string): void;
  onCredentialChange(value: string): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="rounded-xl border border-card-border bg-card">
      <div className="divide-y divide-border">
        <div className="px-4 py-4">
          <Label htmlFor="mobile-remote-gateway-url">
            {intl.formatMessage({ id: "webRemoteControl.mobileSetup.gatewayUrl.label" })}
          </Label>
          <Input
            id="mobile-remote-gateway-url"
            value={gatewayUrl}
            onChange={(event) => onGatewayUrlChange(event.target.value)}
            placeholder={intl.formatMessage({
              id: "webRemoteControl.mobileSetup.gatewayUrl.placeholder",
            })}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            className="mt-2 h-11 rounded-lg font-mono text-mobile-input-safe leading-6"
            disabled={disabled}
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
            onChange={(event) => onNamespaceChange(event.target.value)}
            placeholder={DEFAULT_REMOTE_ACCESS_NAMESPACE}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // keyboard-5：声明 inputMode/enterKeyHint，手机键盘动作键显示「完成」而非通用「换行」。
            inputMode="text"
            enterKeyHint="done"
            className="mt-2 h-11 rounded-lg font-mono text-mobile-input-safe leading-6"
            disabled={disabled}
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
            onChange={(event) => onCredentialChange(event.target.value)}
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
            disabled={disabled}
          />
          <p className="mt-1.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.mobileSetup.credential.description" })}
          </p>
        </div>
      </div>
    </div>
  );
}
