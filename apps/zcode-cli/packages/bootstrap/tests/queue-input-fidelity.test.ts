import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type ModelSelection,
  type SessionEvent,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { queueItemSchema } from "@zcode/shared/zcode-protocol-v4";
import { createInputFacade } from "../src/app/input-facade.js";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";
import { inputIntentMetadataFromQueueItem } from "../src/zcode-protocol-v4/commands/input-intent.js";

const intent: TurnInputIntentMetadata = {
  sourceCommandId: "source-command",
  queueItemId: "queued-input",
  clientId: "desktop-client",
  kind: "sendText",
  text: "继续执行",
  modelSelection: { providerId: "provider", modelId: "model", options: { reasoningLevel: "high" } },
  mode: "yolo",
  planEnabled: false,
  admissionSeq: 1,
  admittedAt: 1234,
  requestedDelivery: "queue",
  admittedDelivery: "queue",
  queuePosition: 0,
  attachmentRefs: [{ ref: "artifact://note", fileName: "note.txt", mime: "text/plain", bytes: 3 }],
  sharedContextRefs: [{ kind: "shared_context_import", context_id: "shared-context" }],
  provenance: {
    sourceCommandId: "original-command",
    queueItemId: "original-queue",
    clientId: "mobile-client",
  },
};

function queuedEvent(sequence: number, metadata?: TurnInputIntentMetadata): SessionEvent {
  return {
    id: `event-${sequence}`,
    sessionId: "session",
    turnId: "turn",
    type: SessionEventType.TurnSteerQueued,
    timestamp: new Date(1234 + sequence),
    traceId: "trace",
    sequenceNumber: sequence,
    payload: {
      pendingInputId: "queued-input",
      input: sequence === 1 ? intent.text : "修改正文",
      queueLength: 1,
      delivery: "queue",
      ...(metadata ? { intent: metadata } : {}),
    },
  } as SessionEvent;
}

describe("Todo151 Queue 提交事实往返", () => {
  it.each(["queue", "guide"] as const)(
    "%s 投递经真实事件投影再提升不丢字段",
    (requestedDelivery) => {
      const projection = new ProductProjection("session", "epoch");
      const submitted = {
        ...intent,
        requestedDelivery,
        ...(requestedDelivery === "guide"
          ? { fallbackReasonCode: "guide.attachmentsUnsupported" }
          : {}),
      };
      projection.applyEvent(queuedEvent(1, submitted));
      const item = queueItemSchema.parse(projection.getSnapshot().queue.items[0]);
      expect(inputIntentMetadataFromQueueItem(item, item.text)).toEqual(submitted);
    },
  );

  it("只带正文的旧编辑事件保留同项原选择、上下文和来源", () => {
    const projection = new ProductProjection("session", "epoch");
    projection.applyEvent(queuedEvent(1, intent));
    projection.applyEvent(queuedEvent(2));
    const item = projection.getSnapshot().queue.items[0]!;
    expect(inputIntentMetadataFromQueueItem(item, item.text)).toEqual({
      ...intent,
      text: "修改正文",
    });
  });
});

// I03（2026-10-24 语义反转获批）：普通 CLI 在提交边界冻结完整 ModelSelection，执行只读冻结值。
// 反例锚点：A 运行时入队两条 → 切 B → 旧输入用 A、新输入用 B；显式选择入口不被覆盖。
describe("普通 CLI 提交边界冻结 ModelSelection", () => {
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

  function cloneSelection(selection: ModelSelection): ModelSelection {
    return {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.options ? { options: { ...selection.options } } : {}),
    };
  }

  function createRecordingRuntime(initialSelection: ModelSelection | undefined) {
    let current = initialSelection ? cloneSelection(initialSelection) : undefined;
    const admissions: Array<{ input: string; intent?: TurnInputIntentMetadata }> = [];
    const admitPrompt = vi.fn(
      async (
        input: string,
        _attachments: unknown,
        options?: { intent?: TurnInputIntentMetadata },
      ) => {
        admissions.push({ input, intent: options?.intent });
        return {
          kind: "queued" as const,
          pendingInputId: `pending-${admissions.length}`,
          queueLength: admissions.length,
          turnId: "turn-1",
        };
      },
    );
    return {
      admissions,
      runtime: {
        admitPrompt,
        // 每次返回副本：提交后修改 Session 不得影响已接纳 intent。
        getSessionModelSelection: vi.fn(() => (current ? cloneSelection(current) : undefined)),
      },
      setSelection(selection: ModelSelection | undefined) {
        current = selection ? cloneSelection(selection) : undefined;
      },
    };
  }

  function createFacade(runtime: unknown) {
    return createInputFacade({
      logger: { warn: vi.fn() } as never,
      prepareUserExecutionBoundary: async () => {},
      runtime: runtime as never,
      sessionId: "s1" as never,
      traceContext: { traceId: "trace-1" } as never,
    });
  }

  function frozenQueuedEvent(
    sequence: number,
    metadata: TurnInputIntentMetadata | undefined,
    text: string,
  ): SessionEvent {
    return {
      id: `frozen-event-${sequence}`,
      sessionId: "session",
      turnId: "turn",
      type: SessionEventType.TurnSteerQueued,
      timestamp: new Date(1234 + sequence),
      traceId: "trace",
      sequenceNumber: sequence,
      payload: {
        pendingInputId: `frozen-pending-${sequence}`,
        input: text,
        queueLength: sequence,
        delivery: "queue",
        ...(metadata ? { intent: metadata } : {}),
      },
    } as SessionEvent;
  }

  it("A 运行时入队两条后切 B：旧输入仍冻结 A，新输入冻结 B", async () => {
    const { admissions, runtime, setSelection } = createRecordingRuntime(SELECTION_A);
    const facade = createFacade(runtime);

    await facade.sendInput("first while A", { inputId: "cmd-1", delivery: "auto" });
    await facade.sendInput("second while A", { inputId: "cmd-2", delivery: "auto" });
    setSelection(SELECTION_B);
    await facade.sendInput("submitted after switching to B", {
      inputId: "cmd-3",
      delivery: "auto",
    });

    expect(admissions.map((entry) => entry.intent?.modelSelection)).toEqual([
      SELECTION_A,
      SELECTION_A,
      SELECTION_B,
    ]);
    // legacy 提交没有 CommandInbox 序号；合成的 admissionSeq 必须唯一，否则 UI pending
    // guide rowId（-(admissionSeq+1)）会重复。
    const admissionSeqs = admissions.map((entry) => entry.intent?.admissionSeq);
    expect(admissionSeqs.every((seq) => typeof seq === "number")).toBe(true);
    expect(new Set(admissionSeqs).size).toBe(admissionSeqs.length);
    expect(new Set(admissions.map((entry) => entry.intent?.queueItemId)).size).toBe(
      admissions.length,
    );

    // 冻结值必须经真实投影进入 QueueItem：提升执行读的是队列项自己的选择。
    const projection = new ProductProjection("session", "epoch");
    admissions.forEach((entry, index) => {
      projection.applyEvent(frozenQueuedEvent(index + 1, entry.intent, entry.input));
    });
    const items = projection.getSnapshot().queue.items.map((item) => queueItemSchema.parse(item));
    expect(items.map((item) => item.modelSelection)).toEqual([
      SELECTION_A,
      SELECTION_A,
      SELECTION_B,
    ]);
  });

  it("显式 intent 的模型选择不被会话当前值覆盖", async () => {
    const { admissions, runtime } = createRecordingRuntime(SELECTION_A);
    const facade = createFacade(runtime);

    await facade.sendInput("explicit selection", {
      inputId: "cmd-explicit",
      delivery: "auto",
      intent: {
        kind: "sendText",
        modelSelection: SELECTION_B,
        requestedDelivery: "startNow",
        admittedDelivery: "startNow",
        sourceCommandId: "cmd-explicit",
        queueItemId: "queue-explicit",
        clientId: "desktop",
        admissionSeq: 1,
        admittedAt: 1000,
      },
    });

    expect(admissions[0]?.intent?.modelSelection).toEqual(SELECTION_B);
  });

  it("读不到 Session Selection 时在 admission 前拒绝，不留下未冻结的队列项", async () => {
    const { admissions, runtime } = createRecordingRuntime(undefined);
    const facade = createFacade(runtime);

    await expect(facade.sendInput("no model", { inputId: "cmd-no-model" })).rejects.toThrow(
      /model/i,
    );
    expect(admissions).toHaveLength(0);
  });

  it("submitPrompt 入口同样在提交边界冻结 ModelSelection", async () => {
    const executions: Array<{ input: string; intent?: TurnInputIntentMetadata }> = [];
    const runtime = {
      getSessionModelSelection: vi.fn(() => cloneSelection(SELECTION_A)),
      executeTurn: vi.fn(
        async (
          input: string,
          _attachments: unknown,
          options?: { intent?: TurnInputIntentMetadata },
        ) => {
          executions.push({ input, intent: options?.intent });
          return {};
        },
      ),
    };
    const facade = createFacade(runtime);

    await facade.submitPrompt("plain prompt", { inputId: "cmd-submit" });

    expect(executions.map((entry) => entry.intent?.modelSelection)).toEqual([SELECTION_A]);
  });

  it("取消后重试按提交时冻结的选择重放，不读取切模后的 Session", async () => {
    const { admissions, runtime, setSelection } = createRecordingRuntime(SELECTION_A);
    const facade = createFacade(runtime);

    await facade.sendInput("cancelled then retried", { inputId: "cmd-cancel", delivery: "auto" });
    // canonical intent 是取消/重试重放读取的事实，提交边界必须已经冻结完整选择。
    const canonicalIntent = admissions[0]?.intent;
    expect(canonicalIntent).toBeDefined();
    if (!canonicalIntent) throw new Error("submission boundary did not freeze an intent");

    // 取消只移除队列项，不改写 canonical intent。
    const projection = new ProductProjection("session", "epoch");
    projection.applyEvent(
      frozenQueuedEvent(
        1,
        { ...canonicalIntent, queueItemId: "frozen-pending-1" },
        "cancelled then retried",
      ),
    );
    projection.applyEvent({
      id: "frozen-discarded",
      sessionId: "session",
      turnId: "turn",
      type: SessionEventType.TurnSteerDiscarded,
      timestamp: new Date(2000),
      traceId: "trace",
      sequenceNumber: 2,
      payload: {
        pendingInputIds: ["frozen-pending-1"],
        reason: "user_removed",
        targetTurnId: "turn",
      },
    } as SessionEvent);
    expect(projection.getSnapshot().queue.items).toHaveLength(0);

    // 切到 B 后重试：重放提交时的 canonical intent，仍使用 A。
    setSelection(SELECTION_B);
    await facade.sendInput("cancelled then retried", {
      inputId: "cmd-retry",
      delivery: "auto",
      intent: canonicalIntent,
    });
    expect(admissions.at(-1)?.intent?.modelSelection).toEqual(SELECTION_A);
  });
});
