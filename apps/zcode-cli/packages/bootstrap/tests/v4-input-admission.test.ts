import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  isConversationInputAdmissionCommand,
  resolveInputCommandForAdmission,
} from "../src/zcode-protocol/v4-bridge.js";
import { resolveSubmittedExecutionState } from "../src/zcode-protocol-v4/commands/input-admission.js";
import { inputIntentMetadata } from "../src/zcode-protocol-v4/commands/input-intent.js";

function envelope(type: CommandEnvelope["type"], payload: unknown): CommandEnvelope {
  return {
    commandId: "cmd-new",
    clientId: "client-new",
    sessionId: "s-parent",
    type,
    payload,
    issuedAt: 1,
  };
}

describe("v4 input admission canonical intent", () => {
  it("gateway admission 接线包含 compact/edit/retry，排除非输入命令", () => {
    expect(isConversationInputAdmissionCommand("compact")).toBe(true);
    expect(isConversationInputAdmissionCommand("editUserQuery")).toBe(true);
    expect(isConversationInputAdmissionCommand("retryTurn")).toBe(true);
    expect(isConversationInputAdmissionCommand("applyFileRewind")).toBe(false);
  });

  it("非输入命令不创建 session_input", () => {
    expect(resolveInputCommandForAdmission(envelope("stop", {}), "s-parent", vi.fn())).toBeNull();
  });

  it("compact admission 保留 typed maintenance intent，不伪装成 sendText", () => {
    expect(resolveInputCommandForAdmission(envelope("compact", {}), "s-parent", vi.fn())).toEqual({
      kind: "compact",
      text: "/compact",
      attachments: [],
    });
  });

  // fork（F4.2）：原「sendText admission 保留 Highspeed message metadata」测试随
  // sendText.highspeedMeta 字段删除；存量数据由 zod strip 宽容解析。

  it("retry 以新 commandId admission，但保留 canonical kind/delivery/attachments/provenance", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "retryTurn",
      row: {},
      messageId: "msg-assistant",
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: false,
        intent: {
          kind: "sendGoalCommand",
          text: "original objective",
          inputOrigin: "mobile",
          // fork（bots 移除）：原 fixture botGroupSource 随 bot channels 全量删除。
          sourceCommandId: "cmd-original",
          clientId: "client-original",
          queueItemId: "queue-original",
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.goalUnsupported",
          attachments: [
            {
              ref: "attachment://a",
              fileName: "a.txt",
              mime: "text/plain",
              bytes: 1,
              // fork（bots 移除）：sourceKind "topic-history" 随 bot channels 全量删除，
              // 附件来源枚举收窄为 "clipboard-text"。
              sourceKind: "clipboard-text",
              messageCount: 1,
            },
          ],
          provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
        },
      },
    });

    expect(
      resolveInputCommandForAdmission(
        envelope("retryTurn", {
          target: { rowId: 7, entityId: "msg-assistant" },
        }),
        "s-parent",
        resolve,
      ),
    ).toEqual({
      kind: "sendGoalCommand",
      text: "original objective",
      inputOrigin: "mobile",
      // fork（bots 移除）：原 botGroupSource 断言随 bot channels 全量删除。
      attachments: [
        {
          ref: "attachment://a",
          fileName: "a.txt",
          mime: "text/plain",
          bytes: 1,
          // fork（bots 移除）：sourceKind "topic-history" 随 bot channels 全量删除，
          // 附件来源枚举收窄为 "clipboard-text"。
          sourceKind: "clipboard-text",
          messageCount: 1,
        },
      ],
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      fallbackReasonCode: "guide.goalUnsupported",
      provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
    });
  });

  it("compact-covered edit 只在原 session admission", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "editUserQuery",
      row: {},
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: true,
        intent: {
          kind: "sendText",
          text: "old",
          sourceCommandId: "cmd-original",
        },
      },
    });
    const command = envelope("editUserQuery", {
      target: { rowId: 7, entityId: "msg-user" },
      newText: "edited",
    });

    expect(resolveInputCommandForAdmission(command, "s-parent", resolve)).toMatchObject({
      kind: "sendText",
      text: "edited",
      provenance: { sourceCommandId: "cmd-original" },
    });
  });

  // I03 语义反转（2026-10-24 获批）的先例守护：V4 接收边界本来就把选择固定进 canonical
  // intent，普通 CLI 现在复用同一语义。显式 payload 选择优先且不回读 Session；缺省时才在当前
  // 接收边界固定 Session 值。显式执行选择入口不属于普通 CLI 冻结的覆盖范围。
  describe("submitted execution selection freeze", () => {
    const SELECTION_A: ModelSelection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    };
    const SELECTION_B: ModelSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    };

    function recordWithSessionSelection(selection: ModelSelection) {
      const getSessionModelSelection = vi.fn(() => selection);
      return {
        record: {
          app: {
            getModel: () => `${selection.providerId}/${selection.modelId}`,
            getMode: () => "build",
            runtime: {
              getPlanEnabled: () => false,
              getSessionModelSelection,
            },
          },
        } as never,
        getSessionModelSelection,
      };
    }

    it("显式 payload.modelSelection 优先，不回读也不改写 Session", () => {
      const { record, getSessionModelSelection } = recordWithSessionSelection(SELECTION_A);

      expect(
        resolveSubmittedExecutionState(record, {
          modelSelection: SELECTION_B,
          mode: "build",
          planEnabled: false,
        }),
      ).toEqual({
        modelSelection: SELECTION_B,
        mode: "build",
        planEnabled: false,
      });
      expect(getSessionModelSelection).not.toHaveBeenCalled();
    });

    it("无显式选择时在接收边界固定 Session 当前值", () => {
      const { record } = recordWithSessionSelection(SELECTION_A);

      expect(resolveSubmittedExecutionState(record, {})).toEqual({
        modelSelection: SELECTION_A,
        mode: "build",
        planEnabled: false,
      });
    });
  });
});
