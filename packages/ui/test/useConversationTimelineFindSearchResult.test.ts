// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import {
  SEARCH_RESULT_HIGHLIGHT_NAME,
  ensureConversationFindHighlightStyle,
} from "@/v4/conversationFindHighlightDom.js";
import {
  useConversationTimelineFind,
  type UseConversationTimelineFindOptions,
} from "@/v4/useConversationTimelineFind.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";

function baseRow<T extends ConversationRow>(
  row: Omit<T, "createdAt" | "createdAtSeq" | "rowId" | "turnId"> & {
    rowId: number;
    turnId?: string;
  },
): T {
  return {
    createdAt: 1_700_000_000_000 + row.rowId,
    createdAtSeq: row.rowId,
    turnId: row.turnId ?? "turn-1",
    ...row,
  } as T;
}

function turnHeader(rowId: number, turnId = "turn-1"): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
  });
}

function userInput(rowId: number, text: string, turnId = "turn-1"): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin: "realUser",
  });
}

function assistantText(rowId: number, text: string, turnId = "turn-1"): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

const olderRows: ConversationRow[] = [
  turnHeader(1),
  userInput(2, "needle question about history"),
  assistantText(3, "needle answer in older turn"),
];
const newerRows: ConversationRow[] = [
  turnHeader(10, "turn-2"),
  userInput(11, "latest message", "turn-2"),
  assistantText(12, "latest answer", "turn-2"),
];

class FakeHighlight {
  ranges: Range[];
  priority?: number;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

const highlightRegistry = new Map<string, FakeHighlight>();

function mountTimelineRow(root: HTMLElement, rowId: number, text: string) {
  const row = document.createElement("div");
  row.setAttribute("data-row-id", String(rowId));
  row.textContent = text;
  root.append(row);
}

function createSearchRequest(
  overrides: Partial<ChatSearchResultHighlightRequest> = {},
): ChatSearchResultHighlightRequest {
  return {
    requestId: 41,
    taskId: "task-1",
    workspacePath: "/repo",
    query: "needle",
    snippet: "...needle answer in older turn...",
    ...overrides,
  };
}

let root: HTMLDivElement;
let scrollToUnit: ReturnType<typeof vi.fn>;
let onLoadOlder: ReturnType<typeof vi.fn>;
let onSearchResultHighlightDone: ReturnType<typeof vi.fn>;

function hookProps(
  rows: readonly ConversationRow[],
  overrides: Partial<UseConversationTimelineFindOptions> = {},
): UseConversationTimelineFindOptions {
  return {
    rootRef: { current: root },
    rows,
    renderUnits: buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 }),
    mountedRowsKey: "mounted",
    canLoadOlder: false,
    loadingOlder: false,
    onLoadOlder,
    conversationFindQuery: "",
    conversationFindActiveIndex: -1,
    conversationFindNavigationRequestId: 0,
    searchResultHighlightRequest: null,
    onSearchResultHighlightDone,
    scrollToUnit,
    ...overrides,
  };
}

// jsdom 默认没有可等待的 rAF；同步执行帧回调让高亮在 effect 提交后立即生效，
// 3s 清理计时器仍走 (fake/real) setTimeout，可以单独推进验证。
const synchronousRequestAnimationFrame = (callback: FrameRequestCallback): number => {
  callback(Date.now());
  return 1;
};

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", synchronousRequestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  // jsdom 没有 CSS Custom Highlight API；用最小 fake 让 applySearchResultHighlight
  // 走真实 Range 构建，验证高亮注册表确实收到该 range。
  highlightRegistry.clear();
  vi.stubGlobal("Highlight", FakeHighlight);
  vi.stubGlobal("CSS", { highlights: highlightRegistry });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  root = document.createElement("div");
  document.body.append(root);
  scrollToUnit = vi.fn();
  onLoadOlder = vi.fn();
  onSearchResultHighlightDone = vi.fn();
});

afterEach(() => {
  root.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flushFrames() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("useConversationTimelineFind searchResultHighlight (MS06)", () => {
  it("命中已加载行时直接定位滚动并注册高亮，3s 后清理并上报 done", async () => {
    vi.useFakeTimers();
    // vi.useFakeTimers 的默认 toFake 列表会连 requestAnimationFrame 一起替换成
    // clock 驱动的实现；这里重新 stub 回同步执行，保证帧回调在 effect 内即时生效。
    vi.stubGlobal("requestAnimationFrame", synchronousRequestAnimationFrame);
    ensureConversationFindHighlightStyle();
    mountTimelineRow(root, 2, "needle question about history");
    mountTimelineRow(root, 3, "needle answer in older turn");

    renderHook((props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props), {
      initialProps: hookProps([...olderRows, ...newerRows], {
        canLoadOlder: false,
        searchResultHighlightRequest: createSearchRequest(),
      }),
    });

    // snippet 命中 older turn（unit 0），直接滚动定位，不需要加载历史。
    expect(scrollToUnit).toHaveBeenCalledTimes(1);
    expect(scrollToUnit).toHaveBeenCalledWith(0);
    expect(onLoadOlder).not.toHaveBeenCalled();

    // 帧回调同步执行：高亮 range 已注册到 CSS Highlight registry 并滚动到可视区。
    const highlight = highlightRegistry.get(SEARCH_RESULT_HIGHLIGHT_NAME);
    expect(highlight).toBeDefined();
    expect(highlight?.ranges).toHaveLength(1);
    expect(highlight?.ranges[0]?.startContainer.textContent).toContain("needle");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(onSearchResultHighlightDone).not.toHaveBeenCalled();

    // 3s 高亮窗口结束后清理注册表并上报 done。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(highlightRegistry.has(SEARCH_RESULT_HIGHLIGHT_NAME)).toBe(false);
    expect(onSearchResultHighlightDone).toHaveBeenCalledTimes(1);
    expect(onSearchResultHighlightDone).toHaveBeenCalledWith(41);
  });

  it("snippet 在未加载的旧历史时自动 loadOlder 直到命中（attemptKey 防重入）", async () => {
    const request = createSearchRequest();
    const hook = renderHook(
      (props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props),
      {
        initialProps: hookProps(newerRows, {
          canLoadOlder: true,
          loadingOlder: false,
          searchResultHighlightRequest: request,
        }),
      },
    );

    // 已加载行不含 snippet：触发一次 loadOlder。
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    // loadingOlder=true 期间（rows 未变，attemptKey 相同）不能重复触发，也不能误报 done。
    hook.rerender(
      hookProps(newerRows, {
        canLoadOlder: true,
        loadingOlder: true,
        searchResultHighlightRequest: request,
      }),
    );
    await flushFrames();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onSearchResultHighlightDone).not.toHaveBeenCalled();
    expect(scrollToUnit).not.toHaveBeenCalled();

    // 旧历史加载完成（rows 前插、DOM 行挂载），snippet 命中：定位滚动并注册高亮。
    const rowsWithHistory = [...olderRows, ...newerRows];
    mountTimelineRow(root, 2, "needle question about history");
    mountTimelineRow(root, 3, "needle answer in older turn");
    hook.rerender(
      hookProps(rowsWithHistory, {
        mountedRowsKey: "mounted-2",
        canLoadOlder: false,
        searchResultHighlightRequest: request,
      }),
    );
    await flushFrames();

    expect(scrollToUnit).toHaveBeenCalledTimes(1);
    expect(scrollToUnit).toHaveBeenCalledWith(0);
    expect(highlightRegistry.get(SEARCH_RESULT_HIGHLIGHT_NAME)?.ranges).toHaveLength(1);
    expect(onSearchResultHighlightDone).not.toHaveBeenCalled();
  });

  it("无法定位且不能再加载时只上报 done，不滚动也不误触发 loadOlder", async () => {
    renderHook((props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props), {
      initialProps: hookProps(newerRows, {
        canLoadOlder: false,
        searchResultHighlightRequest: createSearchRequest(),
      }),
    });
    await flushFrames();

    expect(onSearchResultHighlightDone).toHaveBeenCalledTimes(1);
    expect(onSearchResultHighlightDone).toHaveBeenCalledWith(41);
    expect(scrollToUnit).not.toHaveBeenCalled();
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(highlightRegistry.has(SEARCH_RESULT_HIGHLIGHT_NAME)).toBe(false);
    // 重复 flush 帧不能把 done 上报两次。
    await flushFrames();
    expect(onSearchResultHighlightDone).toHaveBeenCalledTimes(1);
  });

  it("loadingOlder 期间不误报 done，加载结束恢复后才继续 loadOlder", async () => {
    const request = createSearchRequest();
    const hook = renderHook(
      (props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props),
      {
        initialProps: hookProps(newerRows, {
          canLoadOlder: true,
          loadingOlder: true,
          searchResultHighlightRequest: request,
        }),
      },
    );
    await flushFrames();

    // 正在加载更旧历史：不能提前宣告定位失败，也不能在 loading 期间触发加载。
    expect(onSearchResultHighlightDone).not.toHaveBeenCalled();
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(scrollToUnit).not.toHaveBeenCalled();

    hook.rerender(
      hookProps(newerRows, {
        canLoadOlder: true,
        loadingOlder: false,
        searchResultHighlightRequest: request,
      }),
    );
    await flushFrames();

    // loadingOlder 结束后恢复自动加载；done 仍不能上报。
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onSearchResultHighlightDone).not.toHaveBeenCalled();
    expect(scrollToUnit).not.toHaveBeenCalled();
  });
});

// F17 步骤⑤（上游 a60ba6a7 移植）：查找索引按「历史 + 尾轮」分区构建——历史段按
// renderUnits.history 引用缓存（段内按 unit 引用校验失效），流式帧只重建尾段；
// 扁平数组入参仍被接受（语义 = 全窗口当尾段），与分区入参产出一致命中集。
describe("useConversationTimelineFind 分区 renderUnits", () => {
  const historyRows: ConversationRow[] = [
    turnHeader(1, "turn-1"),
    userInput(2, "needle question about history", "turn-1"),
    assistantText(3, "needle answer in older turn", "turn-1"),
    turnHeader(10, "turn-2"),
    userInput(11, "latest message", "turn-2"),
    assistantText(12, "latest answer streaming", "turn-2"),
  ];

  function partitionUnits(rows: readonly ConversationRow[]) {
    const all = buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 });
    return { history: all.slice(0, -1), tail: all.slice(-1) };
  }

  it("分区入参与扁平入参产出一致命中集", async () => {
    const onMatchStateChange = vi.fn();
    renderHook((props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props), {
      initialProps: hookProps(historyRows, {
        conversationFindQuery: "needle",
        onConversationFindMatchStateChange: onMatchStateChange,
      }),
    });
    await flushFrames();
    const partitionReport = onMatchStateChange.mock.calls.at(-1)?.[0];

    const onFlatStateChange = vi.fn();
    renderHook(
      (props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props),
      {
        initialProps: {
          ...hookProps(historyRows, {
            conversationFindQuery: "needle",
            onConversationFindMatchStateChange: onFlatStateChange,
          }),
          renderUnits: partitionUnits(historyRows),
        },
      },
    );
    await flushFrames();
    const flatReport = onFlatStateChange.mock.calls.at(-1)?.[0];

    expect(flatReport.matchCount).toBe(partitionReport.matchCount);
    expect(flatReport.activeIndex).toBe(partitionReport.activeIndex);
    expect(flatReport.matchCount).toBe(2);
  });

  it("流式尾轮帧（history 引用不变）命中回报稳定；历史行 upsert 后命中数更新", async () => {
    const onMatchStateChange = vi.fn();
    const hook = renderHook(
      (props: UseConversationTimelineFindOptions) => useConversationTimelineFind(props),
      {
        initialProps: {
          ...hookProps(historyRows, {
            conversationFindQuery: "needle",
            onConversationFindMatchStateChange: onMatchStateChange,
          }),
          renderUnits: partitionUnits(historyRows),
        },
      },
    );
    await flushFrames();
    expect(onMatchStateChange.mock.calls.at(-1)?.[0].matchCount).toBe(2);

    // 尾轮流式：rows 新数组、history 行引用与分区 history 引用均不变（store advance 语义）。
    const streamedRows = historyRows.map((row) =>
      row.rowId === 12 && row.kind === "assistantText"
        ? { ...row, text: row.text + " more needle tokens" }
        : row,
    );
    hook.rerender({
      ...hookProps(streamedRows, {
        conversationFindQuery: "needle",
        onConversationFindMatchStateChange: onMatchStateChange,
      }),
      renderUnits: partitionUnits(streamedRows),
    });
    await flushFrames();
    // 尾轮新增一处命中，历史两处不受影响。
    expect(onMatchStateChange.mock.calls.at(-1)?.[0].matchCount).toBe(3);

    // 历史行 upsert（同 key 新 row 对象）：历史段缓存按 unit 引用失效，命中数更新。
    const upsertedRows = streamedRows.map((row) =>
      row.rowId === 3 && row.kind === "assistantText"
        ? { ...row, text: row.text + " another needle" }
        : row,
    );
    hook.rerender({
      ...hookProps(upsertedRows, {
        conversationFindQuery: "needle",
        onConversationFindMatchStateChange: onMatchStateChange,
      }),
      renderUnits: partitionUnits(upsertedRows),
    });
    await flushFrames();
    expect(onMatchStateChange.mock.calls.at(-1)?.[0].matchCount).toBe(4);
  });
});
