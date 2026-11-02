import type { MessageId, Model, ModelToolCall, TraceContext } from "../deps.js";
import type { StreamedToolExecutionResult } from "../types.js";

export interface StreamingToolCoordinatorOptions {
  assistantMessageId: MessageId;
  model: Model;
  traceContext: TraceContext;
}

export interface StreamingToolExecutionOptions {
  abortSignal: AbortSignal;
  assistantMessageId: MessageId;
  declarationIndex: number;
  model: Model;
  toolCall: ModelToolCall;
  traceContext: TraceContext;
}

export interface StreamingToolCoordinator {
  accept(toolCall: ModelToolCall): void;
  abandon(reason: "cancelled" | "model_failed"): Promise<void>;
  drain(toolCalls: readonly ModelToolCall[]): Promise<StreamedToolExecutionResult[]>;
  recordReasoningDelta(text: string): void;
  recordTextDelta(text: string): void;
  recoverFromModelFailure(
    error: unknown,
    assistantCreatedAt: number,
    options?: { failedRequestId?: string },
  ): Promise<boolean>;
  settleForModelFallback(assistantCreatedAt: number): Promise<boolean>;
}
