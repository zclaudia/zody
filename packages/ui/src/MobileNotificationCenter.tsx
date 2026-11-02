import { useState } from "react";
import type { MobileNotification } from "@zcode/services/mobile-notifications";
import { useMobileNotificationFeed } from "@/hooks/useMobileNotificationFeed.js";
import type { IMobileNotificationReaderContract } from "@zcode/services/mobile-notifications";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Loader2 } from "lucide-react";

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

// notify-5/touch-8（spec D1）：手机触屏态把命中区补到 ≥44×44，视觉尺寸保持桌面尺度。
// h-7（28px）按钮用 ::after 负 inset 上下各扩 8px 到 44px；作用域按规范限定为
// (hover: none) and (pointer: coarse)（类名内下划线转空格），桌面密度不变。
const touchHitArea =
  "[@media(hover:none)_and_(pointer:coarse)]:relative " +
  "[@media(hover:none)_and_(pointer:coarse)]:after:absolute " +
  "[@media(hover:none)_and_(pointer:coarse)]:after:-inset-2 " +
  "[@media(hover:none)_and_(pointer:coarse)]:after:content-['']";

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
          className={touchHitArea}
          onClick={onBack}
          aria-label={intl.formatMessage({ id: "common.back" })}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <h2 className="min-w-0 flex-1 text-ui-lg font-semibold">{labels.title}</h2>
        {feed.unreadCount > 0 && (
          <Button
            className={`text-ui-sm ${touchHitArea}`}
            variant="ghost"
            onClick={() => void markAllRead()}
          >
            {labels.markAllRead}
          </Button>
        )}
      </header>
      {feed.error ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.operationFailed" })}
        </p>
      ) : null}
      {feed.error ? (
        <Button
          className={`mx-3 mt-2 self-start text-ui-sm ${touchHitArea}`}
          variant="ghost"
          onClick={() => void feed.refresh()}
        >
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      ) : null}
      {actionError ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.operationFailed" })}
        </p>
      ) : null}
      {openError ? (
        <p className="text-ui-sm text-destructive" role="alert">
          {intl.formatMessage({ id: "mobileNotifications.openFailed" })}
        </p>
      ) : null}
      {/* notify-6：失败与空态互斥。listFeed 失败时只显示错误 + 重试，
          不再同时渲染「暂无通知」误导用户以为当前没有通知。 */}
      {feed.items.length === 0 && !feed.loading && !feed.error ? (
        <p className="text-ui-sm text-foreground-subtle">{labels.empty}</p>
      ) : null}
      {/* notify-8：首屏加载提示放在列表区顶部，弱网首次打开不再是一页空白加页尾一行小字。 */}
      {feed.loading && feed.items.length === 0 ? (
        <p className="px-3 pt-3 text-ui-sm text-foreground-subtle">{labels.loading}</p>
      ) : null}
      <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {feed.items.map((notification) => {
          const opening = openingNotificationId === notification.notificationId;
          return (
            <li key={notification.notificationId}>
              <Button
                type="button"
                variant="outline"
                className="flex h-auto w-full flex-col items-start gap-1 rounded-lg bg-card p-3 text-left hover:bg-card-selected"
                disabled={opening}
                aria-busy={opening || undefined}
                onClick={() => void openNotification(notification)}
              >
                <span className="flex w-full items-center gap-1.5">
                  {/* notify-7：弱网打开任务可能等待数秒，被点项显示 spinner + aria-busy，
                      区分「已点击」与「无响应」，避免用户反复点击多项。 */}
                  {opening ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                  ) : null}
                  <span className="min-w-0 flex-1 text-ui-base font-medium">
                    {notification.title}
                  </span>
                  {!notification.read ? (
                    <span className="text-ui-xs text-brand">{labels.unread}</span>
                  ) : null}
                </span>
                {/* design-4/viewport-6：kind 与时间一行，超出截断，避免和路径混排后互相顶出视野。 */}
                <span className="w-full truncate text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: `mobileNotifications.kind.${notification.kind}` })} ·{" "}
                  {new Date(notification.occurredAt).toLocaleString()}
                </span>
                {/* notify-1/viewport-6：长路径独立成行，break-all 允许任意字符处换行（含
                    Windows 反斜杠、无分隔符长段），line-clamp-2 截断兜底，不再撑出横向滚动。 */}
                <span className="line-clamp-2 w-full min-w-0 break-all text-ui-sm text-foreground-subtle">
                  {notification.target.workspacePath}
                </span>
                {notification.recovered ? (
                  <span className="text-ui-xs text-foreground-subtle">{labels.recovered}</span>
                ) : null}
                {notification.resolved ? (
                  <span className="text-ui-xs text-foreground-subtle">{labels.resolved}</span>
                ) : null}
              </Button>
            </li>
          );
        })}
      </ol>
      {/* notify-8：追加翻页时的加载提示贴近「加载更多」与新增内容出现的位置。 */}
      {feed.loading && feed.items.length > 0 ? (
        <p className="px-3 pb-2 text-ui-sm text-foreground-subtle">{labels.loading}</p>
      ) : null}
      {feed.nextCursor ? (
        <Button
          className={`mx-3 mb-3 text-ui-sm ${touchHitArea}`}
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
