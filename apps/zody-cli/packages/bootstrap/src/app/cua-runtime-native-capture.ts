import type { Duplex } from "node:stream";
import type {
  CuaSubmissionRef,
  ImageProcessorPort,
  Logger,
  McpPort,
  McpServerConfig,
} from "@zody/contracts";
import type { AgentRuntime } from "@zody/core";
import {
  createCuaNativeAuthoritySession,
  type CuaNativeAuthorityCaptureOptions,
  type CuaNativeAuthorityCloseResult,
  type CuaNativeAuthorityImageToolResult,
  type CuaNativeAuthoritySession,
  type CuaNativeAuthoritySessionOptions,
  type CuaNativeCaptureResultPayload,
  type CuaNativeCaptureTarget,
} from "@zody/adapters/mcp";

/** 与现有 node_repl 图片展示预算一致；只约束模型可见副本，不改变 native PNG 32 MiB 证据上限。 */
const MAX_NODE_REPL_IMAGE_BASE64_BYTES = 200 * 1024;
const MAX_NODE_REPL_IMAGE_RAW_BYTES = Math.floor((MAX_NODE_REPL_IMAGE_BASE64_BYTES * 3) / 4);
const MAX_NODE_REPL_IMAGE_DIMENSION = 2_048;

export interface CuaNativeCaptureRuntimeOptions {
  /** 由可信 launcher 的 session-ready endpoint 构造；每次截图新建一条 authority conn。 */
  connect(signal?: AbortSignal): Promise<Duplex>;
  readonly producerIncarnation: string;
  readonly captureRoot: string;
  /** 候选交付事实写入既有 app logger；纯观测，失败不得影响截图结果。 */
  readonly logger?: Pick<Logger, "info">;
}

export interface CuaNativeCaptureOnceOptions {
  readonly signal?: AbortSignal;
  /** 由真实 node_repl broker 可信上下文传入；只有原 session/workspace/turn 全部匹配才允许截图。 */
  readonly expected?: CuaNativeCaptureExpectation;
}

export interface CuaNativeCaptureExpectation {
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly turnId: string;
}

/**
 * 显式 native launch composition 注入的 node_repl 端口工厂。
 * bootstrap 只定义结构契约，实现由 @zcode/node-repl-host 提供；不反向深导入，避免包循环。
 */
export interface CuaNodeReplMcpPortFactoryInput {
  readonly port: McpPort;
  captureOnce(
    target: CuaNativeCaptureTarget,
    options?: CuaNativeCaptureOnceOptions,
  ): Promise<CuaNativeAuthorityImageToolResult>;
  observationOnce(
    request: import("./cua-runtime-native-observation.js").CuaObservationRequest,
    options: import("./cua-runtime-native-observation.js").CuaObservationOptions,
  ): Promise<import("./cua-runtime-native-observation.js").CuaObservationResult>;
  verifyObservationScope(expected: CuaNativeCaptureExpectation): boolean;
  /** app 是否拥有原端口；wrapper.close 据此决定是否关闭原端口。 */
  readonly closePort: boolean;
  /** 与现有 node_repl browser bridge 同源的宿主 broker；不改变其所有权。 */
  readonly browserBroker?: { readonly socketPath: string; readonly token: string };
}

export type CuaNodeReplMcpPortFactory = ((input: CuaNodeReplMcpPortFactoryInput) => McpPort) & {
  /**
   * 候选本地 node_repl 的 stdio 发现配置。只有 cuaNativeCapture 同时存在且 wrapper
   * 实际接管 base McpPort 时，bootstrap 才把它注入 runtime MCP 面；单独提供 factory
   * 不允许 base 端口自行 spawn 真实 server。
   */
  readonly localServerConfig?: McpServerConfig;
};

/** 显式一次截图；不读取 env/argv、不创建 authority、不在 turn 开始时自动调用。 */
export async function captureCuaRuntimeOnce(
  runtime: AgentRuntime,
  options: CuaNativeCaptureRuntimeOptions & {
    readonly target: CuaNativeCaptureTarget;
    readonly imageProcessorPort?: ImageProcessorPort;
    readonly signal?: AbortSignal;
    readonly expected?: CuaNativeCaptureExpectation;
  },
): Promise<CuaNativeAuthorityImageToolResult> {
  options.signal?.throwIfAborted();
  const scope = runtime.createCuaSubmissionTurnScope();
  if (!scope) {
    // mobile-origin 授权轮次（2026-11-10）：未授权手机发起在 admission 无凭证，这里是
    // 唯一可观测拒绝点。错误码保持不变（下游按字符串匹配），message 附加授权引导，
    // 桌面与手机路径统一文案，避免静默失败。
    throw new Error(
      "cua_native_capture_scope_unavailable: no live CUA submission credential for this turn; " +
        "mobile-origin requests require a prior desktop grant (always-allow rule or full access)",
    );
  }
  if (
    options.expected &&
    (scope.ref.sessionId !== options.expected.sessionId ||
      scope.ref.workspaceKey !== options.expected.workspaceKey ||
      scope.turnId !== options.expected.turnId)
  ) {
    // broker 上下文来自 main 的可信元数据；它与当前 live scope 不符时不能截图到另一轮。
    scope.close();
    throw new Error("cua_native_capture_scope_mismatch");
  }
  let scopeInvalidationReason: "owner-revoked" | "scope-closed" | undefined;
  const unsubscribe = scope.onInvalidated((reason) => {
    scopeInvalidationReason ??= reason;
  });
  let stream: Duplex | undefined;
  let session: CuaNativeAuthoritySession | undefined;
  let closePromise: Promise<CuaNativeAuthorityCloseResult> | undefined;
  let removeAbort: () => void = () => undefined;

  try {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    // 先固定原 turn scope，再等待可信连接；await 期间绝不再向 runtime 取新 scope。
    stream = await options.connect(options.signal);
    if (options.signal?.aborted) {
      stream.destroy();
      throw abortError(options.signal.reason);
    }
    if (scopeInvalidationReason !== undefined) {
      stream.destroy();
      throw captureInvalidationError(scopeInvalidationReason);
    }

    let preparedResult: CuaNativeAuthorityImageToolResult | undefined;
    let acceptedPayload: CuaNativeCaptureResultPayload | undefined;
    let accepted: CuaNativeAuthorityImageToolResult | undefined;
    let resolveAccepted!: (value: CuaNativeAuthorityImageToolResult) => void;
    let rejectAccepted!: (error: unknown) => void;
    const acceptedPromise = new Promise<CuaNativeAuthorityImageToolResult>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const capture: CuaNativeAuthorityCaptureOptions = {
      root: options.captureRoot,
      target: options.target,
      async accept(payload, png) {
        preparedResult = await createCuaNativeCaptureToolResult({
          payload,
          png,
          ...(options.imageProcessorPort ? { imageProcessorPort: options.imageProcessorPort } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        acceptedPayload = payload;
        return preparedResult;
      },
      onRejected(reason) {
        rejectAccepted(new Error(`cua_native_capture_rejected:${reason}`));
      },
      onAccepted() {
        if (!preparedResult) return;
        accepted = preparedResult;
        resolveAccepted(preparedResult);
      },
    };
    // App 内确认弹窗替代 Helper 原生 NSAlert（spec 2026-10-31）：Helper 的 confirm 帧
    // 经该回调转为 runtime 的 user-once permission 请求。AbortController 把外层 capture
    // signal 与 scope 失效级联进 broker 请求：Stop/断连时立即中止弹窗等待，confirm
    // handler 走「不写响应」路径，Helper 靠 EOF 收口。
    const confirmRequest: NonNullable<CuaNativeAuthoritySessionOptions["confirmRequest"]> = async (
      payload,
    ) => {
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onOuterAbort();
      else options.signal?.addEventListener("abort", onOuterAbort, { once: true });
      const unsubscribeInvalidation = scope.onInvalidated(() => controller.abort());
      try {
        const outcome = await runtime.requestCuaNativeCaptureConfirmation({
          generation: payload.generation,
          target: {
            pid: payload.target.pid,
            windowId: payload.target.windowId,
            ownerName: payload.target.ownerName,
            windowName: payload.target.windowName,
          },
          sessionId: scope.ref.sessionId,
          workspaceKey: scope.ref.workspaceKey,
          traceId: scope.traceId,
          runId: scope.runId,
          turnId: scope.turnId,
          signal: controller.signal,
        });
        // runtime 的 confirmation-invalid/unavailable 必须原样映射成 ok:false：
        // 压成 {allowed:false} 会让 Helper 记成 user-canceled，审计语义错位。
        if (outcome.failureReason) {
          return { ok: false, reason: outcome.failureReason };
        }
        return { allowed: outcome.allowed };
      } finally {
        options.signal?.removeEventListener("abort", onOuterAbort);
        unsubscribeInvalidation();
        // 结束/异常都必须 abort controller：不留挂起的 broker 请求，也不留悬空监听。
        controller.abort();
      }
    };
    session = createCuaNativeAuthoritySession({
      scope,
      stream,
      producerIncarnation: options.producerIncarnation,
      capture,
      confirmRequest,
    });
    closePromise = session.waitForClose();
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        session?.close();
        reject(abortError(options.signal?.reason));
      };
      if (!options.signal) return;
      if (options.signal.aborted) onAbort();
      else {
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
    });
    const result = await Promise.race([
      acceptedPromise,
      closePromise.then((closed) => {
        if (accepted) return accepted;
        throw captureCloseError(closed);
      }),
      abortPromise,
    ]);
    const closed = await closePromise;
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    if (scopeInvalidationReason === "owner-revoked") {
      throw new Error("cua_native_capture_owner_revoked");
    }
    if (closed.reason !== "adapter-close") throw captureCloseError(closed);
    const projection = runtime.getCuaSubmissionProjection();
    // 正常 adapter-close 会先 scope.close()，此时 close flush 期间仍可能换新 submission/new turn。
    // 旧图只能在原 owner 完整 ref 仍是唯一 candidate、且原 turn 仍 active 时交付；仅比较
    // lineage identity 会把新 revision/新 turn 误当成原拍照样放行，属于迟到像素复活。
    if (projection.status === "revoked" && sameRefIdentity(projection.ref, scope.ref)) {
      throw new Error("cua_native_capture_owner_revoked");
    }
    const activeTurn = runtime.getActiveTurnInfo?.();
    if (!activeTurn || activeTurn.turnId !== scope.turnId) {
      throw new Error("cua_native_capture_turn_changed");
    }
    if (projection.status === "unknown") {
      throw new Error("cua_native_capture_runtime_unknown");
    }
    if (projection.status !== "candidate" || !sameFullRef(projection.ref, scope.ref)) {
      throw new Error("cua_native_capture_scope_superseded");
    }
    if (acceptedPayload && options.logger) {
      try {
        options.logger.info("CUA native capture delivered", {
          event: "cua.native_capture.delivered",
          module: "bootstrap.cua_capture",
          status: "completed",
          sessionId: scope.ref.sessionId,
          submissionLineageId: scope.ref.submissionLineageId,
          authorizationRevision: scope.ref.authorizationRevision,
          turnId: scope.turnId,
          pngSha256: acceptedPayload.png.sha256,
          width: acceptedPayload.png.width,
          height: acceptedPayload.png.height,
          bytes: acceptedPayload.png.bytes,
          resourcesReleased: acceptedPayload.resourcesReleased,
          machineLeaseReleased: acceptedPayload.machineLeaseReleased,
        });
      } catch {
        // 观测失败不能改变已经完成的截图交付。
      }
    }
    return result;
  } catch (error) {
    if (session) session.close();
    else stream?.destroy();
    if (closePromise) await closePromise.catch(() => undefined);
    else scope.close();
    throw error;
  } finally {
    removeAbort();
    unsubscribe();
  }
}

export async function createCuaNativeCaptureToolResult(input: {
  readonly payload: CuaNativeCaptureResultPayload;
  readonly png: Uint8Array;
  readonly imageProcessorPort?: ImageProcessorPort;
  readonly signal?: AbortSignal;
}): Promise<CuaNativeAuthorityImageToolResult> {
  if (!input.imageProcessorPort) {
    throw new Error("cua_native_capture_image_processor_unavailable");
  }
  const prepared = await input.imageProcessorPort.prepareForModel(
    {
      data: input.png,
      mediaType: "image/png",
      maxDimension: MAX_NODE_REPL_IMAGE_DIMENSION,
      maxBase64Bytes: MAX_NODE_REPL_IMAGE_BASE64_BYTES,
      maxRawBytes: MAX_NODE_REPL_IMAGE_RAW_BYTES,
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  const data = Buffer.from(prepared.data).toString("base64");
  if (Buffer.byteLength(data, "utf8") > MAX_NODE_REPL_IMAGE_BASE64_BYTES) {
    throw new Error("cua_native_capture_image_over_budget");
  }
  if (!/^image\/[a-z0-9.+-]+$/iu.test(prepared.mediaType)) {
    throw new Error("cua_native_capture_image_mime_invalid");
  }
  return {
    content: [
      {
        type: "image",
        data,
        mimeType: prepared.mediaType,
      },
    ],
  };
}

function captureCloseError(closed: CuaNativeAuthorityCloseResult): Error {
  if (closed.reason === "owner-revoked") return new Error("cua_native_capture_owner_revoked");
  if (closed.reason === "scope-closed") return new Error("cua_native_capture_scope_closed");
  return new Error(`cua_native_capture_closed:${closed.reason}`);
}

function captureInvalidationError(reason: "owner-revoked" | "scope-closed"): Error {
  return new Error(
    reason === "owner-revoked"
      ? "cua_native_capture_owner_revoked"
      : "cua_native_capture_scope_closed",
  );
}

function sameRefIdentity(left: CuaSubmissionRef, right: CuaSubmissionRef): boolean {
  return (
    left.submissionLineageId === right.submissionLineageId &&
    left.appIncarnation === right.appIncarnation &&
    left.hostInstanceId === right.hostInstanceId &&
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.sessionId === right.sessionId &&
    left.workspaceKey === right.workspaceKey
  );
}

function sameFullRef(left: CuaSubmissionRef, right: CuaSubmissionRef): boolean {
  return sameRefIdentity(left, right) && left.authorizationRevision === right.authorizationRevision;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}
