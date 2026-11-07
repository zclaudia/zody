// F17 步骤②（冻结历史 + 尾轮分区，上游 a60ba6a7 移植）：render units 分区选择器测试。
// 覆盖 spec docs/ui/chat-virtual-scroll.md「步骤②契约」验收场景 1/2：
// 与全量构建逐项相等的等价性 + 尾轮流式帧的引用稳定性。
import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import {
  advanceConversationRowsPartition,
  getConversationRowsPartition,
} from "@/v4/conversationProjectionStore.js";
import {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsSelector,
} from "@/v4/conversationTurnRenderUnits.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
import { createConversationTurnNavigatorQueryRowIdsSelector } from "@/v4/conversationTurnNavigatorHelpers.js";

function baseRow<T extends ConversationRow>(
  row: Omit<T, "createdAt" | "createdAtSeq" | "rowId" | "turnId"> & {
    rowId: number;
    turnId: string;
  },
): T {
  return {
    createdAt: 1_700_000_000_000 + row.rowId,
    createdAtSeq: row.rowId,
    ...row,
  } as T;
}

function turnHeader(
  rowId: number,
  turnId: string,
  state: TurnHeaderRow["state"] = "completedSuccess",
): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state,
    startedAt: 1_700_000_000_000 + rowId,
  });
}

function userInput(rowId: number, turnId: string, text = "问题"): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    origin: "realUser",
    text,
    attachments: [],
  });
}

function assistant(
  rowId: number,
  turnId: string,
  text: string,
  state: AssistantTextRow["state"] = "streaming",
): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state,
  });
}

/** 轮顶轻边界（modelChange）行：进 leadingBoundaryRows，参与等价性覆盖。 */
function lightBoundary(rowId: number, turnId: string): TimelineMarkerRow {
  return baseRow<TimelineMarkerRow>({
    rowId,
    turnId,
    kind: "timelineMarker",
    marker: {
      type: "modelChange",
      toProvider: "p",
      toModel: "m",
      toThought: "t",
    },
    lane: "lightBoundary",
  });
}

function buildHistoryTurns(count: number): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const turnId = `turn-${index + 1}`;
    const base = index * 3;
    rows.push(
      turnHeader(base + 1, turnId),
      userInput(base + 2, turnId, `问题 ${index + 1}`),
      assistant(base + 3, turnId, `回答 ${index + 1}`, "complete"),
    );
    // 每两轮插入一条轻边界，覆盖 leadingBoundaryRows 的分段构建。
    if (index % 2 === 1) rows.push(lightBoundary(base + 4, turnId));
  }
  return rows;
}

function withRunningTail(historyTurns: number): ConversationRow[] {
  const history = buildHistoryTurns(historyTurns);
  const turnId = `turn-${historyTurns + 1}`;
  const base = history[history.length - 1]!.rowId;
  return [
    ...history,
    turnHeader(base + 1, turnId, "running"),
    userInput(base + 2, turnId, "最新问题"),
    assistant(base + 3, turnId, "正在流式的回答"),
  ];
}

/** 把指定 turn 的 header 置为终态（新轮开始前收口尾轮）。 */
function completeTurnHeader(rows: ConversationRow[], turnId: string): ConversationRow[] {
  return rows.map((row) =>
    row.turnId === turnId && row.kind === "turnHeader"
      ? { ...row, state: "completedSuccess" as const }
      : row,
  );
}

const NOW = 1_700_000_060_000;

describe("F17 render units 分区选择器：等价性", () => {
  it("历史 + running 尾轮：history ++ tail 与全量构建逐项相等", () => {
    const rows = withRunningTail(5);
    const selector = createConversationTurnRenderUnitsSelector();
    const partition = selector(getConversationRowsPartition(rows), { nowMs: NOW });
    expect([...partition.history, ...partition.tail]).toEqual(
      buildConversationTurnRenderUnits(rows, { nowMs: NOW }),
    );
  });

  it("尾轮 unit 全被过滤（仅剩 turnHeader 的空轮）：tailDropped 后仍与全量构建逐项相等", () => {
    const history = buildHistoryTurns(4);
    const rows = [...history, turnHeader(13, "turn-5")];
    const selector = createConversationTurnRenderUnitsSelector();
    const partition = selector(getConversationRowsPartition(rows), { nowMs: NOW });
    expect(partition.tail).toEqual([]);
    expect([...partition.history, ...partition.tail]).toEqual(
      buildConversationTurnRenderUnits(rows, { nowMs: NOW }),
    );
    // 过滤尾轮后历史末项是最后一轮：isLastTurn 必须为 true（与全量构建一致）。
    expect(partition.history.at(-1)?.isLastTurn).toBe(true);
  });

  it("无 header 轮（冷窗口截断）：逐项相等且 phase 变化时历史段重建", () => {
    const history = buildHistoryTurns(3);
    // 尾轮缺 header：materialize 读 sessionPhase（phaseDependent）。
    const turnId = "turn-4";
    const base = 3 * 3;
    const rows = [
      ...history,
      userInput(base + 1, turnId, "无 header 的问题"),
      assistant(base + 2, turnId, "无 header 的回答", "streaming"),
    ];
    const selector = createConversationTurnRenderUnitsSelector();
    const runningPartition = selector(getConversationRowsPartition(rows), {
      nowMs: NOW,
      sessionPhase: "running",
    });
    expect([...runningPartition.history, ...runningPartition.tail]).toEqual(
      buildConversationTurnRenderUnits(rows, { nowMs: NOW, sessionPhase: "running" }),
    );
    const completedPartition = selector(getConversationRowsPartition(rows), {
      nowMs: NOW,
      sessionPhase: "completedInterrupted",
    });
    expect([...completedPartition.history, ...completedPartition.tail]).toEqual(
      buildConversationTurnRenderUnits(rows, {
        nowMs: NOW,
        sessionPhase: "completedInterrupted",
      }),
    );
  });

  it("运行中历史轮（时钟推进）与插件固定 resolver 变化：结果仍逐项相等", () => {
    const history = buildHistoryTurns(2);
    const staleRunningTurnId = "turn-3";
    const base = 2 * 3;
    // 历史中的陈旧 running 轮 + 终态尾轮：时钟影响历史段（clockDependent）。
    const rows = [
      ...history,
      turnHeader(base + 1, staleRunningTurnId, "running"),
      userInput(base + 2, staleRunningTurnId),
      assistant(base + 3, staleRunningTurnId, "历史 running 输出", "streaming"),
      userInput(base + 4, "turn-4", "终态问题"),
      assistant(base + 5, "turn-4", "终态回答", "complete"),
    ];
    const selector = createConversationTurnRenderUnitsSelector();
    const resolverA = () => ({ disposition: undefined, manualPinned: false });
    const resolverB = () => ({ disposition: undefined, manualPinned: true });
    for (const options of [
      { nowMs: NOW, pluginUiPinResolver: resolverA },
      { nowMs: NOW + 1_000, pluginUiPinResolver: resolverA },
      { nowMs: NOW + 1_000, pluginUiPinResolver: resolverB },
    ]) {
      const partition = selector(getConversationRowsPartition(rows), options);
      expect([...partition.history, ...partition.tail]).toEqual(
        buildConversationTurnRenderUnits(rows, options),
      );
    }
  });

  it("新轮开始（turn 从尾段迁入历史段）：逐项相等且两段引用正确更换", () => {
    const selector = createConversationTurnRenderUnitsSelector();
    const rowsBefore = withRunningTail(5);
    const before = selector(getConversationRowsPartition(rowsBefore), { nowMs: NOW });
    // 尾轮终态化并开启新轮：原尾轮迁入历史段。
    const nextBase = rowsBefore[rowsBefore.length - 1]!.rowId;
    const rowsAfter = [
      ...completeTurnHeader(rowsBefore, "turn-6"),
      turnHeader(nextBase + 1, "turn-7", "running"),
      userInput(nextBase + 2, "turn-7"),
      assistant(nextBase + 3, "turn-7", "新尾轮流式"),
    ];
    const after = selector(getConversationRowsPartition(rowsAfter), { nowMs: NOW });
    expect([...after.history, ...after.tail]).toEqual(
      buildConversationTurnRenderUnits(rowsAfter, { nowMs: NOW }),
    );
    // 原 running 尾轮迁入历史段后引用更换（isLastTurn 等位置语义变化）。
    expect(after.history.length).toBe(before.history.length + 1);
    expect(after.history.at(-1)?.key).toBe("turn-6");
    expect(after.tail.map((unit) => unit.key)).toEqual(["turn-7"]);
  });
});

describe("F17 render units 分区选择器：引用稳定性（流式帧只算尾轮）", () => {
  function streamTailFrame(rows: ConversationRow[], append: string): ConversationRow[] {
    const last = rows[rows.length - 1]!;
    const next = rows.map((row) =>
      row.rowId === last.rowId && row.kind === "assistantText"
        ? { ...row, text: row.text + append }
        : row,
    );
    advanceConversationRowsPartition(rows, next, [
      { op: "row.delta", rowId: last.rowId, path: "text", append },
    ]);
    return next;
  }

  it("尾轮流式帧：history 引用、历史 unit 引用、virtualizedUnits 引用不变", () => {
    const selector = createConversationTurnRenderUnitsSelector();
    const rows = withRunningTail(6);
    const first = selector(getConversationRowsPartition(rows), { nowMs: NOW });
    const firstSplit = splitConversationTimelineLiveTail(first);
    const firstUnits = firstSplit.virtualizedUnits;

    const nextRows = streamTailFrame(rows, " 更多流式内容");
    const second = selector(getConversationRowsPartition(nextRows), { nowMs: NOW });
    const secondSplit = splitConversationTimelineLiveTail(second);

    expect(getConversationRowsPartition(nextRows).history).toBe(
      getConversationRowsPartition(rows).history,
    );
    expect(second.history).toBe(first.history);
    expect(second.history.every((unit, index) => unit === first.history[index])).toBe(true);
    // running 尾轮：虚拟列表直接复用 history 引用。
    expect(secondSplit.virtualizedUnits).toBe(firstUnits);
    // 尾轮 unit 因内容变化重建，key 不变。
    expect(second.tail.map((unit) => unit.key)).toEqual(first.tail.map((unit) => unit.key));
    expect(second.tail[0]).not.toBe(first.tail[0]);

    // 对照：旧扁平 API 每帧产出全新数组（修改前行为），分区选择器保持历史引用。
    const flatBefore = buildConversationTurnRenderUnits(rows, { nowMs: NOW });
    const flatAfter = buildConversationTurnRenderUnits(nextRows, { nowMs: NOW });
    expect(flatAfter).not.toBe(flatBefore);
  });

  it("历史行 upsert 后 history 引用更换（缓存不放行陈旧历史）", () => {
    const selector = createConversationTurnRenderUnitsSelector();
    const rows = withRunningTail(5);
    const first = selector(getConversationRowsPartition(rows), { nowMs: NOW });
    const firstTurnAnswerRowId = rows.find(
      (row) => row.turnId === "turn-1" && row.kind === "assistantText",
    )!.rowId;
    const upserted = rows.map((row) =>
      row.rowId === firstTurnAnswerRowId && row.kind === "assistantText"
        ? { ...row, feedback: "like" as const }
        : row,
    );
    const second = selector(getConversationRowsPartition(upserted), { nowMs: NOW });
    expect(second.history).not.toBe(first.history);
    expect([...second.history, ...second.tail]).toEqual(
      buildConversationTurnRenderUnits(upserted, { nowMs: NOW }),
    );
  });

  it("目录 Set 身份在尾轮流式帧保持稳定，成员变化时更换", () => {
    const selectRowIds = createConversationTurnNavigatorQueryRowIdsSelector();
    const selector = createConversationTurnRenderUnitsSelector();
    const rows = withRunningTail(5);
    const first = selectRowIds(selector(getConversationRowsPartition(rows), { nowMs: NOW }));
    const nextRows = streamTailFrame(rows, " 继续流式");
    const second = selectRowIds(selector(getConversationRowsPartition(nextRows), { nowMs: NOW }));
    expect(second).toBe(first);

    // 新 real-user query 进入尾轮：成员变化，Set 更换且包含新 rowId。
    const newTurnBase = nextRows[nextRows.length - 1]!.rowId;
    const newTurnHeader = turnHeader(newTurnBase + 1, "turn-7", "running");
    const newTurnInput = userInput(newTurnBase + 2, "turn-7", "新问题");
    const newTurnRows = [...completeTurnHeader(nextRows, "turn-6"), newTurnHeader, newTurnInput];
    advanceConversationRowsPartition(nextRows, newTurnRows, [
      { op: "row.appended", row: newTurnHeader },
      { op: "row.appended", row: newTurnInput },
    ]);
    const third = selectRowIds(selector(getConversationRowsPartition(newTurnRows), { nowMs: NOW }));
    expect(third).not.toBe(second);
    expect(third.has(newTurnInput.rowId)).toBe(true);
    expect([...third].sort((a, b) => a - b)).toEqual(
      buildConversationTurnRenderUnits(newTurnRows, { nowMs: NOW })
        .flatMap((unit) => unit.visibleUserInputs.filter((row) => row.origin === "realUser"))
        .map((row) => row.rowId)
        .sort((a, b) => a - b),
    );
  });

  it("splitConversationTimelineLiveTail 扁平入参行为保持不变（既有契约）", () => {
    const units = buildConversationTurnRenderUnits(withRunningTail(3), { nowMs: NOW });
    const flat = splitConversationTimelineLiveTail(units);
    expect(flat.virtualizedUnits).toEqual(units.slice(0, -1));
    expect(flat.liveUnit).toBe(units.at(-1));
    expect(flat.liveUnitIndex).toBe(units.length - 1);
    const terminal = buildConversationTurnRenderUnits(buildHistoryTurns(3), { nowMs: NOW });
    const terminalSplit = splitConversationTimelineLiveTail(terminal);
    expect(terminalSplit).toEqual({
      virtualizedUnits: terminal,
      liveUnit: null,
      liveUnitIndex: null,
    });
  });
});
