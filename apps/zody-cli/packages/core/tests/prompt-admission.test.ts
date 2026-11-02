import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type ModelSelection,
  type TurnInputIntentMetadata,
} from "@zody/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRuntime(sessionKey: string, generateText: (input: unknown) => Promise<unknown>) {
  return new AgentRuntime(
    createSessionId(sessionKey),
    {
      mode: "build",
      modelSelection: { providerId: "test-provider", modelId: "test-model" },
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: createTestModelFactory({ generateText: generateText as never }),
    },
  );
}

function admissionOptions(inputId: string) {
  return {
    inputId,
    queryId: inputId,
    traceContext: {
      queryId: inputId,
      sessionId: createSessionId("prompt-admission-test"),
      traceId: `trace-${inputId}`,
    },
  } as never;
}

describe("AgentRuntime prompt admission", () => {
  it("keeps requireQueue input queued even when the runtime is idle", async () => {
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-require-queue", async () => {
      modelCalls += 1;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const admission = await runtime.admitPrompt("future turn", undefined, {
      ...admissionOptions("require-queue"),
      requireQueue: true,
    });

    expect(admission.kind).toBe("queued");
    expect(modelCalls).toBe(0);
  });

  it("reserves before the first turn reaches TurnStarted, so the second prompt is queued", async () => {
    const modelGate = deferred<unknown>();
    let modelCalls = 0;
    const runtime = createRuntime("prompt-admission-reservation", async () => {
      modelCalls += 1;
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("first"));
    const second = await runtime.admitPrompt("second", undefined, admissionOptions("second"));

    if (first.kind !== "started") throw new Error("first prompt was not admitted");
    if (second.kind !== "queued") throw new Error("second prompt was not queued");
    expect(second.kind).toBe("queued");
    expect(modelCalls).toBeLessThanOrEqual(1);

    modelGate.resolve(undefined);
    await first.completion;
  });

  it("queues against activeTurn after the reservation is promoted", async () => {
    const modelGate = deferred<unknown>();
    const runtime = createRuntime("prompt-admission-active", async () => {
      await modelGate.promise;
      return {
        finishReason: "stop",
        text: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("active-first"));
    for (let attempt = 0; attempt < 100 && !runtime.getActiveTurnInfo(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runtime.getActiveTurnInfo()).toBeDefined();

    const second = await runtime.admitPrompt(
      "second",
      undefined,
      admissionOptions("active-second"),
    );
    expect(second.kind).toBe("queued");

    modelGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
  });

  it("keeps the queued Submission Selection after the Session Selection changes", async () => {
    const firstRequestGate = deferred<unknown>();
    const requests: Array<{ providerId: string; reasoningLevel: unknown; context: string }> = [];
    const runtime = new AgentRuntime(
      createSessionId("prompt-admission-frozen-submission-selection"),
      {
        mode: "build",
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              providerId: String(observation.model.providerId),
              reasoningLevel: observation.model.options.reasoningLevel,
              context: JSON.stringify(request.messages),
            });
            await firstRequestGate.promise;
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    const first = await runtime.admitPrompt("first", undefined, admissionOptions("frozen-first"));
    const second = await runtime.admitPrompt("second", undefined, {
      ...admissionOptions("frozen-second"),
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "low" },
        },
        requestedDelivery: "queue",
        sourceCommandId: "frozen-second",
      },
    });
    expect(second.kind).toBe("queued");

    runtime.setSessionModelSelection({
      providerId: "provider-c",
      modelId: "model-c",
      options: { reasoningLevel: "high" },
    });

    const queuedInput = (await runtime.getProjection()).pendingSteerInputs.find(
      (input) => input.pendingInputId === second.pendingInputId,
    );
    expect(queuedInput?.intent?.modelSelection).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    });
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "provider-c",
      modelId: "model-c",
    });

    firstRequestGate.resolve(undefined);
    if (first.kind === "started") await first.completion;
    // 不只断言队列里的 DTO：按消费者接到的冻结 intent 开新 Turn，验证正式 Model 和 Context。
    await runtime.executeTurn("second", undefined, { intent: queuedInput?.intent });
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-b", reasoningLevel: "low" });
    expect(requests.at(-1)?.context).toContain("provider-b/model-b");
    expect(requests.at(-1)?.context).not.toContain("provider-c/model-c");
  });

  it("treats a runtime command drain as busy even without an active turn", async () => {
    const runtime = createRuntime("prompt-admission-drain", async () => ({
      finishReason: "stop",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const internal = runtime as unknown as { runtimeCommandDrainActive: boolean };
    internal.runtimeCommandDrainActive = true;

    const admission = await runtime.admitPrompt(
      "during drain",
      undefined,
      admissionOptions("during-drain"),
    );

    expect(admission.kind).toBe("queued");
    internal.runtimeCommandDrainActive = false;
  });

  it("keeps two session runtimes independent while both foreground turns are running", async () => {
    const modelGates = [deferred<unknown>(), deferred<unknown>()];
    let modelCalls = 0;
    const createGatedRuntime = (key: string, gate: ReturnType<typeof deferred<unknown>>) =>
      createRuntime(key, async () => {
        modelCalls += 1;
        await gate.promise;
        return {
          finishReason: "stop",
          text: key,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      });
    const firstRuntime = createGatedRuntime("prompt-admission-a", modelGates[0]!);
    const secondRuntime = createGatedRuntime("prompt-admission-b", modelGates[1]!);

    const first = await firstRuntime.admitPrompt("a", undefined, admissionOptions("a"));
    const second = await secondRuntime.admitPrompt("b", undefined, admissionOptions("b"));

    if (first.kind !== "started" || second.kind !== "started") {
      throw new Error("both sessions must be admitted independently");
    }
    for (let attempt = 0; attempt < 100 && modelCalls < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(modelCalls).toBe(2);

    modelGates[0]!.resolve(undefined);
    modelGates[1]!.resolve(undefined);
    await Promise.all([first.completion, second.completion]);
  });
});

// I03 语义反转（2026-10-24 获批）：普通 CLI 提交边界把当时的完整 ModelSelection 冻结进 canonical
// intent，执行只读冻结值。本组用例锁住消费侧合同：入队后切模不改写已接纳项，取消/重试沿用冻结值。
// 冻结值的生产由 bootstrap input facade 负责（见 bootstrap/tests/queue-input-fidelity.test.ts）。
describe("frozen submission selection", () => {
  const SELECTION_A: ModelSelection = { providerId: "provider-a", modelId: "model-a" };
  const SELECTION_B: ModelSelection = { providerId: "provider-b", modelId: "model-b" };

  // 完整 canonical intent：runtime 的类型要求全部字段，测试不能靠 vitest 转译绕过 tsc。
  function frozenIntent(
    id: string,
    modelSelection: ModelSelection,
    requestedDelivery: TurnInputIntentMetadata["requestedDelivery"],
  ): TurnInputIntentMetadata {
    return {
      sourceCommandId: id,
      queueItemId: `queue_${id}`,
      clientId: "cli",
      kind: "sendText",
      text: id,
      modelSelection,
      admissionSeq: 1,
      admittedAt: 1,
      requestedDelivery,
      admittedDelivery:
        requestedDelivery === "guide"
          ? "guide"
          : requestedDelivery === "queue"
            ? "queue"
            : "startNow",
    };
  }

  function createRecordingRuntime(sessionKey: string) {
    const firstRequestGate = deferred<unknown>();
    const requests: Array<{ providerId: string; reasoningLevel: unknown }> = [];
    const runtime = new AgentRuntime(
      createSessionId(sessionKey),
      {
        mode: "build",
        modelSelection: { providerId: "provider-a", modelId: "model-a" },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push({
              providerId: String(observation.model.providerId),
              reasoningLevel: observation.model.options.reasoningLevel,
            });
            if (requests.length === 1) await firstRequestGate.promise;
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    return { firstRequestGate, requests, runtime };
  }

  it("queues A twice, switches to B, and executes each input with its own frozen selection", async () => {
    const { firstRequestGate, requests, runtime } = createRecordingRuntime(
      "prompt-admission-frozen-ab",
    );

    const running = await runtime.admitPrompt("running with A", undefined, {
      ...admissionOptions("frozen-running"),
      intent: frozenIntent("frozen-running", SELECTION_A, "startNow"),
    });
    const firstQueued = await runtime.admitPrompt("first queued with A", undefined, {
      ...admissionOptions("frozen-queued-1"),
      intent: frozenIntent("frozen-queued-1", SELECTION_A, "queue"),
    });
    const secondQueued = await runtime.admitPrompt("second queued with A", undefined, {
      ...admissionOptions("frozen-queued-2"),
      intent: frozenIntent("frozen-queued-2", SELECTION_A, "queue"),
    });
    expect(firstQueued.kind).toBe("queued");
    expect(secondQueued.kind).toBe("queued");

    // 切到 B：只改 Session，不改已接纳 intent。
    runtime.setSessionModelSelection({ providerId: "provider-b", modelId: "model-b" });

    const queued = (await runtime.getProjection()).pendingSteerInputs;
    expect(queued.map((input) => input.intent?.modelSelection)).toEqual([
      { providerId: "provider-a", modelId: "model-a" },
      { providerId: "provider-a", modelId: "model-a" },
    ]);

    firstRequestGate.resolve(undefined);
    if (running.kind === "started") await running.completion;
    expect(requests[0]).toMatchObject({ providerId: "provider-a" });

    // 旧输入按冻结的 A 执行：执行顺序不改变它读到的选择。
    await runtime.executeTurn("first queued with A", undefined, { intent: queued[0]?.intent });
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-a" });

    // 切 B 后提交的新输入冻结为 B；此时 runtime 已空闲，直接开轮执行。
    const newTurn = await runtime.admitPrompt("submitted after switching to B", undefined, {
      ...admissionOptions("frozen-queued-3"),
      intent: frozenIntent("frozen-queued-3", SELECTION_B, "startNow"),
    });
    if (newTurn.kind !== "started") throw new Error("input after switch did not start");
    await newTurn.completion;
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-b" });
  });

  it("drains real guides with their frozen selections after the Session switches to B", async () => {
    const { firstRequestGate, requests, runtime } = createRecordingRuntime(
      "prompt-admission-frozen-guide-drain",
    );

    const running = await runtime.admitPrompt("running with A", undefined, {
      ...admissionOptions("frozen-guide-running"),
      intent: frozenIntent("frozen-guide-running", SELECTION_A, "startNow"),
    });
    for (let attempt = 0; attempt < 100 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(requests).toHaveLength(1);

    // 真实 steerTurn → activeTurn.pendingInputs；随后 turn loop 的 drain 是消费入口。
    // 与卡片反例一致：A 运行时连续入队两条。
    const firstGuide = await runtime.steerTurn({
      input: "first guide with A",
      delivery: "guide",
      intent: frozenIntent("frozen-guide-1", SELECTION_A, "guide"),
    });
    const secondGuide = await runtime.steerTurn({
      input: "second guide with A",
      delivery: "guide",
      intent: frozenIntent("frozen-guide-2", SELECTION_A, "guide"),
    });
    expect(firstGuide.kind).toBe("queued");
    expect(secondGuide.kind).toBe("queued");
    runtime.setSessionModelSelection(SELECTION_B);

    firstRequestGate.resolve(undefined);
    if (running.kind === "started") await running.completion;

    // drain 后每条 guide 的下一次模型请求都必须使用 intent 冻结的 A，而不是当前 Session 的 B。
    expect(requests.map((request) => request.providerId)).toEqual([
      "provider-a",
      "provider-a",
      "provider-a",
    ]);

    // completion resolve 后 runtime command drain 仍可能在本轮 finally 收尾；等 busy 权威事实归零。
    for (let attempt = 0; attempt < 100 && runtime.hasActiveOrQueuedTurnWork(); attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(runtime.hasActiveOrQueuedTurnWork()).toBe(false);

    const afterSwitch = await runtime.admitPrompt("submitted after switching to B", undefined, {
      ...admissionOptions("frozen-guide-after-switch"),
      intent: frozenIntent("frozen-guide-after-switch", SELECTION_B, "startNow"),
    });
    expect(afterSwitch.kind).toBe("started");
    if (afterSwitch.kind !== "started") throw new Error("input after switch did not start");
    await afterSwitch.completion;
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-b" });
  });

  it("removes a cancelled queue item without executing it and keeps the frozen selection on retry", async () => {
    const { firstRequestGate, requests, runtime } = createRecordingRuntime(
      "prompt-admission-frozen-cancel-retry",
    );

    const cancelTraceContext = {
      queryId: "cancel-queued",
      sessionId: createSessionId("prompt-admission-frozen-cancel-retry"),
      traceId: "trace-cancel-queued",
    };
    const selectionAWithHigh: ModelSelection = {
      ...SELECTION_A,
      options: { reasoningLevel: "high" },
    };
    const running = await runtime.admitPrompt("running", undefined, admissionOptions("cancel-run"));
    const queued = await runtime.admitPrompt("cancelled then retried", undefined, {
      inputId: "cancel-queued",
      queryId: "cancel-queued",
      traceContext: cancelTraceContext,
      intent: frozenIntent("cancel-queued", selectionAWithHigh, "queue"),
    } as never);
    if (queued.kind !== "queued") throw new Error("queued input was not admitted");

    const removed = await runtime.removePendingInputById({
      pendingInputId: queued.pendingInputId,
      reason: "user_removed",
      traceContext: cancelTraceContext,
    });
    expect(removed).toBe(true);
    expect(
      (await runtime.getProjection()).pendingSteerInputs.some(
        (input) => input.pendingInputId === queued.pendingInputId,
      ),
    ).toBe(false);

    firstRequestGate.resolve(undefined);
    if (running.kind === "started") await running.completion;
    expect(requests).toHaveLength(1);

    // 切换模型后重试（重放 canonical intent）：仍使用冻结的 A，而不是 Session 的 B。
    runtime.setSessionModelSelection({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "low" },
    });
    const frozenRetryIntent = frozenIntent("cancel-queued", selectionAWithHigh, "queue");
    await runtime.executeTurn("cancelled then retried", undefined, { intent: frozenRetryIntent });
    expect(requests.at(-1)).toMatchObject({ providerId: "provider-a", reasoningLevel: "high" });
    expect(requests).toHaveLength(2);
  });
});

it("renders a human guide through real admission and keeps the ongoing turn", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const requests: unknown[] = [];
  const runtime = createRuntime("human-guide-presentation", async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      entered.resolve();
      await release.promise;
    }
    return {
      finishReason: "stop",
      text: requests.length === 1 ? "working on A" : "continued A",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  });
  const first = await runtime.admitPrompt("task A");
  await entered.promise;
  const guide = await runtime.admitPrompt("short B", undefined, { queueDelivery: "guide" });
  expect(guide.kind).toBe("queued");
  release.resolve();
  if (first.kind !== "started") throw new Error("first not started");
  await first.completion;
  expect(requests).toHaveLength(2);
  const messages = (requests[1] as { messages: Array<{ role: string; content: unknown }> })
    .messages;
  const incoming = messages.find(
    (message) =>
      typeof message.content === "string" &&
      message.content.includes("The user sent a new message while you were working:"),
  );
  expect(incoming).toMatchObject({
    role: "user",
    content:
      "<system-reminder>\nThe user sent a new message while you were working:\nshort B\n\nThis is how Zody surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>",
  });
});
