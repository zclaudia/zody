// Session residency 收尾 lease 的纯工具段。
//
// 拆分原因：v4 原生协议层（zcode-protocol-v4/，08-phasing M4「无桥」禁令）只依赖
// 这三个无旧协议耦合的 lease 工具；原实现与 session-resident-pool/server-types 同文件，
// 迫使 v4 handler import 旧协议目录（zcode-protocol/）而触碰边界禁令。
// 拆出后 v4 引用本模块，旧协议目录经由 session-residency.ts re-export 保持原引用不变。

export interface SessionResidencyFinalizationOwner {
  residencyFinalizationCount?: number;
}

/**
 * residency lease 只覆盖 Bootstrap detached runner 的收尾窗口，避免 pool 回收仍在使用的
 * record。Prompt admission 的 busy/idle authority 已归 Core；activeAbortController 仅是旧命令
 * 路径的兼容取消句柄，不能再作为 prompt 调度锁。
 */
export function acquireSessionResidencyFinalization(
  record: SessionResidencyFinalizationOwner,
): () => void {
  record.residencyFinalizationCount = (record.residencyFinalizationCount ?? 0) + 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.residencyFinalizationCount = Math.max(0, (record.residencyFinalizationCount ?? 1) - 1);
  };
}

/** 同步登记 lease，再启动 detached runner；同步抛错和异步终态都保证释放。 */
export function runWithSessionResidencyFinalization<T>(
  record: SessionResidencyFinalizationOwner,
  run: () => Promise<T>,
): Promise<T> {
  const release = acquireSessionResidencyFinalization(record);
  try {
    return run().finally(release);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
}
