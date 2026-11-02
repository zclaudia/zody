import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IMobileNotificationReaderContract,
  MobileNotification,
  MobileNotificationCursor,
} from "@zcode/services/mobile-notifications";

// perf-9：移动端不引入虚拟化，改为分页渲染上限（4 页 × 每页 50 = 200 条）。
// 达到上限后不再追加更旧的通知并收敛 nextCursor，控制 DOM 规模与 feed 变化时
// 全量重渲染的成本。导出常量供单测与展示层对齐。
export const MOBILE_FEED_MAX_PAGES = 4;
// reader 契约校验 limit 为 1..50 的整数，保持每页 50 与既有行为一致。
const PAGE_SIZE = 50;

export function useMobileNotificationFeed(reader: IMobileNotificationReaderContract) {
  const [items, setItems] = useState<MobileNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<MobileNotificationCursor>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const loadingRef = useRef(false);
  // notify-3：记录 items 当前物化的页数。feed 变化触发的 refresh 沿同一深度
  // 链式重拉，而不是重置回第一页，用户翻到后页浏览时内容不再跳变。
  const pagesLoadedRef = useRef(1);
  // notify-3：loadMore 在途标记。feed 变化与「加载更多」并发时，refresh 把在途的
  // 那一页并入刷新深度，在途响应由新的 generation 作废，但用户点的页不会丢。
  const loadMoreInFlightRef = useRef(false);

  // notify-3：链式拉取 pageCount 页（第 1 页 → 用响应内的 nextCursor 串下一页）。
  // 沿最新顺序串页可避免新通知插到顶部后出现页间空洞；页间重复项按 id 去重。
  const loadPages = useCallback(
    async (pageCount: number) => {
      const generation = ++requestGenerationRef.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        let collected: MobileNotification[] = [];
        let unread = 0;
        let cursor: MobileNotificationCursor | undefined;
        let trailingCursor: MobileNotificationCursor | undefined;
        let loaded = 0;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
          // 串页游标一律使用服务返回的 nextCursor，不自行用列表末项拼装，
          // 保证与 loadMore 的翻页语义一致（cursor 可能带服务侧独占边界）。
          const page = await reader.listFeed({
            ...(cursor ? { before: cursor } : {}),
            limit: PAGE_SIZE,
          });
          if (!mountedRef.current || generation !== requestGenerationRef.current) return;
          const seen = new Set(collected.map((item) => item.notificationId));
          collected = [
            ...collected,
            ...page.items.filter((item) => !seen.has(item.notificationId)),
          ];
          unread = page.unreadCount;
          trailingCursor = page.nextCursor;
          loaded = pageIndex + 1;
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        pagesLoadedRef.current = loaded;
        setItems(collected);
        setUnreadCount(unread);
        // perf-9：达到渲染上限后收敛 nextCursor，让展示层隐藏「加载更多」入口。
        setNextCursor(loaded >= MOBILE_FEED_MAX_PAGES ? undefined : trailingCursor);
        setError(undefined);
      } catch (cause) {
        if (!mountedRef.current || generation !== requestGenerationRef.current) return;
        // 链式刷新中途失败：保留原列表（可能含旧数据）只提示错误，不清空 items，
        // 避免弱网下一次失败的 feed 变化把用户正在浏览的列表抹掉。
        setError(cause);
      } finally {
        if (generation === requestGenerationRef.current) {
          loadingRef.current = false;
          if (mountedRef.current) setLoading(false);
        }
      }
    },
    [reader],
  );

  const refresh = useCallback(async () => {
    // notify-3（并发防吞）：depth 取「已加载页数 +（loadMore 在途则 +1）」并夹在上限内。
    // refresh 提升 generation 后，在途 loadMore 的响应会被丢弃，但其目标页已并入本次
    // 重拉，用户的点击不会静默失效；晚到的旧 refresh 响应同样被最新 generation 屏蔽。
    const depth = Math.min(
      Math.max(1, pagesLoadedRef.current + (loadMoreInFlightRef.current ? 1 : 0)),
      MOBILE_FEED_MAX_PAGES,
    );
    await loadPages(depth);
  }, [loadPages]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingRef.current) return;
    // perf-9：达到渲染上限后不再请求更旧的页。
    if (pagesLoadedRef.current >= MOBILE_FEED_MAX_PAGES) return;
    // 不提升 generation：并发到达的 refresh 视为更新的事实，本页响应按旧 generation 作废。
    const generation = requestGenerationRef.current;
    const cursor = nextCursor;
    loadingRef.current = true;
    loadMoreInFlightRef.current = true;
    setLoading(true);
    try {
      const page = await reader.listFeed({ before: cursor, limit: PAGE_SIZE });
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
      pagesLoadedRef.current += 1;
      setNextCursor(
        pagesLoadedRef.current >= MOBILE_FEED_MAX_PAGES ? undefined : page.nextCursor,
      );
      setError(undefined);
    } catch (cause) {
      if (!mountedRef.current || generation !== requestGenerationRef.current) return;
      setError(cause);
    } finally {
      loadMoreInFlightRef.current = false;
      if (generation === requestGenerationRef.current) {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    }
  }, [nextCursor, reader]);

  useEffect(() => {
    mountedRef.current = true;
    pagesLoadedRef.current = 1;
    loadMoreInFlightRef.current = false;
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
    // refresh 沿当前已加载页数重拉，已读回执会刷新全部已物化页（含后页）的 read 标记。
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
