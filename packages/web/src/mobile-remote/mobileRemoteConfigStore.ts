import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  tryNormalizeRemoteAccessGatewayUrl,
  type PlatformSecureStore,
} from "@zody/shared";
import { MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE } from "./mobileRemoteSecureStore.js";

/**
 * 手机端 gateway 配置的唯一持久化入口（T4.2）。
 *
 * 方案「状态归属」：gateway 地址、namespace、设备凭证（`zgd_`）和所选电脑都属于手机本地配置，
 * 由 Shell 的 `MobileShellConfigClient`（生产 = 原生 `ZodyShellBridge`）保存；本 store 只保留
 * 给 Shell 的开发降级路径（M2-T1）。
 *
 * M2-T2 起 Remote 不再使用本 store：它只从 `ZodyRemoteBridge.getSessionContext()` 读取会话。
 * `clientInstanceId` 由 Android 原生配置 store 按 backendId 生成并持久化，页面不生成、不读写。
 *
 * 这里不缓存任何内存副本：设置页保存后由调用方重新读取，避免出现第二条状态源。
 */

export const MOBILE_REMOTE_CONFIG_STORAGE_KEY = "config";

/** 设备凭证前缀；gateway 管理员签发给手机的设备凭证。 */
export const MOBILE_REMOTE_DEVICE_CREDENTIAL_PREFIX = "zgd_";

export interface MobileRemoteGatewayConfig {
  gatewayUrl: string;
  namespace: string;
  credential: string;
  /** 选中的电脑；未选择时为空。 */
  backendId?: string;
}

export interface MobileRemoteConfigValidationOptions {
  /** 本地开发允许 http；release 构建要求 https。 */
  allowInsecureTransport: boolean;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * 校验并归一化一份手机配置。
 * 返回 `undefined` 表示不可用 —— 读存储时按「未配置」处理，设置页提交时转成表单错误。
 */
export function parseMobileRemoteGatewayConfig(
  value: unknown,
  options: MobileRemoteConfigValidationOptions,
): MobileRemoteGatewayConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const rawGatewayUrl = readString(candidate.gatewayUrl);
  const rawCredential = readString(candidate.credential);
  if (!rawGatewayUrl || !rawCredential) {
    return undefined;
  }
  if (!rawCredential.startsWith(MOBILE_REMOTE_DEVICE_CREDENTIAL_PREFIX)) {
    return undefined;
  }
  const endpoint = tryNormalizeRemoteAccessGatewayUrl(rawGatewayUrl, {
    allowInsecureTransport: options.allowInsecureTransport,
  });
  if (!endpoint) {
    return undefined;
  }
  const backendId = readString(candidate.backendId);
  return {
    gatewayUrl: endpoint.baseUrl,
    namespace: readString(candidate.namespace) ?? DEFAULT_REMOTE_ACCESS_NAMESPACE,
    credential: rawCredential,
    ...(backendId ? { backendId } : {}),
  };
}

/** 设置页提交时的同步校验；失败原因直接展示给用户。 */
export function validateMobileRemoteGatewayConfig(
  value: unknown,
  options: MobileRemoteConfigValidationOptions,
): MobileRemoteGatewayConfig {
  const candidate = value as Record<string, unknown> | null | undefined;
  const rawGatewayUrl = readString(candidate?.gatewayUrl);
  const rawCredential = readString(candidate?.credential);
  const endpoint = rawGatewayUrl
    ? tryNormalizeRemoteAccessGatewayUrl(rawGatewayUrl, {
        allowInsecureTransport: options.allowInsecureTransport,
      })
    : undefined;
  if (!endpoint) {
    throw new Error(
      options.allowInsecureTransport
        ? "Gateway address must be an absolute http(s) URL."
        : "Gateway address must be an absolute https URL.",
    );
  }
  if (!rawCredential || !rawCredential.startsWith(MOBILE_REMOTE_DEVICE_CREDENTIAL_PREFIX)) {
    throw new Error(`Device credential must start with ${MOBILE_REMOTE_DEVICE_CREDENTIAL_PREFIX}.`);
  }
  const backendId = readString(candidate?.backendId);
  return {
    gatewayUrl: endpoint.baseUrl,
    namespace: readString(candidate?.namespace) ?? DEFAULT_REMOTE_ACCESS_NAMESPACE,
    credential: rawCredential,
    ...(backendId ? { backendId } : {}),
  };
}

/** 配置存储；`secureStore` 缺失时读取按未配置处理，写入明确失败。 */
export class MobileRemoteConfigStore {
  constructor(
    private readonly secureStore: PlatformSecureStore | undefined,
    private readonly validation: MobileRemoteConfigValidationOptions,
  ) {}

  async load(): Promise<MobileRemoteGatewayConfig | null> {
    if (!this.secureStore) {
      return null;
    }
    const raw = await this.secureStore.get(MOBILE_REMOTE_CONFIG_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return parseMobileRemoteGatewayConfig(JSON.parse(raw), this.validation) ?? null;
    } catch {
      // 存储损坏按未配置处理，让用户重新填写，而不是让首屏卡在解析错误。
      return null;
    }
  }

  async save(config: MobileRemoteGatewayConfig): Promise<void> {
    if (!this.secureStore) {
      throw new Error(MOBILE_REMOTE_SECURE_STORE_UNAVAILABLE_MESSAGE);
    }
    const normalized = validateMobileRemoteGatewayConfig(config, this.validation);
    await this.secureStore.set(MOBILE_REMOTE_CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  }

  async clear(): Promise<void> {
    if (!this.secureStore) {
      return;
    }
    await this.secureStore.remove(MOBILE_REMOTE_CONFIG_STORAGE_KEY);
  }
}
