import type {
  ExtensionCredentialStore,
  ExtensionGenerationStore,
  ExtensionStoredCredential,
} from "./types.js";

/** P0 默认内存实现；P1/P3 的持久化实现必须保持同一接口和单调递增语义。 */
export function createInMemoryExtensionCredentialStore(): ExtensionCredentialStore {
  const credentials = new Map<string, ExtensionStoredCredential>();
  return {
    async get(profileInstanceId: string) {
      return credentials.get(profileInstanceId) ?? null;
    },
    async set(credential: ExtensionStoredCredential) {
      credentials.set(credential.profileInstanceId, { ...credential });
    },
    async delete(profileInstanceId: string) {
      credentials.delete(profileInstanceId);
    },
    async list() {
      return [...credentials.values()].map((credential) => ({ ...credential }));
    },
  };
}

/**
 * generation 只增不减。P0 内存实现从 1 开始；持久化实现必须在 Desktop 用户数据中
 * 按 profileInstanceId 保存最后一个值，不能每次进程启动从 0 重新计数。
 */
export function createInMemoryExtensionGenerationStore(): ExtensionGenerationStore {
  const generations = new Map<string, number>();
  return {
    async next(profileInstanceId: string) {
      const next = (generations.get(profileInstanceId) ?? 0) + 1;
      generations.set(profileInstanceId, next);
      return next;
    },
  };
}
