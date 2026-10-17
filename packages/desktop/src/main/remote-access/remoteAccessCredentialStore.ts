import type { ICredentialService } from "@zcode/services";

/**
 * 桌面 remote access（gateway backend）凭证的唯一存储 key。
 *
 * 值是 gateway 管理员签发的 `zgb_`（或换票后的 `zga_`），只经 Main 读写；
 * 它不进 settings 文件、不进日志，renderer 只能通过
 * `RemoteAccessCredentialStore.getStatus()` 读到「是否已配置」。
 */
export const REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY =
  "remote-access:gateway:backend-credential";

/** `zgb_` 是签发时的 backend 凭证，`zga_` 是 zgb_ 换票后的短期访问凭证。 */
const REMOTE_ACCESS_BACKEND_CREDENTIAL_PREFIXES = ["zgb_", "zga_"] as const;

/** renderer 可见的凭证状态；只有布尔值，没有凭证本身。 */
export interface RemoteAccessCredentialStatus {
  configured: boolean;
}

export interface RemoteAccessCredentialStore {
  /** Main 内部使用：读取凭证用于建连，不返回给 renderer。 */
  load(): Promise<string | undefined>;
  save(credential: string): Promise<void>;
  clear(): Promise<void>;
  /** renderer 可见的状态查询。 */
  getStatus(): Promise<RemoteAccessCredentialStatus>;
}

interface RemoteAccessCredentialStoreDependencies {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

function normalizeCredential(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isBackendCredentialFormat(credential: string): boolean {
  return REMOTE_ACCESS_BACKEND_CREDENTIAL_PREFIXES.some((prefix) => credential.startsWith(prefix));
}

export function createRemoteAccessCredentialStore({
  credentialService,
  logger,
}: RemoteAccessCredentialStoreDependencies): RemoteAccessCredentialStore {
  const load = async () =>
    normalizeCredential(await credentialService.load(REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY));

  return {
    load,

    async save(credential: string): Promise<void> {
      const normalized = normalizeCredential(credential);
      // 写入即校验：设置页把 `zgd_`（手机设备凭证）或 admin token 粘进来是最容易发生的配置错误，
      // 等到握手被拒才发现会把问题推迟到运行期；这里只报错误类型，不记录凭证内容。
      if (!normalized || !isBackendCredentialFormat(normalized)) {
        logger?.warn("[remote-access] gateway backend credential rejected", {
          reason: normalized ? "invalid-format" : "empty",
        });
        throw new Error("Remote access gateway backend credential must be a zgb_ or zga_ token");
      }
      await credentialService.save(REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY, normalized);
      logger?.info("[remote-access] gateway backend credential saved", { configured: true });
    },

    async clear(): Promise<void> {
      await credentialService.delete(REMOTE_ACCESS_GATEWAY_BACKEND_CREDENTIAL_KEY);
      logger?.info("[remote-access] gateway backend credential cleared", { configured: false });
    },

    async getStatus(): Promise<RemoteAccessCredentialStatus> {
      return { configured: (await load()) !== undefined };
    },
  };
}
