// In-process serialization of plugin storage mutations (install/update/uninstall/
// restore). The desktop talks to a single app-server process, so a per-storageRoot
// promise chain is sufficient to prevent interleaved read-modify-write on
// installed_plugins.json / cache dirs / user config. Cross-process locking is a
// non-goal for this iteration.
//
// I06：读投影与写操作分属两条调度路径。缓存命中的读不获取这把写闸门，也不获取
// 跨进程 seed 锁；只有确实缺失的 lazy 初始化写才进入对应的锁：缺失 manifest 的
// 物化走写闸门，缺失的官方 cache seed 走跨进程 seed 锁。锁序固定为
// 「进程内写闸门 → 跨进程 seed 锁」，已持闸门的调用必须复用无锁核心，禁止对同一
// storageRoot 再次获取闸门。
const chains = new Map<string, Promise<unknown>>();

export async function withPluginStorageLock<T>(
  storageRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(storageRoot) ?? Promise.resolve();
  // Chain regardless of previous outcome; swallow prior errors for the gate only.
  const gate = previous.then(
    () => undefined,
    () => undefined,
  );
  const run = gate.then(() => operation());
  // Keep the chain alive but never let a rejection break future gating.
  chains.set(
    storageRoot,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * I06：读投影只在确实需要 lazy 写时进入写闸门。
 *
 * `needsWrite` 必须是只读的已提交状态判定；返回 false 时直接执行操作，不排队到
 * 安装/下载等无关写之后。进入闸门后仍由被调用方（ensure* 物化逻辑）复查状态，
 * 避免等待期间状态已被其他写者提交时重复写。
 */
export async function withPluginStorageWriteGateWhenNeeded<T>(
  storageRoot: string,
  needsWrite: () => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (!needsWrite()) return operation();
  return withPluginStorageLock(storageRoot, operation);
}
