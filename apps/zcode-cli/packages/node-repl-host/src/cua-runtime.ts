import { createComputerUseRuntime, type ComputerUseRuntime } from "@zcode/zcode-cua";

/**
 * MCP launcher 会在 main() 返回前恢复并清理 Helper 凭据；必须在同一生命周期内先捕获，
 * 否则 serveStdio 的延迟 factory 只能看到空环境。这里只读 socket/refresh marker，
 * 不把 Helper token 暴露给 Worker 或 cell。
 */
export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  const socketPath = env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim();
  if (!socketPath) return undefined;
  return createComputerUseRuntime({
    brokerSocketPath: socketPath,
    refreshMarkerPath: env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim(),
  });
}
