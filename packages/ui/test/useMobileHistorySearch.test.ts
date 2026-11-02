// @vitest-environment jsdom
import { createElement } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MobileHistorySearchItem,
  MobileHistorySearchOutcome,
  MobileHistorySearchRequest,
} from "@zody/shared";
import {
  clearMobileHistorySearchSessionForTest,
  useMobileHistorySearch,
} from "../src/hooks/useMobileHistorySearch.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { WebRemoteControlMobileSearch } from "../src/WebRemoteControlMobileSearch.js";

function workspace(index: number) {
  return { workspacePath: `/work/${index}`, workspaceIdentity: `identity-${index}` };
}

function item(
  taskId: string,
  workspaceKey: string,
  timestamps: { updatedAt?: number; createdAt?: number } = {},
): MobileHistorySearchItem {
  return {
    task: {
      taskId,
      traceId: `trace-${taskId}`,
      title: `Task ${taskId}`,
      workspacePath: `/work/${workspaceKey}`,
      createdAt: timestamps.createdAt ?? 900,
      updatedAt: timestamps.updatedAt ?? 1000,
      mode: "default",
    },
    workspaceKey,
    snippets: [],
  };
}

function response(
  request: MobileHistorySearchRequest,
  items: MobileHistorySearchItem[] = [],
): MobileHistorySearchOutcome {
  return {
    zcode_type: "mobile-history-search-outcome",
    requestId: request.requestId,
    context: request.context,
    queryGeneration: request.queryGeneration,
    scopeSignature: request.scopeSignature,
    status: "ok",
    items,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const connection = { backendId: "backend-1", connectionGeneration: 1 };

beforeEach(() => {
  // 搜索会话 store 是模块级单例，必须逐用例清空，避免上个用例的会话被恢复。
  clearMobileHistorySearchSessionForTest();
});

afterEach(() => {
  clearMobileHistorySearchSessionForTest();
});

describe("useMobileHistorySearch", () => {
  it("limits in-flight workspace queries to four and returns one outcome per scope", async () => {
    const pending: Array<{
      request: MobileHistorySearchRequest;
      item: ReturnType<typeof deferred<MobileHistorySearchOutcome>>;
    }> = [];
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      const item = deferred<MobileHistorySearchOutcome>();
      pending.push({ request, item });
      return item.promise;
    });
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: Array.from({ length: 6 }, (_, index) => workspace(index)),
        connection,
        send,
        createRequestId: vi.fn(() => `request-${send.mock.calls.length}`),
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    let search!: Promise<void>;
    act(() => {
      search = hook.result.current.runSearch();
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    for (let index = 0; index < 6; index += 1) {
      await act(async () => {
        pending[index]!.item.resolve(response(pending[index]!.request));
        await Promise.resolve();
      });
      if (index < 5) {
        await waitFor(() => expect(send).toHaveBeenCalledTimes(Math.min(index + 5, 6)));
      }
    }
    await act(async () => search);
    await waitFor(() => expect(hook.result.current.outcomes).toHaveLength(6));
    expect(send).toHaveBeenCalledTimes(6);
    expect(hook.result.current.isSearching).toBe(false);
  });

  it("ignores a delayed response from a superseded query generation", async () => {
    const old = deferred<MobileHistorySearchOutcome>();
    const send = vi.fn((request: MobileHistorySearchRequest) =>
      request.query === "first" ? old.promise : Promise.resolve(response(request)),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1)],
        connection,
        send,
        createRequestId: vi.fn(() => "request"),
      }),
    );
    act(() => hook.result.current.setQuery("first"));
    let firstSearch!: Promise<void>;
    act(() => {
      firstSearch = hook.result.current.runSearch();
    });
    act(() => hook.result.current.setQuery("second"));
    await act(async () => {
      await hook.result.current.runSearch();
      old.resolve(response(send.mock.calls[0]![0]));
      await firstSearch;
    });
    expect(hook.result.current.submittedQuery).toBe("second");
    expect(hook.result.current.outcomes).toHaveLength(1);
    expect(hook.result.current.outcomes[0]?.queryGeneration).toBe(2);
  });

  it("reissues the submitted query when the authorized workspace directory changes", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) => response(request));
    const hook = renderHook(
      ({ workspaces }: { workspaces: ReturnType<typeof workspace>[] }) =>
        useMobileHistorySearch({
          workspaces,
          connection,
          send,
          createRequestId: () => `request-${send.mock.calls.length}`,
        }),
      { initialProps: { workspaces: [workspace(1)] } },
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());
    expect(send).toHaveBeenCalledTimes(1);

    hook.rerender({ workspaces: [workspace(1), workspace(2)] });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.slice(1).map(([request]) => request.query)).toEqual([
      "needle",
      "needle",
    ]);
    expect(send.mock.calls[1]?.[0].scopeSignature).toBe(
      JSON.stringify(["identity-1", "identity-2"]),
    );
    await waitFor(() => expect(hook.result.current.outcomes).toHaveLength(2));
  });

  it("expands only the submitted query and does not resurrect a cleared query on scope change", async () => {
    // 扩容入口现在要求上一轮结果打满 limit（canShowMore 修复），
    // 这里让每个 source 返回满页 50 条，保证 showMore 可用。
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(
        request,
        Array.from({ length: request.limit }, (_, index) =>
          item(`${request.context.workspaceKey}-task-${index}`, request.context.workspaceKey),
        ),
      ),
    );
    const hook = renderHook(
      ({ workspaces }) =>
        useMobileHistorySearch({
          workspaces,
          connection,
          send,
          createRequestId: () => `r-${send.mock.calls.length}`,
        }),
      { initialProps: { workspaces: [workspace(1)] } },
    );
    act(() => hook.result.current.setQuery("submitted"));
    await act(async () => hook.result.current.runSearch());
    expect(send.mock.calls[0]?.[0]).toMatchObject({ query: "submitted", limit: 50 });
    act(() => hook.result.current.setQuery("unsubmitted draft"));
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(send.mock.calls[1]?.[0]).toMatchObject({ query: "submitted", limit: 100 });
    act(() => hook.result.current.setQuery(""));
    await act(async () => hook.result.current.runSearch());
    hook.rerender({ workspaces: [workspace(1), workspace(2)] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(hook.result.current.outcomes).toEqual([]);
  });

  it("MS02: sends one request per distinct workspaceKey and keeps duplicate taskIds separate", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(request, [item("same-task", request.context.workspaceKey)]),
    );
    const duplicate = { ...workspace(1), workspacePath: "/work/1-alias" };
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1), duplicate, workspace(2)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());

    // 重复 workspaceKey 只按 key 去重一次，不会对同一 Host 发两次搜索。
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([request]) => request.context.workspaceKey).sort()).toEqual([
      "identity-1",
      "identity-2",
    ]);
    // 两个 source 返回相同 taskId 时是两个独立实体（不同 workspace），不能合并。
    expect(hook.result.current.items).toHaveLength(2);
    expect(hook.result.current.items.map((entry) => entry.workspaceKey).sort()).toEqual([
      "identity-1",
      "identity-2",
    ]);
  });

  it("MS03: a rejected scope becomes an error outcome while the other scope still succeeds", async () => {
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      if (request.context.workspaceKey === "identity-1") {
        return Promise.reject(new Error("old desktop build"));
      }
      return Promise.resolve(response(request));
    });
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1), workspace(2)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());

    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    const outcomesByKey = new Map(
      hook.result.current.outcomes.map((outcome) => [outcome.context.workspaceKey, outcome]),
    );
    expect(outcomesByKey.get("identity-1")).toMatchObject({
      status: "error",
      errorCode: "search-request-failed",
    });
    expect(outcomesByKey.get("identity-2")).toMatchObject({ status: "ok" });
    // 有 source 失败时即便结果为 0 也不能显示 noResults（组件按 every(ok) 判定）。
    expect(hook.result.current.outcomes.every((outcome) => outcome.status === "ok")).toBe(false);
    expect(hook.result.current.items).toHaveLength(0);
  });

  it("MS04: toggling includeArchived re-runs the submitted query once and resets limit to 50", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(
        request,
        Array.from({ length: request.limit }, (_, index) =>
          item(`task-${index}`, request.context.workspaceKey),
        ),
      ),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());
    expect(send).toHaveBeenCalledTimes(1);
    expect(hook.result.current.limit).toBe(50);

    act(() => hook.result.current.showMore());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.limit).toBe(100));

    act(() => hook.result.current.setIncludeArchived(true));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      query: "needle",
      includeArchived: true,
      limit: 50,
    });
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(hook.result.current.limit).toBe(50);
    expect(hook.result.current.includeArchived).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("MS05: a superseded round stops issuing remaining scope requests after a scope change", async () => {
    const pendingByGeneration = new Map<
      number,
      Array<{ request: MobileHistorySearchRequest; deferred: ReturnType<typeof deferred<MobileHistorySearchOutcome>> }>
    >();
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      const pending = deferred<MobileHistorySearchOutcome>();
      const list = pendingByGeneration.get(request.queryGeneration) ?? [];
      list.push({ request, deferred: pending });
      pendingByGeneration.set(request.queryGeneration, list);
      return pending.promise;
    });
    const initialWorkspaces = Array.from({ length: 6 }, (_, index) => workspace(index));
    const hook = renderHook(
      ({ workspaces }: { workspaces: ReturnType<typeof workspace>[] }) =>
        useMobileHistorySearch({
          workspaces,
          connection,
          send,
          createRequestId: () => `r-${send.mock.calls.length}`,
        }),
      { initialProps: { workspaces: initialWorkspaces } },
    );
    act(() => hook.result.current.setQuery("needle"));
    let firstSearch!: Promise<void>;
    act(() => {
      firstSearch = hook.result.current.runSearch();
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(4));

    // 旧轮 4 个请求 in-flight 时目录扩容：scope 变化触发新一轮（scope-change
    // effect 会先 bump generation 再由 runSearch 递增，新轮 generation 一定更大）。
    const supersededGeneration = send.mock.calls[0]![0].queryGeneration;
    hook.rerender({
      workspaces: [...initialWorkspaces, workspace(6), workspace(7)],
    });
    await waitFor(() =>
      expect(
        send.mock.calls.filter(([request]) => request.queryGeneration !== supersededGeneration)
          .length,
      ).toBe(4),
    );

    // 放行旧轮 4 个 in-flight 请求：旧 worker 醒来后必须在下一次迭代前早退，
    // 不再发放 identity-5/6 的请求（此前旧轮会把剩余 scope 全部发完）。
    await act(async () => {
      const oldPending = pendingByGeneration.get(supersededGeneration) ?? [];
      pendingByGeneration.set(supersededGeneration, []);
      for (const entry of oldPending) entry.deferred.resolve(response(entry.request));
      await Promise.resolve();
    });
    await act(async () => firstSearch);
    expect(
      send.mock.calls.filter(([request]) => request.queryGeneration === supersededGeneration),
    ).toHaveLength(4);

    // 新一轮覆盖全部 8 个 scope 后正常收敛。
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        const list =
          pendingByGeneration.get(
            send.mock.calls[send.mock.calls.length - 1]![0].queryGeneration,
          ) ?? [];
        for (const generationKey of pendingByGeneration.keys()) {
          if (generationKey !== supersededGeneration) {
            pendingByGeneration.set(generationKey, []);
          }
        }
        for (const entry of list) entry.deferred.resolve(response(entry.request));
        await Promise.resolve();
      });
    }
    await waitFor(() =>
      expect(
        send.mock.calls.filter(([request]) => request.queryGeneration !== supersededGeneration),
      ).toHaveLength(8),
    );
    await waitFor(() => expect(hook.result.current.outcomes).toHaveLength(8));
    expect(hook.result.current.isSearching).toBe(false);
  });

  it("MS07: orders identical timestamps deterministically and caps expansion at 200", async () => {
    const workspaceOne = workspace(1);
    const workspaceTwo = workspace(2);
    const itemsByKey = new Map([
      // 205 条分布在 2 个 source，updatedAt/createdAt 全部相同。
      [
        "identity-1",
        Array.from({ length: 103 }, (_, index) => item(`task-a-${index}`, "identity-1")),
      ],
      [
        "identity-2",
        Array.from({ length: 102 }, (_, index) => item(`task-b-${index}`, "identity-2")),
      ],
    ]);
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(request, itemsByKey.get(request.context.workspaceKey) ?? []),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspaceOne, workspaceTwo],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());

    // 确定序：时间全同 → workspaceKey 码点升序，同 source 内 taskId 码点降序。
    expect(hook.result.current.items).toHaveLength(50);
    const expectedFirstFifty = [
      ...[...itemsByKey.get("identity-1")!]
        .map((entry) => entry.task.taskId)
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)),
      ...[...itemsByKey.get("identity-2")!]
        .map((entry) => entry.task.taskId)
        .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0)),
    ].slice(0, 50);
    expect(hook.result.current.items.map((entry) => entry.task.taskId)).toEqual(
      expectedFirstFifty,
    );
    expect(hook.result.current.canShowMore).toBe(true);

    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.limit).toBe(100));
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(hook.result.current.items).toHaveLength(100);
    expect(hook.result.current.canShowMore).toBe(true);

    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.limit).toBe(200));
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(hook.result.current.items).toHaveLength(200);
    // 200 是协议上限：即便原始结果打满也不再提供扩容入口。
    expect(hook.result.current.canShowMore).toBe(false);
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("MS07: canShowMore is false when the previous round did not fill the limit", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(request, [
        item("task-1", request.context.workspaceKey),
        item("task-2", request.context.workspaceKey),
        item("task-3", request.context.workspaceKey),
      ]),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());

    expect(hook.result.current.items).toHaveLength(3);
    // 3 条结果没有打满 limit=50，不能提示 "Show up to 100"。
    expect(hook.result.current.canShowMore).toBe(false);
    act(() => hook.result.current.showMore());
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("MS08: blank or oversize queries are not sent and clear previous outcomes", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(request, [item("task-1", request.context.workspaceKey)]),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());
    expect(send).toHaveBeenCalledTimes(1);
    expect(hook.result.current.outcomes).toHaveLength(1);

    act(() => hook.result.current.setQuery("   "));
    await act(async () => hook.result.current.runSearch());
    expect(send).toHaveBeenCalledTimes(1);
    expect(hook.result.current.outcomes).toEqual([]);
    expect(hook.result.current.submittedQuery).toBe("");

    act(() => hook.result.current.setQuery("x".repeat(257)));
    await act(async () => hook.result.current.runSearch());
    expect(send).toHaveBeenCalledTimes(1);
    expect(hook.result.current.outcomes).toEqual([]);
    expect(hook.result.current.submittedQuery).toBe("");
  });

  it("MS08: a rejected send yields a single error outcome without a retry loop", async () => {
    const send = vi.fn((_: MobileHistorySearchRequest) =>
      Promise.reject(new Error("legacy desktop")),
    );
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());

    expect(hook.result.current.outcomes).toHaveLength(1);
    expect(hook.result.current.outcomes[0]).toMatchObject({
      status: "error",
      errorCode: "search-request-failed",
    });
    // 给可能的自动重试留出时间：hook 不存在自动重试循环。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(hook.result.current.outcomes).toHaveLength(1);
  });

  it("MS03: retryScope re-sends only the failed scope with the current query settings", async () => {
    let failFirstScope = true;
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      if (request.context.workspaceKey === "identity-1" && failFirstScope) {
        return Promise.reject(new Error("transient"));
      }
      return Promise.resolve(
        response(request, [item(`${request.context.workspaceKey}-task`, request.context.workspaceKey)]),
      );
    });
    const hook = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(1), workspace(2)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    act(() => hook.result.current.setQuery("needle"));
    await act(async () => hook.result.current.runSearch());
    await waitFor(() => expect(hook.result.current.isSearching).toBe(false));
    expect(send).toHaveBeenCalledTimes(2);
    const failedOutcome = hook.result.current.outcomes.find(
      (outcome) => outcome.context.workspaceKey === "identity-1",
    );
    const okOutcome = hook.result.current.outcomes.find(
      (outcome) => outcome.context.workspaceKey === "identity-2",
    );
    expect(failedOutcome).toMatchObject({ status: "error" });
    expect(okOutcome).toMatchObject({ status: "ok" });

    failFirstScope = false;
    let retry!: Promise<void>;
    await act(async () => {
      retry = hook.result.current.retryScope("identity-1");
      await retry;
    });

    // 只补发失败 scope 的一个请求，成功 scope 不重发。
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      query: "needle",
      includeArchived: false,
      limit: 50,
      context: { workspaceKey: "identity-1" },
    });
    const outcomesByKey = new Map(
      hook.result.current.outcomes.map((outcome) => [outcome.context.workspaceKey, outcome]),
    );
    expect(outcomesByKey.get("identity-1")).toMatchObject({ status: "ok" });
    // 未重试的 outcome 保持原引用，证明没有被整轮重建。
    expect(outcomesByKey.get("identity-2")).toBe(okOutcome);
    expect(hook.result.current.items.map((entry) => entry.workspaceKey).sort()).toEqual([
      "identity-1",
      "identity-2",
    ]);
    expect(hook.result.current.retryingScopes).toEqual([]);
  });

  it("MS09: restores query, outcomes and limit when the overlay remounts", async () => {
    const send = vi.fn(async (request: MobileHistorySearchRequest) =>
      response(
        request,
        Array.from({ length: request.limit }, (_, index) =>
          item(`task-${index}`, request.context.workspaceKey),
        ),
      ),
    );
    const props = {
      workspaces: [workspace(1)] as const,
      connection,
      send,
      createRequestId: () => `r-${send.mock.calls.length}`,
    };
    const first = renderHook(() => useMobileHistorySearch(props));
    act(() => first.result.current.setQuery("needle"));
    await act(async () => first.result.current.runSearch());
    act(() => first.result.current.showMore());
    await waitFor(() => expect(first.result.current.limit).toBe(100));
    await waitFor(() => expect(first.result.current.isSearching).toBe(false));
    // 输入框里保留一个未提交草稿。
    act(() => first.result.current.setQuery("needle draft"));
    const outcomesBeforeClose = first.result.current.outcomes;
    first.unmount();

    const second = renderHook(() => useMobileHistorySearch(props));
    // 关闭再打开：查询草稿、提交态、扩容后的 limit 与 outcomes 全部保留。
    expect(second.result.current.query).toBe("needle draft");
    expect(second.result.current.submittedQuery).toBe("needle");
    expect(second.result.current.limit).toBe(100);
    expect(second.result.current.outcomes).toEqual(outcomesBeforeClose);
    expect(second.result.current.items).toHaveLength(100);
    expect(second.result.current.isSearching).toBe(false);
    // 上一轮 100 条打满 limit=100，扩容入口仍然可用。
    expect(second.result.current.canShowMore).toBe(true);
    second.unmount();
  });

  it("MS09: does not restore across a different scope and re-runs incomplete restored rounds", async () => {
    const pending: Array<{
      request: MobileHistorySearchRequest;
      deferred: ReturnType<typeof deferred<MobileHistorySearchOutcome>>;
    }> = [];
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      const pendingEntry = deferred<MobileHistorySearchOutcome>();
      pending.push({ request, deferred: pendingEntry });
      return pendingEntry.promise;
    });
    const firstProps = {
      workspaces: [workspace(1), workspace(2)] as const,
      connection,
      send,
      createRequestId: () => `r-${send.mock.calls.length}`,
    };
    const first = renderHook(() => useMobileHistorySearch(firstProps));
    act(() => first.result.current.setQuery("needle"));
    await act(async () => {
      void first.result.current.runSearch();
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // 只放行 identity-1，identity-2 仍 in-flight 时关闭 overlay：恢复的会话不完整。
    await act(async () => {
      pending[0]!.deferred.resolve(response(pending[0]!.request));
      await Promise.resolve();
    });
    await waitFor(() => expect(first.result.current.outcomes).toHaveLength(1));
    first.unmount();

    // scope 未变，重新挂载：恢复的会话（submittedQuery 来自模块级 store）覆盖不到
    // identity-2，挂载后必须补发一轮让结果收敛（而不是永远停在 pending 提示）。
    // 补发轮开始时会先清空 outcomes，所以这里断言提交态与补发行为，而非中间 outcomes。
    const second = renderHook(() => useMobileHistorySearch(firstProps));
    expect(second.result.current.submittedQuery).toBe("needle");
    await waitFor(() => expect(send.mock.calls.length).toBe(4));
    expect(send.mock.calls[2]?.[0].context.workspaceKey).toBe("identity-1");
    expect(send.mock.calls[3]?.[0].context.workspaceKey).toBe("identity-2");
    await act(async () => {
      pending[2]!.deferred.resolve(response(pending[2]!.request));
      pending[3]!.deferred.resolve(response(pending[3]!.request));
      await Promise.resolve();
    });
    await waitFor(() => expect(second.result.current.outcomes).toHaveLength(2));
    second.unmount();

    // 换一个 scopeKey（目录变化）重新挂载：旧会话不可恢复，状态全新。
    const third = renderHook(() =>
      useMobileHistorySearch({
        workspaces: [workspace(9)],
        connection,
        send,
        createRequestId: () => `r-${send.mock.calls.length}`,
      }),
    );
    expect(third.result.current.query).toBe("");
    expect(third.result.current.submittedQuery).toBe("");
    expect(third.result.current.outcomes).toEqual([]);
    third.unmount();
  });

  it("MS03: the failed source row offers a Retry that re-sends only that scope", async () => {
    let failFirstScope = true;
    const send = vi.fn((request: MobileHistorySearchRequest) => {
      if (request.context.workspaceKey === "identity-1" && failFirstScope) {
        return Promise.reject(new Error("transient"));
      }
      return Promise.resolve(
        response(request, [item("task-1", request.context.workspaceKey)]),
      );
    });
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(WebRemoteControlMobileSearch, {
          workspaces: [workspace(1), workspace(2)],
          connection,
          send,
          createRequestId: () => `r-${send.mock.calls.length}`,
          onSelectTask: vi.fn(),
          onBack: vi.fn(),
        }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Search titles and messages"), {
      target: { value: "needle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.getByText("A workspace could not be searched.")).toBeTruthy(),
    );

    failFirstScope = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.getByText("Task task-1"),
      ).toBeTruthy(),
    );
    // 重试只补发失败 scope，成功 scope 不重发。
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0].context.workspaceKey).toBe("identity-1");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
