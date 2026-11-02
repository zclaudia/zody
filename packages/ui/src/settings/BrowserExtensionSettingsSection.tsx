import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type {
  BrowserExtensionBridgeStatus,
  BrowserExtensionPairingTicket,
  BrowserExtensionProfileStatus,
} from "@zody/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  BrowserExtensionInstallRow,
  BrowserExtensionPairingPanel,
  BrowserExtensionProfileRows,
} from "@/settings/BrowserExtensionSettingsParts.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const PAIRING_POLL_MS = 1_500;

export function BrowserExtensionSettingsSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [status, setStatus] = useState<BrowserExtensionBridgeStatus | null>(null);
  const [pairingTicket, setPairingTicket] = useState<BrowserExtensionPairingTicket | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [portDirty, setPortDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BrowserExtensionProfileStatus | null>(null);
  /** pending → seen → cleared；避免 beginPairing 后旧轮询结果立刻清掉本地 ticket。 */
  const pairingProgress = useRef<"pending" | "seen" | null>(null);

  const managementAvailable =
    isDesktop &&
    typeof platform.getBrowserExtensionStatus === "function" &&
    typeof platform.beginBrowserExtensionPairing === "function";

  const refresh = useCallback(async () => {
    if (typeof platform.getBrowserExtensionStatus !== "function") return;
    try {
      const next = await platform.getBrowserExtensionStatus();
      setStatus(next);
      if (pairingProgress.current === "pending" && next.pairing) {
        pairingProgress.current = "seen";
      } else if (pairingProgress.current === "seen" && !next.pairing) {
        // 配对成功、取消或过期都由 Main 删除会话；本地 ticket 不保留失效信息。
        pairingProgress.current = null;
        setPairingTicket(null);
      }
    } catch (error) {
      // 1.5 秒轮询失败不能反复 toast；保留上一次状态，仅在日志中记录可诊断原因。
      logger.warn("[browser-extension-settings] 读取 Chrome 扩展状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [platform]);

  useEffect(() => {
    if (!managementAvailable) return;
    void refresh();
    const timer = setInterval(() => void refresh(), PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [managementAvailable, refresh]);

  useEffect(() => {
    if (!status || portDirty) return;
    setPortDraft(String(status.configuredPort));
  }, [portDirty, status]);

  const profiles = status?.profiles ?? [];
  const defaultBackendId = status?.defaultBrowserId?.trim() ?? "";
  const defaultUnavailable =
    defaultBackendId.length > 0 &&
    !profiles.some(
      (profile) => profile.browserId === defaultBackendId && profile.binding === "current-window",
    );
  const pendingPairing = status?.pairing;

  const backendOptions = useMemo(
    () => [
      {
        // Radix Select 不允许空字符串 item value；用 iab 作显式哨兵。
        value: "iab",
        label: intl.formatMessage({ id: "settings.browser.extension.default.iab" }),
      },
      // 默认只属于当前窗口；孤儿 Profile 先转移，不能直接成为默认。
      ...profiles
        .filter((profile) => profile.binding === "current-window")
        .map((profile) => ({
          value: profile.browserId,
          label: `${intl.formatMessage({ id: "settings.browser.extension.default.chrome" })} · ${
            profile.profileInstanceId
          }`,
        })),
    ],
    [intl, profiles],
  );

  const handleDefaultBackendChange = useCallback(
    async (value: string) => {
      if (!platform.setBrowserExtensionDefaultBackend) return;
      setPending("default");
      try {
        const result = await platform.setBrowserExtensionDefaultBackend(
          value === "iab" ? null : value,
        );
        if (!result.ok) {
          toast(intl.formatMessage({ id: "settings.browser.extension.default.failed" }));
          return;
        }
        await refresh();
      } finally {
        setPending(null);
      }
    },
    [intl, platform, refresh],
  );

  const handleBeginPairing = useCallback(async () => {
    if (!platform.beginBrowserExtensionPairing) return;
    setPending("pair");
    try {
      const ticket = await platform.beginBrowserExtensionPairing();
      pairingProgress.current = ticket ? "pending" : null;
      setPairingTicket(ticket);
      if (!ticket) {
        toast(intl.formatMessage({ id: "settings.browser.extension.pairing.failed" }));
      }
      await refresh();
    } finally {
      setPending(null);
    }
  }, [intl, platform, refresh]);

  const handleCancelPairing = useCallback(async () => {
    if (!pairingTicket || !platform.cancelBrowserExtensionPairing) return;
    await platform.cancelBrowserExtensionPairing(pairingTicket.pairingSessionId);
    pairingProgress.current = null;
    setPairingTicket(null);
    await refresh();
  }, [pairingTicket, platform, refresh]);

  const handleSavePort = useCallback(async () => {
    if (!platform.setBrowserExtensionBridgePort) return;
    const port = Number(portDraft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      toast(intl.formatMessage({ id: "settings.browser.extension.port.invalid" }));
      return;
    }
    setPending("port");
    try {
      const result = await platform.setBrowserExtensionBridgePort(port);
      if (!result.ok) {
        toast(
          result.error === "port_in_use"
            ? intl.formatMessage({ id: "settings.browser.extension.port.inUse" })
            : intl.formatMessage({ id: "settings.browser.extension.port.failed" }),
        );
        return;
      }
      setPortDirty(false);
      toast(intl.formatMessage({ id: "settings.browser.extension.port.saved" }));
      await refresh();
    } finally {
      setPending(null);
    }
  }, [intl, platform, portDraft, refresh]);

  const handleRevoke = useCallback(async () => {
    if (!revokeTarget || !platform.revokeBrowserExtensionProfile) return;
    setPending("revoke");
    try {
      const result = await platform.revokeBrowserExtensionProfile(revokeTarget.profileInstanceId);
      if (!result.ok) {
        toast(intl.formatMessage({ id: "settings.browser.extension.revoke.failed" }));
        return;
      }
      toast(intl.formatMessage({ id: "settings.browser.extension.revoke.success" }));
      await refresh();
    } finally {
      setRevokeTarget(null);
      setPending(null);
    }
  }, [intl, platform, refresh, revokeTarget]);

  const handleTransfer = useCallback(
    async (profile: BrowserExtensionProfileStatus) => {
      if (!platform.transferBrowserExtensionProfile) return;
      setPending(`transfer:${profile.profileInstanceId}`);
      try {
        const result = await platform.transferBrowserExtensionProfile(profile.profileInstanceId);
        toast(
          result.ok
            ? intl.formatMessage({ id: "settings.browser.extension.transfer.success" })
            : intl.formatMessage({ id: "settings.browser.extension.transfer.failed" }),
        );
        await refresh();
      } finally {
        setPending(null);
      }
    },
    [intl, platform, refresh],
  );

  if (!isDesktop) {
    return (
      <section className="space-y-3" data-testid="browser-extension-settings">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.extension.section" })}
        </div>
        <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.extension.desktopOnly" })}
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="browser-extension-settings">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.browser.extension.section" })}
      </div>

      <SettingsGroupCard>
        <BrowserExtensionInstallRow
          status={status}
          onOpenDirectory={() => {
            if (status?.installDirectory) {
              void platform.openInFileManager?.(status.installDirectory);
            }
          }}
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.browser.extension.port.title" })}
          description={intl.formatMessage({ id: "settings.browser.extension.port.description" })}
          control={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={intl.formatMessage({ id: "settings.browser.extension.port.title" })}
                data-testid="browser-extension-port-input"
                inputMode="numeric"
                className="w-28"
                value={portDraft}
                onChange={(event) => {
                  setPortDirty(true);
                  setPortDraft(event.target.value);
                }}
              />
              <Button
                type="button"
                size="lg"
                variant="outline"
                disabled={pending !== null || !portDirty}
                data-testid="browser-extension-port-save"
                onClick={() => void handleSavePort()}
              >
                {pending === "port" ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({ id: "settings.browser.extension.port.save" })}
              </Button>
            </div>
          }
          detail={
            <div
              className="text-ui-base text-foreground-subtle"
              data-testid="browser-extension-status"
            >
              {status?.available
                ? intl.formatMessage(
                    { id: "settings.browser.extension.status.listening" },
                    { port: status.port ?? status.configuredPort },
                  )
                : intl.formatMessage({ id: "settings.browser.extension.status.unavailable" })}
              {status?.error ? ` · ${status.error}` : ""}
            </div>
          }
        />

        <SettingsRow
          label={intl.formatMessage({ id: "settings.browser.extension.default.title" })}
          description={intl.formatMessage({
            id: "settings.browser.extension.default.description",
          })}
          control={
            <Select
              value={defaultBackendId || "iab"}
              disabled={pending !== null}
              onValueChange={(value) => void handleDefaultBackendChange(value)}
            >
              <SelectTrigger
                size="lg"
                className="w-72 min-w-0 justify-between"
                data-testid="browser-extension-default-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {backendOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    data-testid={`browser-extension-default-option-${option.value}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
                {defaultUnavailable ? (
                  <SelectItem value={defaultBackendId}>
                    {intl.formatMessage(
                      { id: "settings.browser.extension.default.missing" },
                      { browserId: defaultBackendId },
                    )}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
          }
          detail={
            defaultUnavailable ? (
              <div className="text-ui-base text-destructive">
                {intl.formatMessage({ id: "settings.browser.extension.default.failClosed" })}
              </div>
            ) : undefined
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.browser.extension.pairing.title" })}
          description={intl.formatMessage({
            id: "settings.browser.extension.pairing.description",
          })}
          control={
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={pending !== null || !managementAvailable}
              data-testid="browser-extension-begin-pairing"
              onClick={() => void handleBeginPairing()}
            >
              {intl.formatMessage({ id: "settings.browser.extension.pairing.begin" })}
            </Button>
          }
          detail={
            pairingTicket ? (
              <BrowserExtensionPairingPanel
                ticket={pairingTicket}
                {...(pendingPairing ? { pendingPairing } : {})}
                onCancel={() => void handleCancelPairing()}
              />
            ) : undefined
          }
        />
        <BrowserExtensionProfileRows
          profiles={profiles}
          pending={pending !== null}
          onTransfer={(profile) => void handleTransfer(profile)}
          onRevoke={setRevokeTarget}
        />
      </SettingsGroupCard>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.browser.extension.revoke.confirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.browser.extension.revoke.confirmDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>
              {intl.formatMessage({ id: "common.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending !== null}
              data-testid="browser-extension-revoke-confirm"
              onClick={(event) => {
                event.preventDefault();
                void handleRevoke();
              }}
            >
              {intl.formatMessage({ id: "settings.browser.extension.revoke.confirmAction" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
