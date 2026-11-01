import type {
  BrowserExtensionBridgeStatus,
  BrowserExtensionPairingStatus,
  BrowserExtensionPairingTicket,
  BrowserExtensionProfileStatus,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

export const BROWSER_EXTENSION_INSTALL_COMMAND = "pnpm --filter @zcode/browser-extension build";

const BINDING_LABEL_IDS = {
  "current-window": "settings.browser.extension.profile.boundHere",
  unbound: "settings.browser.extension.profile.unbound",
} as const;

export function BrowserExtensionInstallRow({
  status,
  onOpenDirectory,
}: {
  status: BrowserExtensionBridgeStatus | null;
  onOpenDirectory: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.browser.extension.install.title" })}
      description={intl.formatMessage({ id: "settings.browser.extension.install.description" })}
      control={null}
      detail={
        <div className="space-y-2 text-ui-base text-foreground-subtle">
          <ol className="list-decimal space-y-1 pl-4">
            <li>{intl.formatMessage({ id: "settings.browser.extension.install.step1" })}</li>
            <li>{intl.formatMessage({ id: "settings.browser.extension.install.step2" })}</li>
            <li>{intl.formatMessage({ id: "settings.browser.extension.install.step3" })}</li>
          </ol>
          <code className="block select-all break-all rounded-md bg-surface px-2 py-1 font-mono text-ui-sm">
            {BROWSER_EXTENSION_INSTALL_COMMAND}
          </code>
          {status?.installDirectory ? (
            <div className="space-y-2">
              <code
                className="block select-all break-all font-mono text-ui-sm"
                data-testid="browser-extension-install-directory"
              >
                {status.installDirectory}
              </code>
              {status.installDirectoryAvailable ? (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  data-testid="browser-extension-open-install-directory"
                  onClick={onOpenDirectory}
                >
                  {intl.formatMessage({
                    id: "settings.browser.extension.install.openDirectory",
                  })}
                </Button>
              ) : (
                <div>
                  {intl.formatMessage({ id: "settings.browser.extension.install.missing" })}
                </div>
              )}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

export function BrowserExtensionPairingPanel({
  ticket,
  pendingPairing,
  onCancel,
}: {
  ticket: BrowserExtensionPairingTicket;
  pendingPairing?: BrowserExtensionPairingStatus;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="browser-extension-pairing-panel"
    >
      <div className="w-full space-y-1 rounded-lg border border-border bg-surface px-4 py-3 text-ui-base">
        <div>
          {intl.formatMessage({ id: "settings.browser.extension.pairing.code" })}:{" "}
          <code className="select-all font-mono" data-testid="browser-extension-pairing-code">
            {ticket.pairingCode}
          </code>
        </div>
        <div>
          {intl.formatMessage({ id: "settings.browser.extension.pairing.session" })}:{" "}
          <code className="select-all font-mono">{ticket.pairingSessionId}</code>
        </div>
        <div>
          {intl.formatMessage({ id: "settings.browser.extension.pairing.extensionId" })}:{" "}
          <code
            className="select-all font-mono"
            data-testid="browser-extension-pairing-extension-id"
          >
            {pendingPairing?.extensionId ??
              intl.formatMessage({ id: "settings.browser.extension.pairing.waiting" })}
          </code>
        </div>
        <div>
          {intl.formatMessage({ id: "settings.browser.extension.pairing.profile" })}:{" "}
          <code className="select-all font-mono" data-testid="browser-extension-pairing-profile-id">
            {pendingPairing?.profileInstanceId ??
              intl.formatMessage({ id: "settings.browser.extension.pairing.waiting" })}
          </code>
        </div>
        <div className="text-foreground-subtle">
          {intl.formatMessage({ id: "settings.browser.extension.pairing.instructions" })}
        </div>
      </div>
      <Button type="button" size="lg" variant="ghost" onClick={onCancel}>
        {intl.formatMessage({ id: "settings.browser.extension.pairing.cancel" })}
      </Button>
    </div>
  );
}

export function BrowserExtensionProfileRows({
  profiles,
  pending,
  onTransfer,
  onRevoke,
}: {
  profiles: BrowserExtensionProfileStatus[];
  pending: boolean;
  onTransfer: (profile: BrowserExtensionProfileStatus) => void;
  onRevoke: (profile: BrowserExtensionProfileStatus) => void;
}) {
  const { intl } = useZCodeIntl();
  if (profiles.length === 0) {
    return (
      <div className="px-4 pb-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.browser.extension.profile.empty" })}
      </div>
    );
  }
  return (
    <>
      {profiles.map((profile) => (
        <SettingsRow
          key={profile.profileInstanceId}
          label={profile.browserId}
          description={`${profile.extensionId} · ${intl.formatMessage({
            id: BINDING_LABEL_IDS[profile.binding],
          })}`}
          control={
            <div className="flex flex-wrap gap-2">
              {profile.binding === "unbound" ? (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={pending}
                  data-testid="browser-extension-transfer"
                  onClick={() => onTransfer(profile)}
                >
                  {intl.formatMessage({ id: "settings.browser.extension.transfer" })}
                </Button>
              ) : null}
              <Button
                type="button"
                size="lg"
                variant="destructive"
                disabled={pending}
                data-testid="browser-extension-revoke"
                onClick={() => onRevoke(profile)}
              >
                {intl.formatMessage({ id: "settings.browser.extension.revoke" })}
              </Button>
            </div>
          }
          detail={
            <div
              className="text-ui-base text-foreground-subtle"
              data-testid={`browser-extension-profile-${profile.profileInstanceId}`}
            >
              {profile.connected
                ? intl.formatMessage(
                    { id: "settings.browser.extension.profile.connected" },
                    { generation: profile.generation ?? 0 },
                  )
                : intl.formatMessage({ id: "settings.browser.extension.profile.disconnected" })}
            </div>
          }
        />
      ))}
    </>
  );
}
