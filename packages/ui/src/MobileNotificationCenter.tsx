import { useState } from "react";
import type { MobileNotification } from "@zcode/services/mobile-notifications";
import { useMobileNotificationFeed } from "@/hooks/useMobileNotificationFeed.js";
import type { IMobileNotificationReaderContract } from "@zcode/services/mobile-notifications";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface MobileNotificationCenterProps {
  reader: IMobileNotificationReaderContract;
  onOpen(notification: MobileNotification): Promise<void>;
  onBack(): void;
  labels: {
    title: string;
    markAllRead: string;
    loading: string;
    loadMore: string;
    empty: string;
    recovered: string;
    resolved: string;
    unread: string;
  };
}

export function MobileNotificationCenter({
  reader,
  onOpen,
  onBack,
  labels,
}: MobileNotificationCenterProps) {
  const feed = useMobileNotificationFeed(reader);
  const { intl } = useZCodeIntl();
  const [openingNotificationId, setOpeningNotificationId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const openNotification = async (notification: MobileNotification) => {
    setOpeningNotificationId(notification.notificationId);
    setOpenError(null);
    try {
      await onOpen(notification);
      void feed.refresh();
    } catch (error) {
      setOpenError(error);
    } finally {
      setOpeningNotificationId(null);
    }
  };
  const markAllRead = async () => {
    setActionError(null);
    try {
      await feed.markAllRead();
    } catch (error) {
      setActionError(error);
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label={labels.title}
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          aria-label={intl.formatMessage({ id: "common.back" })}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <h2 className="min-w-0 flex-1 text-ui-lg font-semibold">{labels.title}</h2>
        {feed.unreadCount > 0 && (
          <Button className="text-ui-sm" variant="ghost" onClick={() => void markAllRead()}>
            {labels.markAllRead}
          </Button>
        )}
      </header>
      {feed.error ? (
        <p className="text-ui-sm text-error" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.operationFailed" })}
        </p>
      ) : null}
      {feed.error ? (
        <Button
          className="mx-3 mt-2 self-start text-ui-sm"
          variant="ghost"
          onClick={() => void feed.refresh()}
        >
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      ) : null}
      {actionError ? (
        <p className="text-ui-sm text-error" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.operationFailed" })}
        </p>
      ) : null}
      {openError ? (
        <p className="text-ui-sm text-error" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.openFailed" })}
        </p>
      ) : null}
      {feed.items.length === 0 && !feed.loading ? (
        <p className="text-ui-sm text-muted-foreground">{labels.empty}</p>
      ) : null}
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {feed.items.map((notification) => (
          <li key={notification.notificationId}>
            <Button
              type="button"
              variant="outline"
              className="flex h-auto w-full flex-col items-start gap-1 rounded-lg bg-card p-3 text-left hover:bg-card-selected"
              disabled={openingNotificationId === notification.notificationId}
              onClick={() => void openNotification(notification)}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-ui-base font-medium">{notification.title}</span>
                {!notification.read ? (
                  <span className="text-ui-xs text-brand">{labels.unread}</span>
                ) : null}
              </span>
              <span className="text-ui-sm text-muted-foreground">
                {intl.formatMessage({ id: `mobileNotifications.kind.${notification.kind}` })} ·{" "}
                {notification.target.workspacePath} ·{" "}
                {new Date(notification.occurredAt).toLocaleString()}
              </span>
              {notification.recovered ? (
                <span className="text-ui-xs text-muted-foreground">{labels.recovered}</span>
              ) : null}
              {notification.resolved ? (
                <span className="text-ui-xs text-muted-foreground">{labels.resolved}</span>
              ) : null}
            </Button>
          </li>
        ))}
      </ol>
      {feed.loading ? <p className="text-ui-sm text-muted-foreground">{labels.loading}</p> : null}
      {feed.nextCursor ? (
        <Button
          className="mx-3 mb-3 text-ui-sm"
          variant="ghost"
          disabled={feed.loading}
          onClick={() => void feed.loadMore()}
        >
          {labels.loadMore}
        </Button>
      ) : null}
    </section>
  );
}
