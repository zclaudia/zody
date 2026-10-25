// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IMobileNotificationReaderContract } from "@zcode/services/mobile-notifications";
import { MobileNotificationCenter } from "@/MobileNotificationCenter.js";
import { MobileNotificationsFeature } from "@/MobileNotificationsFeature.js";

const platformState = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => platformState.value,
}));

const labels = {
  title: "Notifications",
  markAllRead: "Mark all read",
  loading: "Loading",
  loadMore: "Load more",
  empty: "No notifications",
  recovered: "Recovered",
  resolved: "Resolved",
  unread: "Unread",
};

function createReader() {
  return {
    listFeed: vi.fn(async () => ({
      items: [
        {
          notificationId: "notification-1",
          target: { workspacePath: "/fixture/workspace" },
          title: "Build completed",
          occurredAt: 1,
          read: false,
          recovered: false,
          resolved: false,
          sourceKind: "task-completed",
          kind: "completed",
          deliveryState: "accepted",
        },
      ],
      unreadCount: 1,
    })),
    onFeedChanged: () => ({ dispose() {} }),
    markRead: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
  } as unknown as IMobileNotificationReaderContract;
}

function createNotificationSwitcher(reader = createReader()) {
  return {
    getNotificationReader: () => reader,
    openNotification: vi.fn(async () => {}),
  } as unknown as import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
}

describe("MobileNotificationCenter", () => {
  afterEach(cleanup);

  it("delegates opening and does not mark read before the route succeeds", async () => {
    platformState.value = null;
    const reader = createReader();
    const onOpen = vi.fn(async () => {
      throw new Error("target workspace is unavailable");
    });
    render(
      createElement(MobileNotificationCenter, {
        reader,
        onOpen,
        onBack: vi.fn(),
        labels,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /Build completed/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("mobileNotifications.openFailed"),
    );
    expect(onOpen).toHaveBeenCalledOnce();
    expect(reader.markRead).not.toHaveBeenCalled();
  });

  it("shows a retry action when feed loading fails", async () => {
    platformState.value = null;
    const reader = createReader();
    reader.listFeed = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary feed failure"))
      .mockResolvedValue({ items: [], unreadCount: 0 });
    render(
      createElement(MobileNotificationCenter, {
        reader,
        onOpen: vi.fn(async () => {}),
        onBack: vi.fn(),
        labels,
      }),
    );

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(screen.getByText("No notifications")).toBeTruthy());
    expect(reader.listFeed).toHaveBeenCalledTimes(2);
  });

  it("surfaces mark-all-read failures without dismissing the feed", async () => {
    platformState.value = null;
    const reader = createReader();
    reader.markAllRead = vi.fn(async () => {
      throw new Error("receipt write failed");
    });
    render(
      createElement(MobileNotificationCenter, {
        reader,
        onOpen: vi.fn(async () => {}),
        onBack: vi.fn(),
        labels,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "mobileNotifications.operationFailed",
      ),
    );
    expect(reader.markAllRead).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Build completed/ })).toBeTruthy();
  });

  it("loadMore 以当前页尾 cursor 请求第二页并按 notificationId 去重 (MN10)", async () => {
    platformState.value = null;
    const reader = createReader();
    const item = (notificationId: string, occurredAt: number) => ({
      notificationId,
      target: { workspacePath: "/fixture/workspace" },
      title: `Task ${notificationId}`,
      occurredAt,
      read: false,
      recovered: false,
      resolved: false,
      sourceKind: "task-completed",
      kind: "completed",
      deliveryState: "accepted",
    });
    const firstPage = {
      items: [item("notification-3", 30), item("notification-2", 20)],
      nextCursor: { occurredAt: 20, notificationId: "notification-2" },
      unreadCount: 2,
    };
    // 第二页重复返回已在第一页出现的 notification-2，模拟 cursor 边界重放。
    const secondPage = {
      items: [item("notification-2", 20), item("notification-1", 10)],
      unreadCount: 2,
    };
    reader.listFeed = vi.fn(async (input: { before?: unknown }) =>
      input.before ? secondPage : firstPage,
    );
    render(
      createElement(MobileNotificationCenter, {
        reader,
        onOpen: vi.fn(async () => {}),
        onBack: vi.fn(),
        labels,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /notification-1/ });
    expect(reader.listFeed).toHaveBeenCalledTimes(2);
    expect(reader.listFeed).toHaveBeenNthCalledWith(2, {
      before: { occurredAt: 20, notificationId: "notification-2" },
      limit: 50,
    });
    // 重复的 notification-2 只渲染一次；getByRole 在重复时会因多匹配失败。
    expect(screen.getByRole("button", { name: /notification-2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /notification-3/ })).toBeTruthy();
  });

  it("Mark all read 提交最新一项 cursor，loadMore 多页后不吞并发新通知 (MN04)", async () => {
    platformState.value = null;
    const reader = createReader();
    const item = (notificationId: string, occurredAt: number) => ({
      notificationId,
      target: { workspacePath: "/fixture/workspace" },
      title: `Task ${notificationId}`,
      occurredAt,
      read: false,
      recovered: false,
      resolved: false,
      sourceKind: "task-completed",
      kind: "completed",
      deliveryState: "accepted",
    });
    const firstPage = {
      items: [item("notification-3", 30), item("notification-2", 20)],
      nextCursor: { occurredAt: 20, notificationId: "notification-2" },
      unreadCount: 2,
    };
    const secondPage = { items: [item("notification-1", 10)], unreadCount: 2 };
    reader.listFeed = vi.fn(async (input: { before?: unknown }) =>
      input.before ? secondPage : firstPage,
    );
    render(
      createElement(MobileNotificationCenter, {
        reader,
        onOpen: vi.fn(async () => {}),
        onBack: vi.fn(),
        labels,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByRole("button", { name: /notification-1/ });
    // 加载了更旧的一页之后，Mark all read 仍以列表第一项（最新事件）作为 through cursor，
    // 避免把 occurredAt 更大的并发新通知一并标记已读。
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(reader.markAllRead).toHaveBeenCalledOnce());
    expect(reader.markAllRead).toHaveBeenCalledWith({
      through: { occurredAt: 30, notificationId: "notification-3" },
    });
  });

  it("explains web delivery limits when no native push bridge exists", async () => {
    platformState.value = {};
    render(
      createElement(MobileNotificationsFeature, {
        switcher: createNotificationSwitcher(),
        onBack: vi.fn(),
      }),
    );
    expect(await screen.findByText("mobileNotifications.push.webOnly")).toBeTruthy();
  });

  it("requests native permission when blocked and refreshes the push status", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "permission-denied" })
      .mockResolvedValueOnce({ status: "ready" });
    const requestPermission = vi.fn(async () => {});
    platformState.value = { mobileNotifications: { getStatus, requestPermission } };
    render(
      createElement(MobileNotificationsFeature, {
        switcher: createNotificationSwitcher(),
        onBack: vi.fn(),
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "mobileNotifications.push.requestPermission" }),
    );
    await waitFor(() => expect(screen.getByText("mobileNotifications.push.ready")).toBeTruthy());
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
  it("refreshes permission from the native result event and labels test delivery as submitted", async () => {
    let notify = () => {};
    const getStatus = vi.fn().mockResolvedValue({ status: "permission-denied" });
    platformState.value = {
      mobileNotifications: {
        getStatus,
        onStatusChanged: (listener: () => void) => {
          notify = listener;
          return () => {};
        },
      },
    };
    const testNotification = vi.fn().mockResolvedValue(undefined);
    render(
      createElement(MobileNotificationsFeature, {
        switcher: { ...createNotificationSwitcher(), testNotification } as never,
        onBack: vi.fn(),
      }),
    );
    await screen.findByText("mobileNotifications.push.permission-denied");
    getStatus.mockResolvedValue({ status: "ready" });
    notify();
    await screen.findByText("mobileNotifications.push.ready");
    fireEvent.click(screen.getByRole("button", { name: "mobileNotifications.test.send" }));
    await screen.findByText("mobileNotifications.test.accepted");
    expect(testNotification).toHaveBeenCalledOnce();
  });
});
