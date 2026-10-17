/* eslint-disable max-lines -- 远程访问分区的表单、凭证只写不读状态机和连接状态展示共享同一组 pending/刷新边界，拆分会引入第二套状态。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_REMOTE_ACCESS_NAMESPACE, tryNormalizeRemoteAccessGatewayUrl } from "@zcode/shared";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteAccessStatus } from "@/hooks/useRemoteAccessStatus.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  getGatewayStatusDotClassName,
  getGatewayStatusLabelId,
  getTestConnectionFailureMessageId,
} from "@/remoteAccessStatusUi.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type PendingAction =
  | "save-config"
  | "save-credential"
  | "clear-credential"
  | "toggle"
  | "test"
  | "disconnect"
  | null;

function FormField({
  label,
  description,
  children,
  error,
}: {
  label: string;
  description: string;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</p>
      </div>
      {children}
      {error ? <p className="text-ui-base text-destructive">{error}</p> : null}
    </div>
  );
}

function PendingSpinner({ pending }: { pending: boolean }) {
  return pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null;
}

/**
 * 桌面设置页「远程访问」分区（T4.1）。
 *
 * 状态事实源是 Main：开关、gateway 连接和手机连接都经 `useRemoteAccessStatus` 查询；
 * 本组件只提交用户动作。backend 凭证只写不读，界面只能看到「已配置/未配置」。
 */
export function RemoteAccessSection({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update, refresh: refreshSettings } = useSettings();
  const remoteAccessStatusRead = useRemoteAccessStatus({ enabled: isDesktop });
  const remoteAccessStatus = remoteAccessStatusRead.status;
  const remoteAccessSettings = settings?.remoteAccess;
  const enabled = remoteAccessStatus?.enabled ?? remoteAccessSettings?.enabled ?? false;
  const gateway = remoteAccessStatus?.gateway ?? { state: "disabled" as const };
  const mobileConnected = remoteAccessStatus?.status.mobileConnected === true;
  const mobileDeviceName =
    remoteAccessStatus?.status.mobileDeviceInfo?.name?.trim() ||
    remoteAccessStatus?.status.mobileDeviceInfo?.browserPlatform?.trim() ||
    intl.formatMessage({ id: "settings.remoteAccess.phone.unknownDevice" });

  const [gatewayUrlDraft, setGatewayUrlDraft] = useState("");
  const [namespaceDraft, setNamespaceDraft] = useState(DEFAULT_REMOTE_ACCESS_NAMESPACE);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [gatewayUrlError, setGatewayUrlError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  // 只在真正写入过表单值后跳过回填，避免设置快照变化把用户正在编辑的草稿覆盖掉。
  const appliedSettingsSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!remoteAccessSettings) {
      return;
    }
    const signature = JSON.stringify([
      remoteAccessSettings.gatewayUrl,
      remoteAccessSettings.namespace,
    ]);
    if (appliedSettingsSignatureRef.current === signature) {
      return;
    }
    appliedSettingsSignatureRef.current = signature;
    setGatewayUrlDraft(remoteAccessSettings.gatewayUrl);
    setNamespaceDraft(remoteAccessSettings.namespace || DEFAULT_REMOTE_ACCESS_NAMESPACE);
  }, [remoteAccessSettings]);

  const loadCredentialStatus = useCallback(async () => {
    const getStatus = platform.getRemoteAccessCredentialStatus;
    if (!getStatus) {
      return;
    }
    try {
      const nextStatus = await getStatus.call(platform);
      setCredentialConfigured(nextStatus.configured);
    } catch (error) {
      logger.warn("[remote-access-settings] 读取凭证状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [platform]);

  useEffect(() => {
    void loadCredentialStatus();
  }, [loadCredentialStatus]);

  const handleSaveConfig = async () => {
    const rawGatewayUrl = gatewayUrlDraft.trim();
    let normalizedGatewayUrl = "";
    if (rawGatewayUrl) {
      const endpoint = tryNormalizeRemoteAccessGatewayUrl(rawGatewayUrl, {
        // 与 Main 的 allowInsecureTransport 保持一致：只有本地 dev 允许 http。
        allowInsecureTransport: platform.isLocalDevelopmentRuntime === true,
      });
      if (!endpoint) {
        const message = intl.formatMessage({
          id: "settings.remoteAccess.gatewayUrl.invalid",
        });
        setGatewayUrlError(message);
        toast(message);
        return;
      }
      normalizedGatewayUrl = endpoint.baseUrl;
    }

    setGatewayUrlError(null);
    setPendingAction("save-config");
    try {
      await update({
        remoteAccess: {
          enabled,
          gatewayUrl: normalizedGatewayUrl,
          namespace: namespaceDraft.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE,
        },
      });
      toast(intl.formatMessage({ id: "settings.remoteAccess.config.saveSuccess" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[remote-access-settings] 保存远程访问配置失败", { error: message });
      toast(
        intl.formatMessage({ id: "settings.remoteAccess.config.saveFailed" }, { error: message }),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleSaveCredential = async () => {
    const credential = credentialDraft.trim();
    const saveCredential = platform.saveRemoteAccessCredential;
    if (!credential || !saveCredential) {
      return;
    }
    setPendingAction("save-credential");
    try {
      await saveCredential.call(platform, credential);
      setCredentialDraft("");
      setCredentialConfigured(true);
      toast(intl.formatMessage({ id: "settings.remoteAccess.credential.saveSuccess" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[remote-access-settings] 保存 backend 凭证失败", { error: message });
      toast(
        intl.formatMessage(
          {
            id: message.includes("zgb_")
              ? "settings.remoteAccess.credential.invalid"
              : "settings.remoteAccess.credential.saveFailed",
          },
          { error: message },
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleClearCredential = async () => {
    const clearCredential = platform.clearRemoteAccessCredential;
    if (!clearCredential) {
      return;
    }
    setPendingAction("clear-credential");
    try {
      await clearCredential.call(platform);
      setCredentialConfigured(false);
      toast(intl.formatMessage({ id: "settings.remoteAccess.credential.clearSuccess" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[remote-access-settings] 清除 backend 凭证失败", { error: message });
      toast(
        intl.formatMessage(
          { id: "settings.remoteAccess.credential.clearFailed" },
          { error: message },
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleToggle = async (nextEnabled: boolean) => {
    const setEnabled = platform.setRemoteAccessEnabled;
    if (!setEnabled) {
      return;
    }
    setPendingAction("toggle");
    try {
      await setEnabled.call(platform, nextEnabled);
      // Main 会写入 settings 并广播 SettingsChanged；这里主动刷新，保证开关反馈不滞后。
      await Promise.all([refreshSettings(), remoteAccessStatusRead.refresh()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[remote-access-settings] 切换远程访问失败", { error: message });
      toast(intl.formatMessage({ id: "settings.remoteAccess.toggle.failed" }, { error: message }));
    } finally {
      setPendingAction(null);
    }
  };

  const handleTestConnection = async () => {
    const testConnection = platform.testRemoteAccessConnection;
    if (!testConnection || mobileConnected) {
      return;
    }
    setPendingAction("test");
    try {
      const credential = credentialDraft.trim();
      const result = await testConnection.call(platform, {
        gatewayUrl: gatewayUrlDraft,
        namespace: namespaceDraft,
        ...(credential ? { credential } : {}),
      });
      if (result.ok) {
        toast(intl.formatMessage({ id: "settings.remoteAccess.test.success" }));
      } else {
        toast(intl.formatMessage({ id: getTestConnectionFailureMessageId(result.reason) }));
      }
      await remoteAccessStatusRead.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[remote-access-settings] 测试 gateway 连接失败", { error: message });
      toast(intl.formatMessage({ id: "settings.remoteAccess.test.error" }, { error: message }));
    } finally {
      setPendingAction(null);
    }
  };

  const handleDisconnect = async () => {
    const disconnect = platform.disconnectRemoteClient;
    if (!disconnect) {
      return;
    }
    setPendingAction("disconnect");
    try {
      await disconnect.call(platform);
      toast(intl.formatMessage({ id: "settings.remoteAccess.phone.disconnectSuccess" }));
      await remoteAccessStatusRead.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[remote-access-settings] 断开手机失败", { error: message });
      toast(
        intl.formatMessage(
          { id: "settings.remoteAccess.phone.disconnectFailed" },
          { error: message },
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const busy = pendingAction !== null;
  const testSupported = typeof platform.testRemoteAccessConnection === "function";
  const credentialSupported = typeof platform.saveRemoteAccessCredential === "function";
  const disconnectSupported = typeof platform.disconnectRemoteClient === "function";

  return (
    <div className="space-y-5" data-testid="remote-access-settings">
      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.remoteAccess.toggle.label" })}
            description={intl.formatMessage({ id: "settings.remoteAccess.toggle.description" })}
            control={
              <Switch
                aria-label={intl.formatMessage({ id: "settings.remoteAccess.toggle.label" })}
                data-testid="remote-access-toggle"
                checked={enabled}
                disabled={busy || typeof platform.setRemoteAccessEnabled !== "function"}
                onCheckedChange={(checked) => void handleToggle(checked)}
              />
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteAccess.config.section" })}
        </div>
        <SettingsGroupCard>
          <div className="space-y-4 border-t border-border px-4 py-3 first:border-t-0">
            <FormField
              label={intl.formatMessage({ id: "settings.remoteAccess.gatewayUrl.label" })}
              description={intl.formatMessage({
                id: "settings.remoteAccess.gatewayUrl.description",
              })}
              error={gatewayUrlError}
            >
              <Input
                data-testid="remote-access-gateway-url"
                aria-label={intl.formatMessage({ id: "settings.remoteAccess.gatewayUrl.label" })}
                value={gatewayUrlDraft}
                placeholder={intl.formatMessage({
                  id: "settings.remoteAccess.gatewayUrl.placeholder",
                })}
                onChange={(event) => {
                  setGatewayUrlDraft(event.currentTarget.value);
                  setGatewayUrlError(null);
                }}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </FormField>
            <FormField
              label={intl.formatMessage({ id: "settings.remoteAccess.namespace.label" })}
              description={intl.formatMessage({
                id: "settings.remoteAccess.namespace.description",
              })}
            >
              <Input
                data-testid="remote-access-namespace"
                aria-label={intl.formatMessage({ id: "settings.remoteAccess.namespace.label" })}
                value={namespaceDraft}
                placeholder={DEFAULT_REMOTE_ACCESS_NAMESPACE}
                onChange={(event) => setNamespaceDraft(event.currentTarget.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </FormField>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="lg"
                data-testid="remote-access-save-config"
                disabled={busy}
                onClick={() => void handleSaveConfig()}
              >
                <PendingSpinner pending={pendingAction === "save-config"} />
                {intl.formatMessage({ id: "settings.remoteAccess.config.save" })}
              </Button>
            </div>
          </div>
          <div className="space-y-4 border-t border-border px-4 py-3">
            <FormField
              label={intl.formatMessage({ id: "settings.remoteAccess.credential.label" })}
              description={intl.formatMessage({
                id: "settings.remoteAccess.credential.description",
              })}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  data-testid="remote-access-credential"
                  aria-label={intl.formatMessage({
                    id: "settings.remoteAccess.credential.label",
                  })}
                  type="password"
                  value={credentialDraft}
                  placeholder={intl.formatMessage({
                    id: credentialConfigured
                      ? "settings.remoteAccess.credential.replacePlaceholder"
                      : "settings.remoteAccess.credential.placeholder",
                  })}
                  onChange={(event) => setCredentialDraft(event.currentTarget.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  className="min-w-64 flex-1"
                />
                <Button
                  type="button"
                  size="lg"
                  data-testid="remote-access-save-credential"
                  disabled={busy || !credentialDraft.trim() || !credentialSupported}
                  onClick={() => void handleSaveCredential()}
                >
                  <PendingSpinner pending={pendingAction === "save-credential"} />
                  {intl.formatMessage({ id: "settings.remoteAccess.credential.save" })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  data-testid="remote-access-clear-credential"
                  disabled={busy || !credentialConfigured || !credentialSupported}
                  onClick={() => void handleClearCredential()}
                >
                  <PendingSpinner pending={pendingAction === "clear-credential"} />
                  {intl.formatMessage({ id: "settings.remoteAccess.credential.clear" })}
                </Button>
              </div>
            </FormField>
            <div
              data-testid="remote-access-credential-status"
              data-configured={credentialConfigured ? "true" : "false"}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-ui-xs font-medium text-foreground-subtle"
            >
              <span
                className={`size-1.5 rounded-full ${
                  credentialConfigured ? "bg-success" : "bg-border"
                }`}
              />
              {intl.formatMessage({
                id: credentialConfigured
                  ? "settings.remoteAccess.credential.configured"
                  : "settings.remoteAccess.credential.notConfigured",
              })}
            </div>
          </div>
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteAccess.status.section" })}
        </div>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.remoteAccess.gateway.label" })}
            description={intl.formatMessage({ id: "settings.remoteAccess.gateway.description" })}
            control={
              <div
                data-testid="remote-access-gateway-status"
                data-state={gateway.state}
                data-reason={gateway.state === "error" ? gateway.reason : undefined}
                className="flex items-center justify-end gap-2"
              >
                <span className={`size-2 rounded-full ${getGatewayStatusDotClassName(gateway)}`} />
                <span className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: getGatewayStatusLabelId(gateway) })}
                </span>
              </div>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.remoteAccess.phone.label" })}
            description={
              mobileConnected
                ? mobileDeviceName
                : intl.formatMessage({ id: "settings.remoteAccess.phone.waitingDetail" })
            }
            control={
              <div
                data-testid="remote-access-mobile-status"
                data-connected={mobileConnected ? "true" : "false"}
                className="flex items-center justify-end gap-2"
              >
                {mobileConnected ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    data-testid="remote-access-disconnect-client"
                    disabled={busy || !disconnectSupported}
                    onClick={() => void handleDisconnect()}
                  >
                    <PendingSpinner pending={pendingAction === "disconnect"} />
                    {intl.formatMessage({ id: "settings.remoteAccess.phone.disconnect" })}
                  </Button>
                ) : (
                  <span className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.remoteAccess.phone.waiting" })}
                  </span>
                )}
              </div>
            }
          />
        </SettingsGroupCard>
      </section>

      <section className="space-y-3">
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.remoteAccess.test.label" })}
            description={intl.formatMessage({
              id: mobileConnected
                ? "settings.remoteAccess.test.mobileConnected"
                : "settings.remoteAccess.test.description",
            })}
            control={
              <Button
                type="button"
                variant="outline"
                size="lg"
                data-testid="remote-access-test-connection"
                disabled={busy || mobileConnected || !testSupported}
                onClick={() => void handleTestConnection()}
              >
                <PendingSpinner pending={pendingAction === "test"} />
                {intl.formatMessage({ id: "settings.remoteAccess.test.label" })}
              </Button>
            }
          />
        </SettingsGroupCard>
      </section>
    </div>
  );
}
