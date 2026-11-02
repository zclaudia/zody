import type { AgentRuntime } from "@zody/core";
import {
  createCuaNativeAuthoritySession,
  type CuaNativeAuthoritySession,
  type CuaNativeAuthoritySessionOptions,
} from "@zody/adapters/mcp";

/** 可信 composition 显式传入的 stream/上限；scope 只能由 runtime 提供。 */
export type CuaNativeAuthorityCompositionOptions = Omit<
  CuaNativeAuthoritySessionOptions,
  "scope"
>;

/**
 * 显式可信内部入口：只在调用时从本 app.runtime 取真实 turn scope，再交给既有
 * native authority 窄会话。缺显式 Duplex 参数或真实 scope 时拒绝；这里只检查参数
 * 形状，不认证 peer。可信 launcher 与 peer 验证由装配方负责，不能由本入口推导。
 * 不读取 env/argv，不启动进程，不挂公开协议/模型工具，也不改 placeholder。
 */
export function createCuaRuntimeNativeAuthoritySession(
  runtime: AgentRuntime,
  options: CuaNativeAuthorityCompositionOptions | undefined,
): CuaNativeAuthoritySession | undefined {
  if (options === null || typeof options !== "object") return undefined;
  if (options.stream === null || typeof options.stream !== "object") return undefined;
  if (typeof options.stream.on !== "function") return undefined;
  if (typeof options.producerIncarnation !== "string" || options.producerIncarnation.trim() === "") {
    return undefined;
  }
  const scope = runtime.createCuaSubmissionTurnScope();
  if (!scope) return undefined;
  return createCuaNativeAuthoritySession({ ...options, scope });
}
