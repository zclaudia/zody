import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IMobileNotificationReaderContract,
  MobileNotification,
  MobileNotificationCursor,
} from "@zcode/services/mobile-notifications";

export function useMobileNotificationFeed(reader: IMobileNotificationReaderContract) {
  const [items, setItems] = useState<MobileNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<MobileNotificationCursor>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++requestGenerationRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await reader.listFeed({ limit: 50 });
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setItems(page.items);
      setUnreadCount(page.unreadCount);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setError(cause);
    } finally {
      if (generation === requestGenerationRef.current) {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [reader]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    const generation = requestGenerationRef.current;
    const cursor = nextCursor;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await reader.listFeed({ before: cursor, limit: 50 });
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.notificationId));
        const unique = page.items.filter((item) => {
          if (seen.has(item.notificationId)) return false;
          seen.add(item.notificationId);
          return true;
        });
        return [...current, ...unique];
      });
      setUnreadCount(page.unreadCount);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setError(cause);
    } finally {
      if (generation === requestGenerationRef.current) {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [nextCursor, reader]);

  useEffect(() => {
    mountedRef.current = true;
    setItems([]);
    setUnreadCount(0);
    setNextCursor(undefined);
    setError(undefined);
    void refresh();
    const subscription = reader.onFeedChanged(() => void refresh());
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      loadingRef.current = false;
      subscription.dispose();
    };
  }, [reader, refresh]);

  const markRead = useCallback(
    async (notificationId: string) => {
      await reader.markRead({ notificationId });
    },
    [reader],
  );

  const markAllRead = useCallback(async () => {
    const last = items[0];
    if (!last) return;
    const generation = requestGenerationRef.current;
    await reader.markAllRead({
      through: { occurredAt: last.occurredAt, notificationId: last.notificationId },
    });
    if (!mountedRef.current || generation !== requestGenerationRef.current) return;
    await refresh();
  }, [items, reader, refresh]);

  return {
    items,
    unreadCount,
    nextCursor,
    loading,
    error,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  };
}
