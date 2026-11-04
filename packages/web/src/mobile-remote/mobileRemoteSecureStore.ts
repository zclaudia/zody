import {
  MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
  type PlatformSecureStore,
} from "@zcode/shared";

/**
 * Shell 浏览器开发模式的本地配置存储。
 *
 * 新版 APK 的连接配置、设备凭证和所选电脑由原生 `ZodyShellBridge` /
 * `MobileShellConfigStore` 唯一持有；Remote 只从 `ZodyRemoteBridge.getSessionContext()`
 * 读取会话。页面不再发现或写入旧 `ZcodeMobileBridge`，所以这里只保留
 * `pnpm dev:mobile-remote` / 普通浏览器所需的 localStorage 降级。
 *
 * `createMobileRemoteSecureStore` 用 `import.meta.env.PROD` 做静态分支：生产 bundle 只保留
 * fail-closed 实现，`localStorage` 降级路径不会进入产物（验收第 11 条）。
 */

export { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE };

export interface CreateMobileRemoteSecureStoreOptions {
  /** 注入点，默认取 `globalThis.localStorage`；隐私模式可能抛错。仅开发实现使用。 */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** 存储 key 前缀，避免与普通 Web 客户端的 localStorage 键冲突。仅开发实现使用。 */
  storagePrefix?: string;
}

/** 开发降级存储的统一前缀；Shell handoff 与 Remote 开发桥必须读同一命名空间。 */
export const MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX = "zody-mobile-remote:";
const DEFAULT_STORAGE_PREFIX = MOBILE_REMOTE_DEVELOPMENT_STORAGE_PREFIX;

/**
 * 生产/发布构建使用的实现：没有原生页面存储桥，写入明确失败，读取按未配置处理。
 * 这里没有 localStorage 分支，避免 `zgd_` 明文落进浏览器存储。
 */
export function createUnavailableMobileRemoteSecureStore(): PlatformSecureStore {
  return {
    async get() {
      return null;
    },
    async set() {
      throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
    },
    async remove() {
      throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
    },
  };
}

function resolveStorage(
  storage: CreateMobileRemoteSecureStoreOptions["storage"],
): Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined {
  if (storage) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** 开发模式实现：只使用 namespaced localStorage。 */
export function createDevelopmentMobileRemoteSecureStore(
  options: CreateMobileRemoteSecureStoreOptions = {},
): PlatformSecureStore {
  const prefix = options.storagePrefix ?? DEFAULT_STORAGE_PREFIX;
  const storage = resolveStorage(options.storage);

  return {
    async get(key) {
      try {
        return storage?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (!storage) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      storage.setItem(prefix + key, value);
    },
    async remove(key) {
      if (!storage) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      storage.removeItem(prefix + key);
    },
  };
}

/**
 * 默认入口：生产构建 fail closed，开发构建走 localStorage 降级。
 * `import.meta.env.PROD` 在 Vite 构建期被替换为常量，生产产物不会包含开发实现。
 */
export function createMobileRemoteSecureStore(
  options: CreateMobileRemoteSecureStoreOptions = {},
): PlatformSecureStore {
  if (import.meta.env.PROD) {
    return createUnavailableMobileRemoteSecureStore();
  }
  return createDevelopmentMobileRemoteSecureStore(options);
}
