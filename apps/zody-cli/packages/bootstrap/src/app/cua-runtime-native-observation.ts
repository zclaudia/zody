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
  readonly method: "list_apps" | "list_windows" | "get_app_state";
  readonly arguments: Record<string, unknown>;
};
export type CuaObservationResult = CuaNativeAuthorityImageToolResult;
export type CuaObservationOptions = {
  readonly expected: CuaNativeCaptureExpectation;
  readonly signal?: AbortSignal;
};

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
    scope.turnId !== options.expected.turnId
  ) {
    scope.close();
    throw new Error("cua_native_observation_scope_mismatch");
  }
  let invalidated: string | undefined;
  const unsubscribe = scope.onInvalidated((reason) => {
    invalidated = reason;
  });
  let session: ReturnType<typeof createCuaNativeAuthoritySession> | undefined;
  let stream: Awaited<ReturnType<typeof options.connect>> | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let accepted = false;
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
        accept: (result) => {
          accepted = true;
          resolve(result);
        },
        onRejected: (reason) => reject(new Error(`cua_native_observation_rejected:${reason}`)),
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
    const closed = await close;
    if (
      closed.reason !== "adapter-close" ||
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
    return result;
  } catch (error) {
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
    options.signal?.removeEventListener("abort", abort);
    off();
    unsubscribe();
    controller.abort();
  }
}
