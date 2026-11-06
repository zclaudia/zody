import type { MobileSessionContext } from "@zody/shared";
import { MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX } from "./mobileRemoteSecureStore.js";

export { MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX };

/**
 * Shell → Remote 的开发期 handoff（M2-T2）。
 *
 * 生产环境里 `MobileShellController` 在导航前创建 sessionId 并安装 `ZodyRemoteBridge`；
 * 浏览器开发模式没有原生桥，因此由 Shell 开发配置客户端在 `openRemote` 时写入一次性
 * handoff，Remote 的开发桥再把它模拟成 `getSessionContext()`。
 *
 * 边界：
 * - handoff 只在开发构建存在；release 入口没有原生桥时直接 fail closed。
 * - `clientInstanceId` 由 Shell 开发配置客户端按 backendId 生成并持久化（本模块只提供
 *   同步存储读写），Remote 不生成、不写回。
 * - 凭证仍只放在当前浏览器 localStorage（Shell 开发配置本来就这样）；URL 不再携带凭证。
 * - handoff 在返回 Shell、重新保存配置或清除配置时删除，避免旧 backend 污染新会话。
 */

/** 浏览器开发模式的同步存储接口；与 dev secure store 共用命名空间前缀。 */
export interface MobileRemoteDevelopmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MOBILE_SHELL_DEVELOPMENT_REMOTE_HANDOFF_KEY = "remote-handoff";
export const MOBILE_SHELL_DEVELOPMENT_CLIENT_INSTANCE_ID_PREFIX = "client-instance-id:";

function storageKey(key: string): string {
  return `${MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX}${key}`;
}

/** 缺省使用 localStorage；隐私模式/Node 测试可能不可用，读取按空处理。 */
export function resolveMobileRemoteDevelopmentStorage(
  storage?: MobileRemoteDevelopmentStorage,
): MobileRemoteDevelopmentStorage | undefined {
  if (storage) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** 读取原始 handoff；损坏 JSON 返回 undefined，由调用方 fail closed。 */
export function readDevelopmentRemoteHandoff(storage?: MobileRemoteDevelopmentStorage): unknown {
  const raw = resolveMobileRemoteDevelopmentStorage(storage)?.getItem(
    storageKey(MOBILE_SHELL_DEVELOPMENT_REMOTE_HANDOFF_KEY),
  );
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Shell 开发客户端写入的只读会话上下文；Remote 开发桥按 shared schema 再校验。 */
export function writeDevelopmentRemoteHandoff(
  context: MobileSessionContext,
  storage?: MobileRemoteDevelopmentStorage,
): void {
  const resolved = resolveMobileRemoteDevelopmentStorage(storage);
  if (!resolved) {
    throw new Error("Development Remote handoff storage is unavailable.");
  }
  resolved.setItem(
    storageKey(MOBILE_SHELL_DEVELOPMENT_REMOTE_HANDOFF_KEY),
    JSON.stringify(context),
  );
}

export function clearDevelopmentRemoteHandoff(storage?: MobileRemoteDevelopmentStorage): void {
  resolveMobileRemoteDevelopmentStorage(storage)?.removeItem(
    storageKey(MOBILE_SHELL_DEVELOPMENT_REMOTE_HANDOFF_KEY),
  );
}

/**
 * 按 backendId 读取或生成稳定的 clientInstanceId（仅开发 Shell）。
 * 同一 backend 重连必须复用，换 backend 必须不同。
 */
export function allocateDevelopmentClientInstanceId(
  backendId: string,
  storage?: MobileRemoteDevelopmentStorage,
): string {
  const resolved = resolveMobileRemoteDevelopmentStorage(storage);
  if (!resolved) {
    throw new Error("Development client instance storage is unavailable.");
  }
  const key = storageKey(`${MOBILE_SHELL_DEVELOPMENT_CLIENT_INSTANCE_ID_PREFIX}${backendId}`);
  const existing = resolved.getItem(key);
  if (existing) {
    return existing;
  }
  const generated =
    globalThis.crypto?.randomUUID?.() ??
    `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  resolved.setItem(key, generated);
  return generated;
}
