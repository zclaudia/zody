import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@zcode/zcode-cua";

const DESKTOP_CONTINUOUS = "desktop-continuous";
const SCREENSHOT_METHOD = "screenshot";
const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/iu;

export interface CuaCaptureTarget {
  readonly pid: number;
  readonly windowId: number;
}

/** 与 app 侧 captureCuaOnce 相同的可信 turn 关联；只核对，不生成授权。 */
export interface CuaCaptureExpectation {
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly turnId: string;
}

export interface CuaCaptureImageResult {
  readonly content: Array<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

export interface CuaCaptureComputerUseRuntimeOptions {
  /**
   * 唯一截图能力。生产装配必须显式传入；默认 server 入口不构造、不读取 env。
   * expected 来自 cua-broker 已冻结的 main toolcall 上下文，模型 cell 无法覆盖。
   */
  captureOnce(
    target: CuaCaptureTarget,
    options: { readonly signal?: AbortSignal; readonly expected: CuaCaptureExpectation },
  ): Promise<CuaCaptureImageResult>;
}

/**
 * 显式候选 composition：把真实 captureCuaOnce 接到现有 node_repl broker 的
 * `runtime.execute` 上。只接受明确的 `screenshot` 方法；其余 CUA 工具保持 unavailable，
 * 不伪造本工具链未执行的动作或结果。这里不创建 authority、capability 或 live admission，
 * broker 仍复用原有 main→cell capability 与 stop/revoke 链。
 */
export function createCuaCaptureComputerUseRuntime(
  options: CuaCaptureComputerUseRuntimeOptions,
): ComputerUseRuntime {
  let disposed = false;
  // native launcher 每次截图使用一条 authority 连接；同进程重入必须直接拒绝而不是排队，
  // 否则旧调用会拖住新工具调用，或在 close flush 与下一轮之间换绑 scope。
  let active = false;

  return {
    async execute(input) {
      if (disposed) throw new Error("cua_capture_runtime_disposed");
      if (input.toolName !== SCREENSHOT_METHOD) {
        return unavailable(`cua_capture_tool_unavailable:${input.toolName}`);
      }
      const expected = readTrustedExpectation(input.context);
      if (!expected) throw new Error("cua_capture_untrusted_context");
      const target = readCaptureTarget(input.arguments);
      if (!target) throw new Error("cua_capture_target_required");
      if (input.signal?.aborted) throw abortError(input.signal.reason);
      if (active) throw new Error("cua_capture_busy");
      active = true;
      try {
        const result = await options.captureOnce(target, {
          ...(input.signal ? { signal: input.signal } : {}),
          expected,
        });
        return validateCaptureResult(result);
      } finally {
        active = false;
      }
    },
    // 正常截图 close 不撤销 owner；stop 仍走原 broker revoke → app owner 撤销链。
    async closeSession() {},
    async dispose() {
      disposed = true;
    },
  };
}

function readTrustedExpectation(
  context: ComputerUseRuntimeContext,
): CuaCaptureExpectation | undefined {
  if (context.runtimeScope !== "main") return undefined;
  if (context.clientMode !== DESKTOP_CONTINUOUS || context.deliveryKind !== DESKTOP_CONTINUOUS) {
    return undefined;
  }
  if (context.remoteSessionId) return undefined;
  const sessionId = trimNonEmpty(context.sessionId);
  const workspaceKey = trimNonEmpty(context.workspaceKey);
  const turnId = trimNonEmpty(context.turnId);
  if (!sessionId || !workspaceKey || !turnId) return undefined;
  return Object.freeze({ sessionId, workspaceKey, turnId });
}

function readCaptureTarget(value: unknown): CuaCaptureTarget | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["target"]))) return undefined;
  const target = value.target;
  if (!isRecord(target) || !hasOnlyKeys(target, new Set(["pid", "windowId"]))) return undefined;
  if (!isPositiveSafeInteger(target.pid) || !isPositiveSafeInteger(target.windowId)) {
    return undefined;
  }
  return Object.freeze({ pid: target.pid, windowId: target.windowId });
}

function validateCaptureResult(result: unknown): CuaCaptureImageResult {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("cua_capture_result_invalid");
  }
  if (result.isError === true) return result as unknown as CuaCaptureImageResult;
  const hasImage = result.content.some(
    (block) =>
      isRecord(block) &&
      block.type === "image" &&
      typeof block.data === "string" &&
      block.data.length > 0 &&
      typeof block.mimeType === "string" &&
      IMAGE_MIME.test(block.mimeType),
  );
  if (!hasImage) throw new Error("cua_capture_result_image_missing");
  return result as unknown as CuaCaptureImageResult;
}

function unavailable(message: string): CuaCaptureImageResult {
  return {
    content: [{ type: "text", text: `Computer Use is unavailable: ${message}` }],
    isError: true,
  };
}

function trimNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted", "AbortError");
}
