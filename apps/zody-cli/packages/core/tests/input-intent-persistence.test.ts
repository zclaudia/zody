import { describe, expect, it } from "vitest";
import type { TurnInputIntentMetadata } from "@zody/contracts";
import { buildPersistedConversationInputIntent } from "../src/runtime/methods/input-intent-persistence.js";

describe("persisted conversation input intent", () => {
  it.each(["build", "guarded", "yolo"] as const)(
    "persists %s with canonical goal text and queue intent",
    (mode) => {
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: "command-goal",
        queueItemId: "queue-goal",
        clientId: "desktop-goal",
        kind: "sendGoalCommand",
        text: "X",
        admissionSeq: 3,
        admittedAt: 999,
        requestedDelivery: "queue",
        admittedDelivery: "queue",
        modelSelection: {
          providerId: "account:bigmodel-team-coding-plan",
          modelId: "GLM-5.3",
          options: { reasoningLevel: "high" },
        },
        mode,
        sharedContextRefs: [{ kind: "shared_context_import", context_id: "context-1" }],
      };

      expect(
        buildPersistedConversationInputIntent("/GoAl replace X", intent, "queued"),
      ).toMatchObject({
        kind: "sendGoalCommand",
        text: "X",
        modelSelection: intent.modelSelection,
        mode,
        sharedContextRefs: intent.sharedContextRefs,
      });
    },
  );

  it("取消后重试沿用的冻结选择随 intent 持久化，不在恢复时回读当前 Session", () => {
    // I03（2026-10-24 语义反转）：queued/drained 两种 dispatch 状态都必须带出提交边界冻结的
    // modelSelection；冷恢复与 edit/retry 重放只能读这份事实，不能拿执行时的 Session 值补。
    const frozenSelection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" as const },
    };
    const intent: TurnInputIntentMetadata = {
      sourceCommandId: "command-retry-frozen",
      queueItemId: "queue-retry-frozen",
      clientId: "cli",
      kind: "sendText",
      text: "retry me",
      modelSelection: frozenSelection,
      admissionSeq: 5,
      admittedAt: 1001,
      requestedDelivery: "queue",
      admittedDelivery: "queue",
      provenance: {
        sourceCommandId: "command-original",
        queueItemId: "queue-original",
        clientId: "cli",
      },
    };

    for (const dispatchState of ["queued", "drained"] as const) {
      expect(
        buildPersistedConversationInputIntent("retry me", intent, dispatchState),
      ).toMatchObject({
        modelSelection: frozenSelection,
        provenance: intent.provenance,
        delivery: { requested: "queue", admitted: "queue" },
      });
    }
  });

  it("persists retry provenance with the rebuilt command intent", () => {
    const intent: TurnInputIntentMetadata = {
      sourceCommandId: "command-retry",
      queueItemId: "queue-retry",
      clientId: "desktop-new",
      kind: "sendText",
      text: "original text",
      admissionSeq: 4,
      admittedAt: 1000,
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      provenance: {
        sourceCommandId: "command-original",
        queueItemId: "queue-original",
        clientId: "desktop-original",
      },
    };

    expect(buildPersistedConversationInputIntent("original text", intent, "drained")).toMatchObject(
      {
        sourceCommandId: "command-retry",
        provenance: {
          sourceCommandId: "command-original",
          queueItemId: "queue-original",
          clientId: "desktop-original",
        },
      },
    );
  });
});
