// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IMobileNotificationReaderContract,
  MobileNotification,
  MobileNotificationPage,
} from "@zody/services/mobile-notifications";
import {
  MOBILE_FEED_MAX_PAGES,
  useMobileNotificationFeed,
} from "@/hooks/useMobileNotificationFeed.js";

function makeItem(
  notificationId: string,
  occurredAt: number,
  overrides: Partial<MobileNotification> = {},
): MobileNotification {
  return {
    notificationId,
    target: {
      backendId: "backend-1",
      workspaceKey: "/fixture/workspace",
      workspacePath: "/fixture/workspace",
      taskId: `task-${notificationId}`,
      sessionId: `session-${notificationId}`,
    },
    sourceEventId: `event-${notificationId}`,
    sourceKind: "turn.completed",
    occurredAt,
    kind: "completed",
    title: `Task ${notificationId}`,
    recovered: false,
    resolved: false,
    read: false,
    deliveryState: "accepted",
    ...overrides,
  };
}

function createReader() {
  return {
    listFeed: vi.fn(async () => ({ items: [], unreadCount: 0 })),
    getNotification: vi.fn(async () => null),
    markRead: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
    onFeedChanged: vi.fn(() => ({ dispose() {} })),
  } as unknown as IMobileNotificationReaderContract & {
    listFeed: ReturnType<typeof vi.fn>;
    onFeedChanged: ReturnType<typeof vi.fn>;
  };
}

/** 按页码生成确定性分页 mock：第 n 页含 ids 第 n 组，nextCursor 指向页尾项。 */
function createPagedReader(pageItems: MobileNotification[][]) {
  const reader = createReader();
  reader.listFeed.mockImplementation(async (input: { before?: { notificationId: string } }) => {
    const pageIndex = input.before
      ? pageItems.findIndex((page) => page.at(-1)?.notificationId === input.before!.notificationId) + 1
      : 0;
    const items = pageItems[pageIndex] ?? [];
    const tail = items.at(-1);
    return {
      items,
      ...(tail ? { nextCursor: { occurredAt: tail.occurredAt, notificationId: tail.notificationId } } : {}),
      unreadCount: pageItems.flat().filter((item) => !item.read).length,
    } satisfies MobileNotificationPage;
  });
  return reader;
}

describe("useMobileNotificationFeed", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // notify-3：feed 变化（推送 ack / 已读回执等）不得把 items 重置回第一页。
  it("feed 变化后沿已加载页数链式重拉，保留第二页内容", async () => {
    const page1 = [makeItem("n-3", 30), makeItem("n-2", 20)];
    const page2 = [makeItem("n-1", 10)];
    const reader = createPagedReader([page1, page2]);
    let feedChanged: () => void = () => {};
    reader.onFeedChanged.mockImplementation((listener: () => void) => {
      feedChanged = listener;
      return { dispose() {} };
    });

    const { result } = renderHook(() => useMobileNotificationFeed(reader));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((item) => item.notificationId)).toEqual(["n-3", "n-2"]);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((item) => item.notificationId)).toEqual([
      "n-3",
      "n-2",
      "n-1",
    ]);

    // 用户浏览第二页期间任意 feed 变化：重拉两页而不是回落到第一页。
    await act(async () => {
      feedChanged();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((item) => item.notificationId)).toEqual([
      "n-3",
      "n-2",
      "n-1",
    ]);
    expect(reader.listFeed).toHaveBeenLastCalledWith({
      before: { occurredAt: 20, notificationId: "n-2" },
      limit: 50,
    });
  });

  // notify-3：链式重拉带回最新 read/recovered 状态，后页的已读回执也能刷新。
  it("feed 变化刷新全部已加载页的已读标记", async () => {
    const page1 = [makeItem("n-3", 30)];
    const page2 = [makeItem("n-1", 10)];
    const reader = createPagedReader([page1, page2]);
    let feedChanged: () => void = () => {};
    reader.onFeedChanged.mockImplementation((listener: () => void) => {
      feedChanged = listener;
      return { dispose() {} };
    });

    const { result } = renderHook(() => useMobileNotificationFeed(reader));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.unreadCount).toBe(2);

    // 已读回执：后页 n-1 标记为已读后再触发 feed 变化。
    page2[0] = { ...page2[0], read: true };
    await act(async () => {
      feedChanged();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.items.find((item) => item.notificationId === "n-1")?.read).toBe(true);
  });

  // notify-3：点击「加载更多」的在途响应不被并发 refresh 作废——refresh 把在途页并入刷新深度，
  // 迟到的旧响应按 generation 丢弃（携带旧游标才有的 n-2b，若被应用 items 会多出一项）。
  it("loadMore 在途时 feed 变化，目标页由 refresh 链式重拉补齐，旧响应被丢弃", async () => {
    const page1 = [makeItem("n-4", 40), makeItem("n-3", 30)];
    const page2 = [makeItem("n-2", 20)];
    const reader = createReader();
    let feedChanged: () => void = () => {};
    reader.onFeedChanged.mockImplementation((listener: () => void) => {
      feedChanged = listener;
      return { dispose() {} };
    });
    // 第一个带 before 的请求（loadMore）挂起模拟弱网；refresh 链上后续 before 请求即时返回。
    let beforeCalls = 0;
    let resolveGated: (page: MobileNotificationPage) => void = () => {};
    reader.listFeed.mockImplementation(async (input: { before?: { notificationId: string } }) => {
      if (!input.before) return { items: page1, nextCursor: { occurredAt: 30, notificationId: "n-3" }, unreadCount: 2 };
      beforeCalls += 1;
      if (beforeCalls === 1) {
        return await new Promise<MobileNotificationPage>((resolve) => {
          resolveGated = resolve;
        });
      }
      return { items: page2, unreadCount: 2 };
    });

    const { result } = renderHook(() => useMobileNotificationFeed(reader));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let loadMorePromise: Promise<void> = Promise.resolve();
    await act(async () => {
      loadMorePromise = result.current.loadMore();
    });
    // loadMore 在途时 feed 变化 → refresh 以深度 2 重拉（含在途页）。
    await act(async () => {
      feedChanged();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items.map((item) => item.notificationId)).toEqual(["n-4", "n-3", "n-2"]);

    // 放行迟到的旧响应：n-2b 只存在于旧游标页，若被应用 items 将多出它。
    await act(async () => {
      resolveGated({ items: [makeItem("n-2", 20), makeItem("n-2b", 15)], unreadCount: 2 });
      await loadMorePromise;
    });
    expect(result.current.items.map((item) => item.notificationId)).toEqual(["n-4", "n-3", "n-2"]);
  });

  // perf-9：达到渲染上限后收敛 nextCursor，loadMore 不再请求，列表规模有界。
  it("分页达到上限后收敛 nextCursor 并停止追加", async () => {
    const pages: MobileNotification[][] = [];
    for (let pageIndex = 0; pageIndex < MOBILE_FEED_MAX_PAGES + 2; pageIndex++) {
      pages.push([makeItem(`n-${pageIndex}`, 1000 - pageIndex)]);
    }
    const reader = createPagedReader(pages);
    const { result } = renderHook(() => useMobileNotificationFeed(reader));
    await waitFor(() => expect(result.current.loading).toBe(false));

    for (let pageIndex = 1; pageIndex < MOBILE_FEED_MAX_PAGES; pageIndex++) {
      await act(async () => {
        await result.current.loadMore();
      });
    }
    expect(result.current.items).toHaveLength(MOBILE_FEED_MAX_PAGES);
    // 上限处 nextCursor 被收敛，继续 loadMore 是空操作且不再发起请求。
    expect(result.current.nextCursor).toBeUndefined();
    const callsAfterCap = reader.listFeed.mock.calls.length;
    await act(async () => {
      await result.current.loadMore();
    });
    expect(reader.listFeed.mock.calls.length).toBe(callsAfterCap);
  });

  // notify-3 并发防吞的另一半：链式刷新中途失败时保留原列表，只置错误态。
  it("链式刷新中途失败保留原列表并置错误态", async () => {
    const page1 = [makeItem("n-3", 30), makeItem("n-2", 20)];
    const page2 = [makeItem("n-1", 10)];
    const reader = createPagedReader([page1, page2]);
    let feedChanged: () => void = () => {};
    reader.onFeedChanged.mockImplementation((listener: () => void) => {
      feedChanged = listener;
      return { dispose() {} };
    });

    const { result } = renderHook(() => useMobileNotificationFeed(reader));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items).toHaveLength(3);

    reader.listFeed.mockRejectedValueOnce(new Error("page1 fetch failed"));
    await act(async () => {
      feedChanged();
    });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    // 失败不清空 items：用户仍可浏览旧数据。
    expect(result.current.items).toHaveLength(3);
    expect(result.current.nextCursor).toBeDefined();
  });
});
