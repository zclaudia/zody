import { useEffect, useMemo, useState } from "react";
import { Laptop, LoaderCircle, RefreshCw, ShieldAlert } from "lucide-react";
import type { WebRemoteControlFailure } from "@zcode/shared";
import {
  isRemoteAccessMobileBackendSelectable,
  type RemoteAccessMobileBackendOption,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 选电脑页（T4.2）。
 *
 * 列表项来自 `discoverBackends` 与 registry 能力位的合并（见 web 包 `mobileRemoteBackendDiscovery`）。
 * 在线但缺少 `zcode-remote-control` 能力位的电脑会明确标记为不可选，不再自动重试；
 * 离线电脑仍可选择，transport 会等 registry 恢复在线后自动重连。
 */

export interface WebRemoteControlMobileBackendPickerProps {
  backends: RemoteAccessMobileBackendOption[];
  loading: boolean;
  failure?: WebRemoteControlFailure;
  selectedBackendId?: string;
  onRefresh?(): void;
  onSelect(backendId: string): Promise<void>;
  onBackToSettings(): void;
}

function formatLastSeen(lastSeenAt: number | null): string | null {
  if (!lastSeenAt) {
    return null;
  }
  try {
    return new Date(lastSeenAt).toLocaleString();
  } catch {
    return null;
  }
}

export function WebRemoteControlMobileBackendPicker({
  backends,
  loading,
  failure,
  selectedBackendId,
  onRefresh,
  onSelect,
  onBackToSettings,
}: WebRemoteControlMobileBackendPickerProps) {
  const { intl } = useZCodeIntl();
  const defaultBackendId = useMemo(() => {
    if (selectedBackendId) {
      return selectedBackendId;
    }
    return backends.find(isRemoteAccessMobileBackendSelectable)?.backendId;
  }, [backends, selectedBackendId]);
  const [currentBackendId, setCurrentBackendId] = useState<string | undefined>(defaultBackendId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 已保存的电脑若变为「在线但不支持远控」，不能允许再次确认；用户必须重选。
  const currentBackend = backends.find((backend) => backend.backendId === currentBackendId);
  const canConfirm = Boolean(currentBackendId) && currentBackend?.supported === true;

  useEffect(() => {
    if (!currentBackendId && defaultBackendId) {
      setCurrentBackendId(defaultBackendId);
    }
  }, [currentBackendId, defaultBackendId]);

  const handleConfirm = async () => {
    if (!currentBackendId || !canConfirm || pending) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSelect(currentBackendId);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
      setPending(false);
    }
  };

  const failureMessage =
    failure?.reason === "gateway-credential-invalid"
      ? intl.formatMessage({ id: "webRemoteControl.mobileBackend.credentialInvalid" })
      : failure?.reason === "gateway-unreachable"
        ? intl.formatMessage({ id: "webRemoteControl.mobileBackend.gatewayUnreachable" })
        : failure?.message;

  return (
    <section
      className="flex min-h-screen flex-col bg-background text-foreground"
      data-mobile-remote-page="backend-picker"
    >
      <header className="shrink-0 border-b border-border bg-header px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-ui-lg font-medium">
            {intl.formatMessage({ id: "webRemoteControl.mobileBackend.title" })}
          </h1>
          {onRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              aria-label={intl.formatMessage({ id: "webRemoteControl.mobileBackend.refresh" })}
              onClick={onRefresh}
              disabled={pending}
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.mobileBackend.description" })}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {failureMessage ? (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-ui-base text-destructive">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{failureMessage}</span>
          </div>
        ) : null}

        {loading && backends.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-3 text-ui-base text-foreground-subtle">
            <LoaderCircle className="size-4 animate-spin" />
            {intl.formatMessage({ id: "webRemoteControl.mobileBackend.loading" })}
          </div>
        ) : null}

        {!loading && backends.length === 0 && !failureMessage ? (
          <p className="px-1 py-3 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.mobileBackend.empty" })}
          </p>
        ) : null}

        <ul className="space-y-2" data-mobile-remote-backend-list="true">
          {backends.map((backend) => {
            const selectable = isRemoteAccessMobileBackendSelectable(backend);
            const selected = backend.backendId === currentBackendId;
            const lastSeen = formatLastSeen(backend.lastSeenAt);
            return (
              <li key={backend.backendId}>
                <button
                  type="button"
                  data-mobile-remote-backend-item={backend.backendId}
                  data-state={selected ? "selected" : "idle"}
                  data-supported={backend.supported ? "true" : "false"}
                  className={cn(
                    "flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-3 text-left transition-colors",
                    selected
                      ? "border-primary bg-selected text-foreground"
                      : "hover:bg-surface-hover",
                    !selectable && "cursor-not-allowed opacity-60",
                  )}
                  aria-pressed={selected}
                  disabled={!selectable || pending}
                  onClick={() => setCurrentBackendId(backend.backendId)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle">
                    <Laptop className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {backend.name}
                    </span>
                    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-ui-xs text-foreground-subtle">
                      <span
                        className={cn(
                          "rounded-full border px-1.5 py-0.5 leading-none",
                          backend.online
                            ? "border-success/40 text-success"
                            : "border-border text-foreground-subtlest",
                        )}
                      >
                        {intl.formatMessage({
                          id: backend.online
                            ? "webRemoteControl.mobileBackend.online"
                            : "webRemoteControl.mobileBackend.offline",
                        })}
                      </span>
                      {!backend.supported ? (
                        <span className="rounded-full border border-warning/40 px-1.5 py-0.5 leading-none text-warning-foreground">
                          {intl.formatMessage({
                            id: "webRemoteControl.mobileBackend.unsupported",
                          })}
                        </span>
                      ) : null}
                      {lastSeen && !backend.online ? (
                        <span className="truncate">
                          {intl.formatMessage(
                            { id: "webRemoteControl.mobileBackend.lastSeen" },
                            { time: lastSeen },
                          )}
                        </span>
                      ) : null}
                    </span>
                    {!backend.supported ? (
                      <span className="mt-1 block text-ui-xs text-foreground-subtle">
                        {intl.formatMessage({
                          id: "webRemoteControl.mobileBackend.unsupportedHint",
                        })}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p role="alert" className="mt-3 text-ui-base text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-border bg-background px-4 py-3">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-0 flex-1"
            onClick={onBackToSettings}
            disabled={pending}
          >
            {intl.formatMessage({ id: "webRemoteControl.mobileBackend.backToSettings" })}
          </Button>
          <Button
            type="button"
            className="h-11 min-w-0 flex-[2]"
            onClick={() => void handleConfirm()}
            disabled={!canConfirm || pending}
            data-mobile-remote-backend-confirm="true"
          >
            {pending ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
            {intl.formatMessage({ id: "webRemoteControl.mobileBackend.confirm" })}
          </Button>
        </div>
      </footer>
    </section>
  );
}
