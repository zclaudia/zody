import { createHash } from "node:crypto";
import { sameCuaObservationRef } from "./cua-runtime-observation-ref.js";
import type { AgentRuntime } from "@zody/core";
import {
  createCuaNativeAuthoritySession,
  type CuaNativeAuthorityImageToolResult,
} from "@zody/adapters/mcp";
import type {
  CuaNativeCaptureExpectation,
  CuaNativeCaptureRuntimeOptions,
} from "./cua-runtime-native-capture.js";

export type CuaObservationRequest = {
  readonly method:
    | "list_apps"
    | "list_windows"
    | "get_app_state"
    | "commit_state"
    | "left_click"
    | "perform_action"
    | "set_value"
    | "stop_computer_control";
  readonly arguments: Record<string, unknown>;
};
export type CuaObservationResult = CuaNativeAuthorityImageToolResult;
export type CuaObservationOptions = {
  readonly expected: CuaNativeCaptureExpectation;
  readonly signal?: AbortSignal;
  readonly onLeaseWatcher?: (watcher: { close(): void; waitForClose(): Promise<unknown> }) => void;
};

let diagnosticSequence = 0;

/** 只在可信 composition 使用；预期身份来自宿主，不接受模型声明。 */
export async function observeCuaRuntimeOnce(
  runtime: AgentRuntime,
  options: CuaNativeCaptureRuntimeOptions &
    CuaObservationOptions & { readonly request: CuaObservationRequest },
): Promise<CuaObservationResult> {
  options.signal?.throwIfAborted();
  const scope = runtime.createCuaSubmissionTurnScope();
  if (!scope) throw new Error("cua_native_observation_scope_unavailable");
  if (
    !options.expected ||
    scope.ref.sessionId !== options.expected.sessionId ||
    scope.ref.workspaceKey !== options.expected.workspaceKey ||
    (options.expected.workspaceIdentity !== undefined &&
      options.expected.workspaceIdentity !== options.expected.workspaceKey) ||
    (runtime.matchesCuaContext
      ? !runtime.matchesCuaContext(options.expected)
      : Boolean(options.expected.workspaceIdentity || options.expected.remoteSessionId)) ||
    scope.turnId !== options.expected.turnId
  ) {
    scope.close();
    throw new Error("cua_native_observation_scope_mismatch");
  }
  // 中文原因：仅以真实 scope 通知建立撤销顺序证据；诊断不持有权限，也不包含正文或原始身份。
  const observationId = ++diagnosticSequence;
  const scopeDigest = createHash("sha256")
    .update(
      JSON.stringify([
        scope.ref,
        scope.traceId,
        options.producerIncarnation,
        scope.runId,
        scope.turnId,
      ]),
    )
    .digest("hex");
  const audit = (
    event: "allowed" | "invalidated" | "accepted" | "delivered" | "discarded",
    reason?: "owner-revoked" | "scope-closed",
  ) => {
    try {
      options.logger?.info(
        `cua-read-delivery: ${JSON.stringify({ pid: process.pid, observationId, sequence: ++diagnosticSequence, scopeDigest, event, ...(reason ? { reason } : {}) })}`,
      );
    } catch {
      /* 诊断失败不改变授权与交付。 */
    }
  };
  let invalidated: string | undefined;
  const unsubscribe = scope.onInvalidated((reason) => {
    invalidated = reason;
    audit("invalidated", reason);
  });
  let session: ReturnType<typeof createCuaNativeAuthoritySession> | undefined;
  let stream: Awaited<ReturnType<typeof options.connect>> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let accepted = false;
  let leaseWatch = false;
  let removeRaceAbort = () => {};
  const off = scope.onInvalidated((reason) => {
    // 正常收尾在 accept 之后关闭 scope；之前的 scope-closed 是真实取消。
    if (reason !== "scope-closed" || !accepted) controller.abort();
  });
  try {
    controller.signal.throwIfAborted();
    stream = await options.connect(controller.signal);
    if (controller.signal.aborted || invalidated)
      throw new Error("cua_native_observation_scope_invalidated");
    let resolve!: (result: CuaObservationResult) => void;
    let reject!: (error: Error) => void;
    const resultPromise = new Promise<CuaObservationResult>((a, b) => {
      resolve = a;
      reject = b;
    });
    session = createCuaNativeAuthoritySession({
      scope,
      stream,
      producerIncarnation: options.producerIncarnation,
      observation: {
        request: options.request,
        association: Object.freeze({
          ...(options.expected.workspaceIdentity || options.expected.remoteSessionId
            ? {
                workspaceIdentity:
                  options.expected.workspaceIdentity || options.expected.workspaceKey,
              }
            : {}),
          ...(options.expected.remoteSessionId
            ? { remoteSessionId: options.expected.remoteSessionId }
            : {}),
        }),
        onLeaseWatch: () => {
          leaseWatch = true;
        },
        accept: (result) => {
          accepted = true;
          audit("accepted");
          resolve(result);
        },
        onRejected: (reason) => reject(new Error(`cua_native_observation_rejected:${reason}`)),
      },
      confirmControlRequest: async ({ generation, target }) => {
        const result = await runtime.requestCuaNativeControlConfirmation({
          generation,
          target,
          sessionId: scope.ref.sessionId,
          workspaceKey: scope.ref.workspaceKey,
          traceId: scope.traceId,
          runId: scope.runId,
          turnId: scope.turnId,
          signal: controller.signal,
        });
        return result.failureReason
          ? { ok: false, reason: result.failureReason }
          : { allowed: result.allowed };
      },
      confirmReadRequest: async ({ generation, target }) => {
        const result = await runtime.requestCuaNativeReadConfirmation({
          generation,
          target,
          sessionId: scope.ref.sessionId,
          workspaceKey: scope.ref.workspaceKey,
          traceId: scope.traceId,
          runId: scope.runId,
          turnId: scope.turnId,
          signal: controller.signal,
        });
        if (result.allowed && !result.failureReason) audit("allowed");
        return result.failureReason
          ? { ok: false, reason: result.failureReason }
          : { allowed: result.allowed };
      },
    });
    const close = session.waitForClose();
    const result = await Promise.race([
      resultPromise,
      close.then((c) => {
        throw new Error(`cua_native_observation_closed:${c.reason}`);
      }),
      new Promise<never>((_, fail) => {
        const onAbort = () => {
          session?.close();
          fail(new Error("cua_native_observation_aborted"));
        };
        if (controller.signal.aborted) onAbort();
        else {
          controller.signal.addEventListener("abort", onAbort, { once: true });
          removeRaceAbort = () => controller.signal.removeEventListener("abort", onAbort);
        }
      }),
    ]);
    const closed = leaseWatch ? undefined : await close;
    if (
      (closed && closed.reason !== "adapter-close") ||
      controller.signal.aborted ||
      (invalidated !== undefined && invalidated !== "scope-closed")
    )
      throw new Error("cua_native_observation_scope_invalidated");
    const p = runtime.getCuaSubmissionProjection();
    const active = runtime.getActiveTurnInfo();
    if (
      p.status !== "candidate" ||
      !sameCuaObservationRef(p.ref, scope.ref) ||
      active?.turnId !== scope.turnId
    )
      throw new Error("cua_native_observation_scope_superseded");
    audit("delivered");
    if (leaseWatch) {
      options.onLeaseWatcher?.(session);
      // 单次工具调用返回后 broker 会关闭该请求 socket；持续监听只跟随 owner scope。
      options.signal?.removeEventListener("abort", abort);
      // watcher 保持同一 authority 直到失效或 lease 正常关闭；不能在返回结果时关闭 scope。
      void close.finally(() => {
        options.signal?.removeEventListener("abort", abort);
        off();
        unsubscribe();
        controller.abort();
      });
    }
    return result;
  } catch (error) {
    leaseWatch = false;
    audit("discarded");
    if (session) {
      session.close();
      await session.waitForClose().catch(() => undefined);
    } else {
      stream?.destroy();
      scope.close();
    }
    throw error;
  } finally {
    removeRaceAbort();
    if (!leaseWatch || !accepted) {
      options.signal?.removeEventListener("abort", abort);
      off();
      unsubscribe();
      controller.abort();
    }
  }
}
