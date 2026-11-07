// F17 步骤②（冻结历史 + 尾轮分区，上游 a60ba6a7 移植）：分区核心契约测试。
// 覆盖 spec docs/ui/chat-virtual-scroll.md「步骤②契约」验收场景 2/3：
// 引用稳定性与 advance 沿用判定。等价性场景见 v4ConversationTurnRenderUnitsPartition.test.ts。
import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import {
  advanceConversationRowsPartition,
  getConversationRowsPartition,
  memoizeByRows,
} from "@/v4/conversationProjectionStore.js";

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
  state: "running" | "completedSuccess" = "completedSuccess",
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

/** 三轮会话：两轮终态 + 一轮 running 尾轮；行号即全局顺序。 */
function buildRows(): ConversationRow[] {
  return [
    turnHeader(1, "turn-1"),
    userInput(2, "turn-1"),
    assistant(3, "turn-1", "第一轮回答", "complete"),
    turnHeader(4, "turn-2"),
    userInput(5, "turn-2"),
    assistant(6, "turn-2", "第二轮回答", "complete"),
    turnHeader(7, "turn-3", "running"),
    userInput(8, "turn-3"),
    assistant(9, "turn-3", "尾轮流式中"),
  ];
}

describe("F17 冻结历史 + 尾轮分区", () => {
  it("tail 覆盖最后一行所在轮的全部行，history ++ tail 逐项等于 rows", () => {
    const rows = buildRows();
    const partition = getConversationRowsPartition(rows);
    expect(partition.tail.map((row) => row.rowId)).toEqual([7, 8, 9]);
    expect(partition.history.map((row) => row.rowId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...partition.history, ...partition.tail]).toEqual(rows);
  });

  it("同一轮在更早位置出现时（交错轮）tail 起点前移到两段轮次不相交", () => {
    // turn-2 的行出现在 turn-3 之后（fork/交错场景）：尾轮必须完整吞并 turn-2 与 turn-3。
    const rows: ConversationRow[] = [
      turnHeader(1, "turn-1"),
      userInput(2, "turn-1"),
      turnHeader(3, "turn-2"),
      userInput(4, "turn-2"),
      turnHeader(5, "turn-3"),
      userInput(6, "turn-3"),
      assistant(7, "turn-2", "迟到的 turn-2 输出", "complete"),
      assistant(8, "turn-3", "尾轮流式", "streaming"),
    ];
    const partition = getConversationRowsPartition(rows);
    expect(partition.tail.map((row) => row.rowId)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(partition.history.map((row) => row.rowId)).toEqual([1, 2]);
  });

  it("空窗口的分区两段均为空数组", () => {
    const partition = getConversationRowsPartition([]);
    expect(partition.history).toEqual([]);
    expect(partition.tail).toEqual([]);
  });

  it("同一 rows 引用返回同一分区对象（WeakMap 缓存），不同引用各自缓存", () => {
    const rows = buildRows();
    const again = [...rows];
    expect(getConversationRowsPartition(rows)).toBe(getConversationRowsPartition(rows));
    const other = getConversationRowsPartition(again);
    expect(other).not.toBe(getConversationRowsPartition(rows));
    // 内容等价但引用不同的窗口，分区内容仍逐项相等。
    expect(other.tail).toEqual(getConversationRowsPartition(rows).tail);
  });

  it("advance：流式 row.delta 只触尾轮时沿用上一份 history 引用", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);
    const nextRows = rows.map((row) =>
      row.rowId === 9 && row.kind === "assistantText" ? { ...row, text: row.text + " 新增" } : row,
    );
    const deltas: ConversationDelta[] = [
      { op: "row.delta", rowId: 9, path: "text", append: " 新增" },
    ];
    advanceConversationRowsPartition(rows, nextRows, deltas);
    const after = getConversationRowsPartition(nextRows);
    expect(after.history).toBe(before.history);
    expect(after.tail.map((row) => row.rowId)).toEqual([7, 8, 9]);
    expect(after.tail[2]?.text).toContain("新增");
  });

  it("advance：row.appended 到尾轮沿用 history，开启新轮则不登记（整窗重建）", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);

    // 尾轮内追加工具/正文行：沿用。
    const appendedTailRows = [...rows, assistant(10, "turn-3", "尾轮再追加一段", "streaming")];
    advanceConversationRowsPartition(rows, appendedTailRows, [
      { op: "row.appended", row: appendedTailRows.at(-1)! },
    ]);
    expect(getConversationRowsPartition(appendedTailRows).history).toBe(before.history);

    // 新轮开始（新 turnId）：不登记，分区由首次读取整窗重建，history 引用更换。
    const newTurnRows = [
      ...rows.map((row) =>
        row.rowId === 7 && row.kind === "turnHeader"
          ? { ...row, state: "completedSuccess" as const }
          : row,
      ),
      turnHeader(10, "turn-4", "running"),
      userInput(11, "turn-4"),
      assistant(12, "turn-4", "新一轮流式", "streaming"),
    ];
    advanceConversationRowsPartition(rows, newTurnRows, [
      { op: "row.appended", row: newTurnRows[9]! },
    ]);
    const rebuilt = getConversationRowsPartition(newTurnRows);
    expect(rebuilt.history).not.toBe(before.history);
    expect(rebuilt.tail.map((row) => row.rowId)).toEqual([10, 11, 12]);
  });

  it("advance：row.upserted 命中历史行时不沿用；命中尾轮行时沿用", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);

    // 历史行 upsert（旧行反馈/结构变化）：history 引用必须更换。
    const historyUpserted = rows.map((row) =>
      row.rowId === 6 && row.kind === "assistantText" ? { ...row, feedback: "like" as const } : row,
    );
    advanceConversationRowsPartition(rows, historyUpserted, [
      { op: "row.upserted", row: historyUpserted[5]! },
    ]);
    expect(getConversationRowsPartition(historyUpserted).history).not.toBe(before.history);

    // 尾轮行 upsert（running 轮工具行刷新）：沿用 history。
    const tailUpserted = rows.map((row) =>
      row.rowId === 9 && row.kind === "assistantText"
        ? { ...row, state: "complete" as const }
        : row,
    );
    advanceConversationRowsPartition(rows, tailUpserted, [
      { op: "row.upserted", row: tailUpserted[8]! },
    ]);
    expect(getConversationRowsPartition(tailUpserted).history).toBe(before.history);
  });

  it("advance：row.removed 裁剪到尾轮起点及更早时不沿用；只裁尾轮内部时沿用", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);
    // rewind：从尾轮首行（rowId 7 = tailStartRowId）开始裁剪，历史前缀即将变化，不沿用。
    const removedRows = rows.filter((row) => row.rowId < 7);
    advanceConversationRowsPartition(rows, removedRows, [{ op: "row.removed", fromRowId: 7 }]);
    const after = getConversationRowsPartition(removedRows);
    expect(after.history).not.toBe(before.history);

    // 只裁尾轮内部（fromRowId 8 > tailStartRowId 7）：历史不受影响，沿用。
    const tailTrimmedRows = rows.filter((row) => row.rowId < 8);
    advanceConversationRowsPartition(rows, tailTrimmedRows, [{ op: "row.removed", fromRowId: 8 }]);
    expect(getConversationRowsPartition(tailTrimmedRows).history).toBe(before.history);
  });

  it("advance：state/pluginUi 等 rows 之外的 delta 不改分区，沿用 history", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);
    const nextRows = [...rows];
    advanceConversationRowsPartition(rows, nextRows, [{ op: "state.updated", patch: {} }]);
    expect(getConversationRowsPartition(nextRows).history).toBe(before.history);
  });

  it("advance：同一数组引用（无变化）是幂等 no-op", () => {
    const rows = buildRows();
    const before = getConversationRowsPartition(rows);
    advanceConversationRowsPartition(rows, rows, []);
    expect(getConversationRowsPartition(rows)).toBe(before);
  });

  it("memoizeByRows 按数组引用缓存，历史引用不变时流式帧只重算尾段", () => {
    const rows = buildRows();
    const compute = memoizeByRows((input: readonly ConversationRow[]) => input.length);
    expect(compute(rows)).toBe(9);
    // 同引用命中缓存：fn 不再执行（以WeakMap 命中为证——同引用返回同值且 fn 仅执行一次）。
    let calls = 0;
    const counting = memoizeByRows((input: readonly ConversationRow[]) => {
      calls += 1;
      return input[0]?.rowId ?? 0;
    });
    counting(rows);
    counting(rows);
    expect(calls).toBe(1);
    // 新数组引用（流式帧）：重算。
    const nextRows = [...rows];
    counting(nextRows);
    expect(calls).toBe(2);
  });
});
