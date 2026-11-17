import type { ComputerUseRuntime } from "@zody/zody-cua";
export interface CuaCaptureTarget {
  readonly pid: number;
  readonly windowId: number;
}
/** 与 app 侧 captureCuaOnce 相同的可信 turn 关联；只核对，不生成授权。 */
export interface CuaCaptureExpectation {
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly turnId: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
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
    options: {
      readonly signal?: AbortSignal;
      readonly expected: CuaCaptureExpectation;
    },
  ): Promise<CuaCaptureImageResult>;
}
/**
 * 显式候选 composition：把真实 captureCuaOnce 接到现有 node_repl broker 的
 * `runtime.execute` 上。只接受明确的 `screenshot` 方法；其余 CUA 工具保持 unavailable，
 * 不伪造本工具链未执行的动作或结果。这里不创建 authority、capability 或 live admission，
 * broker 仍复用原有 main→cell capability 与 stop/revoke 链。
 */
export declare function createCuaCaptureComputerUseRuntime(
  options: CuaCaptureComputerUseRuntimeOptions,
): ComputerUseRuntime;
//# sourceMappingURL=cua-capture-runtime.d.ts.map
