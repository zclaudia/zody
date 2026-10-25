import { useEffect, useMemo, useState } from "react";
import type { MobileNotification } from "@zcode/services/mobile-notifications";
import type { MobileNotificationPushStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { MobileNotificationCenter } from "@/MobileNotificationCenter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function MobileNotificationsFeature({
  switcher,
  onBack,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  onBack: () => void;
}) {
  const { intl } = useZCodeIntl();
  const reader = useMemo(() => switcher.getNotificationReader?.(), [switcher]);
  const platform = useOptionalPlatform();
  const notificationPlatform = platform?.mobileNotifications;
  const [pushStatus, setPushStatus] = useState<MobileNotificationPushStatus["status"] | "loading">(
    notificationPlatform ? "loading" : "disabled",
  );
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "accepted" | "failed">("idle");
  const [requestingPermission, setRequestingPermission] = useState(false);
  useEffect(() => {
    if (!notificationPlatform) return;
    let active = true;
    const refreshStatus = () => {
      void notificationPlatform
        .getStatus()
        .then(({ status }) => {
          if (active) setPushStatus(status);
        })
        .catch(() => {
          if (active) setPushStatus("error");
        });
    };
    refreshStatus();
    const disposeStatus = notificationPlatform.onStatusChanged?.(refreshStatus);
    const disposeLifecycle = platform?.onAppLifecycleChange?.((state) => {
      if (state === "foreground") refreshStatus();
    });
    return () => {
      active = false;
      disposeStatus?.();
      disposeLifecycle?.();
    };
  }, [notificationPlatform, platform]);

  const requestPermission = async () => {
    if (!notificationPlatform || requestingPermission) return;
    setRequestingPermission(true);
    try {
      await notificationPlatform.requestPermission();
      setPushStatus((await notificationPlatform.getStatus()).status);
    } catch {
      setPushStatus("error");
    } finally {
      setRequestingPermission(false);
    }
  };
  if (!reader || !switcher.openNotification) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <p className="text-ui-sm text-foreground-subtle" role="status">
          {notificationPlatform
            ? intl.formatMessage({ id: `mobileNotifications.push.${pushStatus}` })
            : intl.formatMessage({ id: "mobileNotifications.push.webOnly" })}
        </p>
        {notificationPlatform && pushStatus === "permission-denied" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={requestingPermission}
            onClick={() => void requestPermission()}
          >
            {intl.formatMessage({
              id: requestingPermission
                ? "mobileNotifications.push.requesting"
                : "mobileNotifications.push.requestPermission",
            })}
          </Button>
        ) : null}
      </div>
      {notificationPlatform && switcher.testNotification ? (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={testStatus === "sending"}
            onClick={() => {
              setTestStatus("sending");
              void switcher.testNotification!()
                .then(() => setTestStatus("accepted"))
                .catch(() => setTestStatus("failed"));
            }}
          >
            {intl.formatMessage({ id: "mobileNotifications.test.send" })}
          </Button>
          {testStatus !== "idle" && (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: `mobileNotifications.test.${testStatus}` })}
            </p>
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <MobileNotificationCenter
          reader={reader}
          onBack={onBack}
          onOpen={async (notification: MobileNotification) => {
            await switcher.openNotification?.(notification.notificationId);
          }}
          labels={{
            title: intl.formatMessage({ id: "mobileNotifications.title" }),
            markAllRead: intl.formatMessage({ id: "mobileNotifications.markAllRead" }),
            loading: intl.formatMessage({ id: "mobileNotifications.loading" }),
            loadMore: intl.formatMessage({ id: "mobileNotifications.loadMore" }),
            empty: intl.formatMessage({ id: "mobileNotifications.empty" }),
            recovered: intl.formatMessage({ id: "mobileNotifications.recovered" }),
            resolved: intl.formatMessage({ id: "mobileNotifications.resolved" }),
            unread: intl.formatMessage({ id: "mobileNotifications.unread" }),
          }}
        />
      </div>
    </div>
  );
}
