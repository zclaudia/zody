import type { AgentRuntime, TurnAttachment, TurnResult } from "@zody/core";
import {
  SessionEventType,
  createQueryId,
  traceContextToLogContext,
  type InputHistoryEntry,
  type InputHistoryKind,
  type InputHistoryStorePort,
  type Logger,
  type QueryId,
  type SessionId,
  type ToolArtifactStorePort,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zody/contracts";
import {
  externalizePromptAttachments,
  materializeInputHistoryEntry,
  normalizePromptInput,
  projectInputHistoryAttachments,
} from "./prompt-input.js";
import { composeInputIntentMetadata } from "./input-intent-metadata.js";
import { freezeSubmissionModelSelection } from "./provider-registry-selection.js";
import { queueItemIdForSubmission } from "./session-input-id.js";
import type { PrepareUserExecutionBoundary, SubmitPromptOptions, ZCodeApp } from "./types.js";

/**
 * legacy 提交没有 V4 CommandInbox 的 per-bucket admission 序号；用单调时间序列生成唯一值。
 * V4 admissionSeq 是小整数，本序列以毫秒为起点只增不减，既不会与 V4 项冲突，也不会让
 * 多条 guide 得到相同值（UI 用 `-(admissionSeq + 1)` 生成 pending rowId）。
 */
let lastSynthesizedAdmissionSeq = 0;

function nextSynthesizedAdmissionSeq(now: number): number {
  lastSynthesizedAdmissionSeq = Math.max(now, lastSynthesizedAdmissionSeq + 1);
  return lastSynthesizedAdmissionSeq;
}

type InputFacade = Pick<
  ZCodeApp,
  | "continueActiveTarget"
  | "enqueueDeferredInput"
  | "recordInputHistory"
  | "editQueueItem"
  | "recallPreviousInputHistory"
  | "removeQueueItem"
  | "reserveQueueItem"
  | "markQueueItemPromoting"
  | "releaseQueueItemReservation"
  | "clearQueueItems"
  | "completeExternalQueueDrain"
  | "reorderQueueItem"
  | "setQueueAutoDrain"
  | "setFollowupMode"
  | "sendInput"
  | "steerTurn"
  | "submitPrompt"
>;

interface CreateInputFacadeDeps {
  artifactStore?: ToolArtifactStorePort;
  customCommandPromptResolver?: (
    text: string,
    options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
  ) => Promise<string | undefined>;
  inputHistoryStore?: InputHistoryStorePort;
  logger: Logger;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  runtime: AgentRuntime;
  sessionId: SessionId;
  traceContext: TraceContext;
}

export function createInputFacade(deps: CreateInputFacadeDeps): InputFacade {
  const preparePromptBoundary = async (options?: SubmitPromptOptions): Promise<void> => {
    await deps.prepareUserExecutionBoundary(options);
  };

  /**
   * I03（2026-10-24 语义反转获批）：普通 CLI 的提交边界把当时的完整 ModelSelection
   * 冻结进 canonical intent，Queue/Guide/Turn 之后只读这份事实。
   *
   * 修复原因：旧实现只在 turn.ts 执行时 `intent.modelSelection ?? getSessionModelSelection()`，
   * 用户「入队 → 切模型 → 队列消费」时已接纳的输入会静默改用消费时的 Session 值。
   * 依据是 V4 接收边界先例（`resolveSubmittedExecutionState`）：固定完成后 Queue/Guide
   * 不再读取可变 Session。
   *
   * 显式 intent（V4 payload / automation / edit-retry）属于各自 owner，绝不覆盖；
   * 读不到完整 Selection 时在 admission 前失败，不能只写半份事实或省略字段回读 Session。
   */
  const freezeSubmissionIntent = (
    intent: TurnInputIntentMetadata | undefined,
    submission: {
      text: string;
      kind?: TurnInputIntentMetadata["kind"];
      inputId?: string;
      queryId?: QueryId;
      requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
      admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
    },
  ): TurnInputIntentMetadata => {
    if (intent?.modelSelection) return intent;
    const modelSelection = freezeSubmissionModelSelection({
      runtimeSelection: deps.runtime.getSessionModelSelection(),
    });
    if (!modelSelection) {
      throw new Error("Cannot submit prompt without a provider-qualified session model selection");
    }
    if (intent) return { ...intent, modelSelection };
    // 未携带 intent 的历史调用方（TUI / headless compact 等）也需要一条完整 canonical
    // intent；身份/admission 缺省与 V4 `inputIntentMetadata` 共用同一组装函数。
    const sourceCommandId = submission.inputId ?? submission.queryId ?? createQueryId();
    const admittedAt = Date.now();
    return composeInputIntentMetadata(
      {
        sourceCommandId,
        kind: submission.kind ?? "sendText",
      },
      {
        admissionSeq: nextSynthesizedAdmissionSeq(admittedAt),
        admittedAt,
        queueItemId: queueItemIdForSubmission(sourceCommandId),
      },
      {
        text: submission.text,
        modelSelection,
        requestedDelivery: submission.requestedDelivery,
        ...(submission.admittedDelivery ? { admittedDelivery: submission.admittedDelivery } : {}),
      },
    );
  };

  const recordAcceptedInputHistory = async (
    text: string,
    kind: InputHistoryKind,
    recordTraceContext: TraceContext,
    attachments?: TurnAttachment[],
  ): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    try {
      return await deps.inputHistoryStore.recordInputHistory({
        attachments: projectInputHistoryAttachments(attachments),
        kind,
        projectID: deps.runtime.getProjectId(),
        sessionID: deps.sessionId,
        text,
      });
    } catch (error) {
      deps.logger.warn("Input history write failed", {
        ...traceContextToLogContext(recordTraceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "input_history.record.failed",
        kind,
        module: "bootstrap",
        projectId: deps.runtime.getProjectId(),
        status: "failed",
      });
      return null;
    }
  };

  const recallPreviousInputHistory = async (skip?: number): Promise<InputHistoryEntry | null> => {
    if (!deps.inputHistoryStore) return null;
    const entry = await deps.inputHistoryStore.recallPreviousInputHistory({
      projectID: deps.runtime.getProjectId(),
      skip,
    });
    return await materializeInputHistoryEntry(entry, deps.artifactStore);
  };

  const runPromptTurn = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<TurnResult> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    await recordAcceptedInputHistory(
      promptInput.text,
      "prompt",
      options?.traceContext ?? deps.traceContext,
      storedAttachments,
    );
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const runtimePromptText = resolvedCommandPrompt ?? promptInput.text;
    const turnAttribution = options?.automationId ? { automationId: options.automationId } : {};
    // fork（F4.3）：offPeakTaskId/offPeakRunType 归因分支随闲时任务全链路删除。
    return await deps.runtime.executeTurn(runtimePromptText, storedAttachments, {
      abortSignal: options?.abortSignal,
      browserAmbientContext: options?.browserAmbientContext,
      continueActiveTargetAfterTurn: true,
      ...(resolvedCommandPrompt !== undefined ? { displayInput: promptInput.text } : {}),
      inputId: options?.inputId,
      ...turnAttribution,
      intent: options?.intent,
      sharedContextRefs: options?.sharedContextRefs,
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext ?? deps.traceContext,
      modelExecution: options?.modelExecution,
    });
  };

  const prepareRuntimePrompt = async (
    promptInput: ReturnType<typeof normalizePromptInput>,
    options?: SubmitPromptOptions,
  ): Promise<{ input: string; storedAttachments?: TurnAttachment[] }> => {
    const storedAttachments = await externalizePromptAttachments(promptInput.attachments, {
      artifactStore: deps.artifactStore,
      sessionId: deps.sessionId,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    const resolvedCommandPrompt = await deps.customCommandPromptResolver?.(promptInput.text, {
      abortSignal: options?.abortSignal,
      traceContext: options?.traceContext ?? deps.traceContext,
    });
    return {
      input: resolvedCommandPrompt ?? promptInput.text,
      ...(storedAttachments ? { storedAttachments } : {}),
    };
  };

  return {
    continueActiveTarget: async (options) => {
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        // cold resume 会在 prepare boundary 内触发 SessionStart Hook review。必须先订阅，
        // 否则 ReviewRequested 发生在订阅窗口之前，Dual ACK 永远拿不到释放 authority。
        await preparePromptBoundary(options);
        return await deps.runtime.continueActiveTargetLoop({
          abortSignal: options?.abortSignal,
          inputId: options?.inputId,
          intent: options?.intent,
          traceContext: options?.traceContext ?? deps.traceContext,
          trigger: "manual",
          verifyBeforeFirstContinue: false,
        });
      } finally {
        unsubscribe?.();
      }
    },
    recordInputHistory: async (input, kind = "slash_command") => {
      const promptInput = normalizePromptInput(input);
      const attachments = await externalizePromptAttachments(promptInput.attachments, {
        artifactStore: deps.artifactStore,
        sessionId: deps.sessionId,
        traceContext: deps.traceContext,
      });
      return recordAcceptedInputHistory(promptInput.text, kind, deps.traceContext, attachments);
    },
    recallPreviousInputHistory,
    sendInput: async (input, options) => {
      const promptInput = normalizePromptInput(input);
      const delivery = options?.delivery ?? "auto";
      const unsubscribe =
        options?.onEvent || options?.onTurnStartedObserved
          ? deps.runtime.subscribeEvents({
              onSessionEvent: async (event) => {
                await options.onEvent?.(event);
                if (
                  event.type === SessionEventType.TurnStarted &&
                  (event.payload as { inputId?: unknown }).inputId === options.inputId
                ) {
                  // TurnStarted 只用于后续关联；admission ACK 不等待 projection commit。
                  options.onTurnStartedObserved?.(event);
                }
              },
            })
          : undefined;
      try {
        // resume review 属于本次 prompt 生命周期，订阅覆盖 prepare boundary；Core admission
        // 在同一个 session runtime 内完成 start/queue，不在这里读取 activeTurn 做分叉。
        await preparePromptBoundary(options);
        // prepare boundary 可能刚从持久化恢复 Session Selection（cold resume），因此必须在它
        // 之后、进入 admission 之前冻结；提前读会把 Registry/config 默认值当成会话事实。
        const intent = freezeSubmissionIntent(options?.intent, {
          text: promptInput.text,
          kind: options?.commandKind,
          inputId: options?.inputId,
          queryId: options?.queryId,
          requestedDelivery:
            options?.queueDelivery === "guide" || options?.delivery === "steer_active_turn"
              ? "guide"
              : options?.requireQueue === true
                ? "queue"
                : options?.delivery === "start_turn"
                  ? "startNow"
                  : "auto",
        });
        const prepared = await prepareRuntimePrompt(promptInput, options);
        const result = await deps.runtime.admitPrompt(prepared.input, prepared.storedAttachments, {
          ...options,
          delivery,
          intent,
          traceContext: options?.traceContext ?? deps.traceContext,
          ...(prepared.input !== promptInput.text ? { displayInput: promptInput.text } : {}),
        });
        if (result.kind === "started") {
          await recordAcceptedInputHistory(
            promptInput.text,
            "prompt",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
          if (unsubscribe) void result.completion.then(unsubscribe, unsubscribe);
          return {
            completion: result.completion,
            kind: "started_turn",
            turnId: result.turnId,
          };
        }
        unsubscribe?.();
        if (result.kind === "queued") {
          await recordAcceptedInputHistory(
            promptInput.text,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
            prepared.storedAttachments,
          );
        }
        return result;
      } catch (error) {
        unsubscribe?.();
        throw error;
      }
    },
    enqueueDeferredInput: async (input, options) => {
      // 队列项在消费时可能早已切模：提交边界先冻结完整选择，Queue/Guide 不再回读 Session。
      const intent = freezeSubmissionIntent(options?.intent, {
        text: input,
        kind: options?.commandKind,
        inputId: options?.inputId,
        queryId: options?.queryId,
        requestedDelivery: options?.delivery ?? "queue",
      });
      const result = await deps.runtime.enqueueDeferredInput({
        input,
        inputPresentation: "user_steer",
        ...(options?.commandKind ? { commandKind: options.commandKind } : {}),
        ...(options?.delivery ? { delivery: options.delivery } : {}),
        intent,
        ...(options?.attachments ? { attachments: options.attachments } : {}),
        ...(options?.toolDisallowlist ? { toolDisallowlist: options.toolDisallowlist } : {}),
        ...(intent.queueItemId ? { pendingInputId: intent.queueItemId } : {}),
        ...(options?.inputId ? { inputId: options.inputId } : {}),
        ...(options?.queryId ? { queryId: options.queryId } : {}),
        traceContext: options?.traceContext ?? deps.traceContext,
      });
      if (result.kind === "queued") {
        await recordAcceptedInputHistory(
          input,
          "steered_input",
          options?.traceContext ?? deps.traceContext,
        );
      }
      return result;
    },
    steerTurn: async (input, options) => {
      // guide 也会在当前轮消费 intent 的冻结选择；与 queue 同一提交边界处理。
      const intent = freezeSubmissionIntent(options?.intent, {
        text: input,
        kind: options?.commandKind,
        inputId: options?.inputId,
        queryId: options?.queryId,
        requestedDelivery: options?.delivery ?? "queue",
      });
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        const result = await deps.runtime.steerTurn({
          inputPresentation: "user_steer",
          commandKind: options?.commandKind,
          inputId: options?.inputId,
          queryId: options?.queryId,
          expectedTurnId: options?.expectedTurnId,
          delivery: options?.delivery,
          intent,
          attachments: options?.attachments,
          pendingInputId: intent.queueItemId,
          input,
          toolDisallowlist: options?.toolDisallowlist,
          traceContext: options?.traceContext ?? deps.traceContext,
        });
        if (result.kind === "queued") {
          await recordAcceptedInputHistory(
            input,
            "steered_input",
            options?.traceContext ?? deps.traceContext,
          );
        }
        return result;
      } finally {
        unsubscribe?.();
      }
    },
    removeQueueItem: async (pendingInputId, options) => {
      // v4 queue 单项删除：把 v4 命令桥到 runtime 单项 pending-input 移除。
      return deps.runtime.removePendingInputById({
        pendingInputId,
        reason: options?.reason ?? "user_removed",
        reservationId: options?.reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    reserveQueueItem: async (pendingInputId, reservationId, options) =>
      deps.runtime.reservePendingInputById({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    markQueueItemPromoting: async (pendingInputId, reservationId, options) =>
      deps.runtime.markPendingInputPromoting({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    releaseQueueItemReservation: async (pendingInputId, reservationId, options) =>
      deps.runtime.releasePendingInputReservation({
        pendingInputId,
        reservationId,
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    editQueueItem: async (pendingInputId, newText, options) => {
      // v4 queue 单项编辑：替换排队输入文本（reducer 同 id 原地更新，保位）。
      return deps.runtime.editPendingInputById({
        pendingInputId,
        newText,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    reorderQueueItem: async (pendingInputId, beforePendingInputId, options) => {
      // v4 queue 重排：移动排队项到锚点前（null=队尾）。
      return deps.runtime.reorderPendingInput({
        pendingInputId,
        beforePendingInputId,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    clearQueueItems: async (options) => {
      // v4 clearQueueAndSend：清空 active turn 内存项 + held 投影残留。
      return deps.runtime.clearAllPendingInputs(options?.traceContext ?? deps.traceContext);
    },
    setQueueAutoDrain: async (autoDrain, options) => {
      // v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置事件）。
      await deps.runtime.setQueueAutoDrain({
        autoDrain,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    completeExternalQueueDrain: () => {
      deps.runtime.completeExternalQueueDrain();
    },
    setFollowupMode: async (mode, options) => {
      // v4 setFollowupMode：翻转 followup 路由模式（queue/guide）。
      await deps.runtime.setFollowupMode({
        mode,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    submitPrompt: async (prompt, options) => {
      const promptInput = normalizePromptInput(prompt);
      const unsubscribe = options?.onEvent
        ? deps.runtime.subscribeEvents({ onSessionEvent: options.onEvent })
        : undefined;
      try {
        await preparePromptBoundary(options);
        // 直接开轮同样写入 canonical intent；必须在 prepare boundary 恢复持久化 Selection 之后
        // 读取，执行只读这份冻结值。
        const intent = freezeSubmissionIntent(options?.intent, {
          text: promptInput.text,
          inputId: options?.inputId,
          queryId: options?.queryId,
          requestedDelivery: "startNow",
        });
        return await runPromptTurn(promptInput, { ...options, intent });
      } finally {
        unsubscribe?.();
      }
    },
  };
}
