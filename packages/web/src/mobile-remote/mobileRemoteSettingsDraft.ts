import { DEFAULT_REMOTE_ACCESS_NAMESPACE } from "@zcode/shared";
import type { WebRemoteControlMobileSettingsDraft } from "@zcode/ui";
import {
  validateMobileRemoteGatewayConfig,
  type MobileRemoteGatewayConfig,
} from "./mobileRemoteConfigStore.js";

/**
 * 手机连接设置草稿的统一校验/保存路径。
 *
 * 首次配置（`mobileRemoteSetup.tsx` 的独立设置页）和已连接会话内的 SettingsPage
 * “连接”分区（`WebRemoteControlMobileConnectionSettingsSection` 经 bootstrap 注入的
 * `save`）必须共用这里，不能各自再写一份 scopeChanged / store.save，否则两条路径会
 * 得到不同的 backendId 保留与重连判定。
 * 配置的唯一写入方仍是 `MobileRemoteConfigStore`，本模块不持有任何状态。
 */

export interface MobileRemoteSettingsDraftInput {
  /** 当前已保存配置；首次配置时为 null。 */
  initial: MobileRemoteGatewayConfig | null;
  draft: WebRemoteControlMobileSettingsDraft;
  allowInsecureTransport: boolean;
}

export interface MobileRemoteSettingsDraftResult {
  /** 校验并归一化后的待保存配置。 */
  config: MobileRemoteGatewayConfig;
  /**
   * 草稿是否改变连接作用域（gateway / namespace / 重新输入凭证）。
   * 作用域变化时不能沿用旧 backendId：原电脑可能已不在新 scope 内。
   */
  scopeChanged: boolean;
}

function normalizeGatewayUrlForCompare(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * 只做校验与判定，不写存储；保存成功后的调用方据此决定是否关闭浮层 / 重建会话。
 * 判定规则与抽取前 `mobileRemoteSetup.renderSettingsPage` 完全一致。
 */
function resolveMobileRemoteSettingsDraft({
  initial,
  draft,
  allowInsecureTransport,
}: MobileRemoteSettingsDraftInput): MobileRemoteSettingsDraftResult {
  const initialGatewayUrl = initial?.gatewayUrl?.trim();
  const initialNamespace = initial?.namespace;
  const scopeChanged =
    Boolean(draft.credential) ||
    normalizeGatewayUrlForCompare(draft.gatewayUrl) !==
      normalizeGatewayUrlForCompare(initialGatewayUrl) ||
    (draft.namespace.trim() || DEFAULT_REMOTE_ACCESS_NAMESPACE) !==
      (initialNamespace ?? DEFAULT_REMOTE_ACCESS_NAMESPACE);
  const config = validateMobileRemoteGatewayConfig(
    {
      gatewayUrl: draft.gatewayUrl,
      namespace: draft.namespace,
      credential: draft.credential || initial?.credential,
      ...(scopeChanged ? {} : initial?.backendId ? { backendId: initial.backendId } : {}),
    },
    { allowInsecureTransport },
  );
  return { config, scopeChanged };
}

/** 校验草稿并写入唯一配置 store；失败（含 secure store 不可用）原样抛给表单展示。 */
export async function saveMobileRemoteSettingsDraft(
  input: MobileRemoteSettingsDraftInput & {
    store: { save(config: MobileRemoteGatewayConfig): Promise<void> };
  },
): Promise<MobileRemoteSettingsDraftResult> {
  const result = resolveMobileRemoteSettingsDraft(input);
  await input.store.save(result.config);
  return result;
}
