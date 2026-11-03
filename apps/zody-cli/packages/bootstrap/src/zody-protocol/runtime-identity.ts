import type { ZodyCuaLaunchIdentity } from "@zody/shared";

/**
 * 私有 stdio startup 身份只允许固定一次。同值重送是幂等 ACK，不同值必须失败关闭，
 * 防止同一 Agent 进程的 Host/runtime 身份被后续输入替换。
 */
export function pinCuaLaunchIdentity(
  current: ZodyCuaLaunchIdentity | undefined,
  next: ZodyCuaLaunchIdentity,
): { identity: ZodyCuaLaunchIdentity; reused: boolean } {
  if (!current) {
    return { identity: { ...next }, reused: false };
  }
  if (
    current.hostInstanceId === next.hostInstanceId &&
    current.runtimeInstanceId === next.runtimeInstanceId
  ) {
    return { identity: current, reused: true };
  }
  throw new Error("fault.startup.runtimeIdentityConflict");
}
