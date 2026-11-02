import type { AgentRuntime } from "@zcode/core";
import {
  createRuntimeCuaSubmissionControlSession,
  type CuaSubmissionControlSession,
  type RuntimeCuaSubmissionControlOptions,
} from "@zcode/adapters/mcp";

/** 可信 composition 显式传入的 launcher 配置；不来自模型、协议或环境变量。 */
export type CuaControlSessionOptions = RuntimeCuaSubmissionControlOptions;

/**
 * 显式可信内部入口：只从本 app.runtime 取得真实 turn scope，并把同一 scope 交给
 * 既有 adapter control-only launcher。没有 scope、没有显式 launch 配置时拒绝；
 * 本函数只在调用时取 runtime，不绑定启动期 IO，也不挂公开协议/模型工具。
 */
export function createCuaRuntimeControlSession(
  runtime: AgentRuntime,
  options: CuaControlSessionOptions | undefined,
): CuaSubmissionControlSession | undefined {
  if (options === null || typeof options !== "object") return undefined;
  if (options.launch === null || typeof options.launch !== "object") return undefined;
  const scope = runtime.createCuaSubmissionTurnScope();
  if (!scope) return undefined;
  return createRuntimeCuaSubmissionControlSession(scope, options);
}
