// F17 步骤②（冻结历史 + 尾轮分区，上游 a60ba6a7 移植）：插件 UI 逻辑实例推导的分区缓存测试。
// 覆盖 spec docs/ui/chat-virtual-scroll.md「步骤②契约」验收场景 2：
// 尾轮文本流式帧复用上一份推导；尾轮插件行变化或历史引用更换时整窗重算。
import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  UserInputRow,
} from "@zody/shared/zody-protocol-v4";
import {
  createLogicalUiInstancesSelector,
  deriveLogicalUiInstances,
} from "./pluginUiInstancePolicy.js";

function userInput(rowId: number, turnId: string): UserInputRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    origin: "realUser",
    text: `问题 ${rowId}`,
    attachments: [],
  };
}

function assistant(rowId: number, turnId: string, text: string): AssistantTextRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "streaming",
  };
}

function pluginToolCall(rowId: number, turnId: string, status: ToolCallRow["status"] = "success"): ToolCallRow {
  return {
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "mcp__fixture__edit",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: {
        pluginId: "fixture",
        resourceUri: "ui://fixture",
        surface: "panel",
        preferredDisplayMode: "fullscreen",
        showInline: true,
      },
    },
  };
}

function historyRows(): ConversationRow[] {
  return [
    userInput(1, "turn-1"),
    assistant(2, "turn-1", "回答 1"),
    pluginToolCall(3, "turn-1"),
    userInput(4, "turn-2"),
    assistant(5, "turn-2", "回答 2"),
  ];
}

describe("createLogicalUiInstancesSelector（分区缓存）", () => {
  it("尾轮文本流式帧（回合序列与插件行引用不变）复用上一份推导", () => {
    const select = createLogicalUiInstancesSelector();
    const rows = [...historyRows(), userInput(6, "turn-3"), assistant(7, "turn-3", "流式中")];
    const history = rows.slice(0, 5);
    const first = select(rows, { history, tail: rows.slice(5) });
    // 同一推导内容：与直接全量计算相等。
    expect(first).toEqual(deriveLogicalUiInstances(rows));

    // 尾轮 assistant 文本增长（行对象更换、回合与插件行不变）：复用引用。
    const streamed = [
      ...rows.slice(0, -1),
      { ...rows[6]!, text: "流式中 更长" } as AssistantTextRow,
    ];
    expect(select([...streamed], { history, tail: streamed.slice(5) })).toBe(first);
  });

  it("尾轮插件行引用变化（running 工具行追加）时整窗重算", () => {
    const select = createLogicalUiInstancesSelector();
    const rows = [...historyRows(), userInput(6, "turn-3"), assistant(7, "turn-3", "流式中")];
    const history = rows.slice(0, 5);
    const first = select(rows, { history, tail: rows.slice(5) });

    const updated = [...rows, pluginToolCall(8, "turn-3", "running")];
    const second = select(updated, { history, tail: updated.slice(5) });
    expect(second).not.toBe(first);
    expect(second).toEqual(deriveLogicalUiInstances(updated));
  });

  it("历史引用更换（前插历史）时整窗重算", () => {
    const select = createLogicalUiInstancesSelector();
    const rows = [...historyRows(), userInput(6, "turn-3"), assistant(7, "turn-3", "流式中")];
    const first = select(rows, { history: rows.slice(0, 5), tail: rows.slice(5) });
    // 前插一行历史：history 数组引用变化。
    const prepended: ConversationRow[] = [userInput(0, "turn-0"), ...rows];
    const second = select(prepended, {
      history: prepended.slice(0, 6),
      tail: prepended.slice(6),
    });
    expect(second).not.toBe(first);
    expect(second).toEqual(deriveLogicalUiInstances(prepended));
  });
});
