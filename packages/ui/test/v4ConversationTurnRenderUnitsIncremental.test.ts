import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  type BuilderOptions,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";

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

function turnHeader(
  rowId: number,
  turnId: string,
  overrides: Partial<TurnHeaderRow> = {},
): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    turnId,
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 11_000,
    ...overrides,
  });
}

function userInput(
  rowId: number,
  turnId: string,
  text = "hello",
): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    kind: "userInput",
    origin: "realUser",
    turnId,
    text,
  });
}

function toolCall(
  rowId: number,
  turnId: string,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return baseRow<ToolCallRow>({
    rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "Read",
    status: "success",
    inputText: "{}",
    turnId,
    ...overrides,
  });
}

function assistantText(
  rowId: number,
  turnId: string,
  text: string,
  overrides: Partial<AssistantTextRow> = {},
): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    kind: "assistantText",
    state: "complete",
    turnId,
    text,
    ...overrides,
  });
}

/** 静态基线：两个已完成 turn。 */
function baselineRows(): ConversationRow[] {
  return [
    turnHeader(1, "turn-1"),
    userInput(2, "turn-1"),
    assistantText(3, "turn-1", "first answer"),
    turnHeader(4, "turn-2"),
    userInput(5, "turn-2"),
    toolCall(6, "turn-2"),
    assistantText(7, "turn-2", "second answer"),
  ];
}

const BASE_OPTIONS = { nowMs: 1_700_000_100_000 };

function build(
  rows: readonly ConversationRow[],
  options?: BuilderOptions,
): ConversationTurnRenderUnit[] {
  return buildConversationTurnRenderUnits(rows, {
    ...BASE_OPTIONS,
    ...options,
  });
}

describe("buildConversationTurnRenderUnits incremental reuse (perf-1/perf-2)", () => {
  it("流式帧只改最后一轮：历史轮复用旧引用，最后一轮重建", () => {
    const rows = baselineRows();
    const previous = build(rows);
    // 模拟 row.appended：新行追加到尾部，旧行引用不变（applyConversationDelta 的结构共享语义）。
    const streamingRows = [
      ...rows,
      assistantText(8, "turn-2", " more", { state: "streaming" }),
    ];

    const next = build(streamingRows, { previousUnits: previous });

    expect(next).toHaveLength(2);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
  });

  it("行为等价：增量构建结果与全量重建 deep-equal", () => {
    const rows = baselineRows();
    const previous = build(rows);
    const streamingRows = [
      ...rows,
      assistantText(8, "turn-2", " more", { state: "streaming" }),
    ];

    const incremental = build(streamingRows, { previousUnits: previous });
    const full = build(streamingRows);

    expect(incremental).toEqual(full);
    // 深等之下引用来源不同：full 全新，incremental[0] 复用旧引用。
    expect(full[0]).not.toBe(previous[0]);
    expect(incremental[0]).toBe(previous[0]);
  });

  it("静默期 1s 时钟推进：非运行轮引用不变，运行轮重建且耗时文案更新（perf-2）", () => {
    const runningStartAt = 1_700_000_000_000;
    const rows = [
      turnHeader(1, "turn-1"),
      userInput(2, "turn-1"),
      assistantText(3, "turn-1", "first answer"),
      turnHeader(4, "turn-2", {
        state: "running",
        startedAt: runningStartAt,
        activeMs: undefined,
      }),
      userInput(5, "turn-2"),
      toolCall(6, "turn-2", { status: "inputStreaming" }),
    ];
    const previous = build(rows, { nowMs: runningStartAt + 1_000 });

    // 模型完全静默（无任何 delta），只有 liveNowMs 每秒推进。
    const ticked = build(rows, {
      previousUnits: previous,
      nowMs: runningStartAt + 2_000,
    });

    expect(ticked[0]).toBe(previous[0]);
    expect(ticked[1]).not.toBe(previous[1]);
    expect(ticked[1].workStatus?.state).toBe("running");
    expect(ticked[1].workStatus?.durationMs).toBe(2_000);
    expect(previous[1].workStatus?.durationMs).toBe(1_000);
  });

  it("row.upserted 替换尾行：仅该轮重建，其余轮复用", () => {
    const rows = baselineRows();
    const previous = build(rows);
    rows[6] = assistantText(7, "turn-2", "second answer (edited)");

    const next = build(rows, { previousUnits: previous });

    expect(next[0]).toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
    expect(next[1]).toEqual(build(rows)[1]);
  });

  it("sessionPhase 变化使所有轮重建（含复用候选）", () => {
    const rows = baselineRows();
    const previous = build(rows);

    const next = build(rows, {
      previousUnits: previous,
      sessionPhase: "completedInterrupted",
    });

    expect(next[0]).not.toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
  });

  it("turn 顺序位置变化（新 turn 插入）时旧轮不盲目复用 isLastTurn 语义", () => {
    const rows = baselineRows();
    const previous = build(rows);
    // 在尾部新增第三轮：turn-2 从 isLastTurn=true 变为 false。
    const nextRows = [
      ...rows,
      turnHeader(8, "turn-3"),
      userInput(9, "turn-3"),
      assistantText(10, "turn-3", "third answer"),
    ];

    const next = build(nextRows, { previousUnits: previous });

    // turn-2 的 total/index 变化 → 全量重建，isLastTurn 正确回落。
    expect(next[1]).not.toBe(previous[1]);
    expect(next[1].isLastTurn).toBe(false);
    expect(next[2].isLastTurn).toBe(true);
    expect(next).toEqual(build(nextRows));
  });

  it("未提供 previousUnits 时退化为全量构建，结果与旧行为一致", () => {
    const rows = baselineRows();
    expect(build(rows)).toEqual(build(rows, { previousUnits: [] }));
  });

  it("跨会话行引用全变（如切换会话）时不复用任何旧 unit", () => {
    const previous = build(baselineRows());
    // 行内容相同但全部是新对象引用（JSON 反序列化语义）。
    const freshRows: ConversationRow[] = baselineRows().map((row) => ({
      ...row,
    }));

    const next = build(freshRows, { previousUnits: previous });

    expect(next[0]).not.toBe(previous[0]);
    expect(next[1]).not.toBe(previous[1]);
    expect(next).toEqual(previous);
  });
});
