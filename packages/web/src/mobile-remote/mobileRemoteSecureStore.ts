import {
  MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE,
  type PlatformSecureStore,
} from "@zcode/shared";

/**
 * 手机页面侧的安全存储实现（T4.2；Android 原生桥在 T6.2 接入）。
 *
 * 方案「状态归属」要求手机端 gateway 配置、设备凭证和所选电脑落在 Android 原生安全存储，
 * 页面只能经 `IPlatformService.secureStore` 访问。这里负责两件事：
 *
 * 1. 发现宿主注入的 `ZcodeMobileBridge.secureStore`（T6.2 的 `@JavascriptInterface`）；
 * 2. 只有开发模式（`pnpm dev:mobile-remote` / 普通浏览器）才允许降级到 localStorage。
 *    release 构建缺少原生桥时 `set/remove` 必须拒绝，避免 `zgd_` 明文落进浏览器存储。
 *
 * `createMobileRemoteSecureStore` 用 `import.meta.env.PROD` 做静态分支：生产 bundle 只会
 * 保留 native-only 实现，`localStorage` 降级路径不会进入产物（验收第 11 条）。
 */

export { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE };

/** Android `@JavascriptInterface` 的方法都是同步返回值，但保留 Promise 形态方便测试注入异步实现。 */
export interface MobileRemoteNativeSecureStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

export interface MobileRemoteNativeBridge {
  secureStore?: MobileRemoteNativeSecureStore;
  /*
   * Android `@JavascriptInterface` 注入的对象只能暴露平铺方法（T6.2）：
   * Kotlin 的 `ZcodeMobileBridge.secureStoreGet/secureStoreSet/secureStoreRemove`。
   * `resolveMobileRemoteNativeBridge` 会把它们归一化成 `secureStore.get/set/remove`，
   * 页面其余部分只依赖归一化后的形状。
   */
  secureStoreGet?(key: string): string | null;
  secureStoreSet?(key: string, value: string): void;
  secureStoreRemove?(key: string): void;
}

const NATIVE_BRIDGE_GLOBAL_KEY = "ZcodeMobileBridge";

function isNativeSecureStore(value: unknown): value is MobileRemoteNativeSecureStore {
  if (!value || typeof value !== "object") {
    return false;
  }
  const store = value as MobileRemoteNativeSecureStore;
  return (
    typeof store.get === "function" &&
    typeof store.set === "function" &&
    typeof store.remove === "function"
  );
}

/** 把 Kotlin 注入的平铺方法归一化成 `secureStore.get/set/remove`。 */
function resolveFlatNativeSecureStore(
  bridge: MobileRemoteNativeBridge,
): MobileRemoteNativeSecureStore | undefined {
  if (
    typeof bridge.secureStoreGet !== "function" ||
    typeof bridge.secureStoreSet !== "function" ||
    typeof bridge.secureStoreRemove !== "function"
  ) {
    return undefined;
  }
  return {
    // 保留 bridge 作为 receiver：WebView 注入的方法不依赖 this，但不要依赖这一点。
    get: (key) => bridge.secureStoreGet!(key),
    set: (key, value) => bridge.secureStoreSet!(key, value),
    remove: (key) => bridge.secureStoreRemove!(key),
  };
}

/** 读取宿主注入的原生桥；不存在或字段缺失时返回 undefined。 */
export function resolveMobileRemoteNativeBridge(
  target: unknown = globalThis,
): MobileRemoteNativeBridge | undefined {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  const bridge = (target as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL_KEY];
  if (!bridge || typeof bridge !== "object") {
    return undefined;
  }
  const candidate = bridge as MobileRemoteNativeBridge;
  const secureStore = isNativeSecureStore(candidate.secureStore)
    ? candidate.secureStore
    : resolveFlatNativeSecureStore(candidate);
  if (!secureStore) {
    return undefined;
  }
  return { secureStore };
}

export interface CreateMobileRemoteSecureStoreOptions {
  bridge?: MobileRemoteNativeBridge;
  /** 注入点，默认取 `globalThis.localStorage`；隐私模式可能抛错。仅开发实现使用。 */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** 存储 key 前缀，避免与普通 Web 客户端的 localStorage 键冲突。仅开发实现使用。 */
  storagePrefix?: string;
}

const DEFAULT_STORAGE_PREFIX = "zcode-mobile-remote:";

/**
 * 生产/发布构建使用的实现：只有原生桥。
 * 缺桥时读取按未配置处理，写入明确失败 —— 这里没有 localStorage 分支。
 */
export function createNativeMobileRemoteSecureStore(
  bridge?: MobileRemoteNativeBridge,
): PlatformSecureStore {
  const nativeStore = bridge?.secureStore;
  return {
    async get(key) {
      if (!nativeStore) {
        return null;
      }
      try {
        return (await nativeStore.get(key)) ?? null;
      } catch {
        // 原生读取失败按未配置处理；后续保存会显式报错。
        return null;
      }
    },
    async set(key, value) {
      if (!nativeStore) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      await nativeStore.set(key, value);
    },
    async remove(key) {
      if (!nativeStore) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      await nativeStore.remove(key);
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

/** 开发模式实现：原生桥优先，没有桥时降级到 localStorage。 */
export function createDevelopmentMobileRemoteSecureStore(
  options: CreateMobileRemoteSecureStoreOptions = {},
): PlatformSecureStore {
  const nativeStore = options.bridge?.secureStore;
  const prefix = options.storagePrefix ?? DEFAULT_STORAGE_PREFIX;
  const storage = resolveStorage(options.storage);

  return {
    async get(key) {
      if (nativeStore) {
        try {
          return (await nativeStore.get(key)) ?? null;
        } catch {
          return null;
        }
      }
      try {
        return storage?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (nativeStore) {
        await nativeStore.set(key, value);
        return;
      }
      if (!storage) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      storage.setItem(prefix + key, value);
    },
    async remove(key) {
      if (nativeStore) {
        await nativeStore.remove(key);
        return;
      }
      if (!storage) {
        throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
      }
      storage.removeItem(prefix + key);
    },
  };
}

/**
 * 默认入口：生产构建走 native-only，开发构建走 localStorage 降级。
 * `import.meta.env.PROD` 在 Vite 构建期被替换为常量，生产产物不会包含开发实现。
 */
export function createMobileRemoteSecureStore(
  options: CreateMobileRemoteSecureStoreOptions = {},
): PlatformSecureStore {
  if (import.meta.env.PROD) {
    return createNativeMobileRemoteSecureStore(options.bridge);
  }
  return createDevelopmentMobileRemoteSecureStore(options);
}
