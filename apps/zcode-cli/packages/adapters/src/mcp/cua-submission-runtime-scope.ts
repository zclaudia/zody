import type { CuaSubmissionTurnScope } from "@zcode/contracts";
import {
  createCuaSubmissionControlSession,
  type CuaSubmissionControlSession,
  type CuaSubmissionControlSessionOptions,
} from "./cua-submission-control.js";

/**
 * 只接受可信 composition 传入的 launcher/超时配置。ref、traceId 与 producerPort
 * 全部来自 runtime 签发的 scope，调用方不能覆盖或另造。
 */
export type RuntimeCuaSubmissionControlOptions = Omit<
  CuaSubmissionControlSessionOptions,
  "ref" | "producerPort" | "traceId" | "beforeSpawn"
>;

/**
 * 把真实 runtime turn scope 接到既有 control-only launcher：
 * 1. 先订阅 scope 失效，再准备/启动本次唯一 control material；
 * 2. 用 createControlOnlyMaterial 的同一 producerIncarnation 调 bindProducer，失败不得 spawn；
 * 3. scope 驱动失效只关闭 consumer 并结束 binding，不制造 control-lost 撤销仍有效的 lineage。
 */
export function createRuntimeCuaSubmissionControlSession(
  scope: CuaSubmissionTurnScope,
  options: RuntimeCuaSubmissionControlOptions,
): CuaSubmissionControlSession {
  const session = createCuaSubmissionControlSession({
    ...options,
    ref: scope.ref,
    producerPort: scope.producerPort,
    traceId: scope.traceId,
    beforeSpawn: (binding) => scope.bindProducer(binding.producerIncarnation),
  });
  let unsubscribe: (() => void) | null = scope.onInvalidated((reason) => {
    session.onScopeInvalidated(reason);
  });
  let cleaning = false;
  return {
    traceId: session.traceId,
    onOwnerRevocation: session.onOwnerRevocation,
    onScopeInvalidated: session.onScopeInvalidated,
    start: () => session.start(),
    stop: () => session.stop(),
    cleanup: async () => {
      if (cleaning) {
        await session.cleanup();
        return;
      }
      cleaning = true;
      try {
        // consumer 正常收尾必须先按 scope normal-close 语义结束本次 binding，
        // 再让 base session 只关闭 child；不能留下仍存活的 turn scope。
        scope.close();
        await session.cleanup();
      } finally {
        unsubscribe?.();
        unsubscribe = null;
      }
    },
    diagnostics: () => session.diagnostics(),
  };
}
