import {
  BUILTIN_PROVIDER_TEMPLATE_IDS,
} from "./model-provider-types.js";
import { normalizeOfficialGlmModelId } from "./official-glm-model-id.js";

// 不凭用户自定义 Provider 的名字猜所属站点；闲时 Ticket 的绑定身份也不能改。
export function migrateLegacyOfficialGlmModelId(providerId: string, modelId: string): string {
  return /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/.test(
    providerId,
  )
    ? normalizeOfficialGlmModelId(modelId)
    : modelId;
}

/**
 * 仅供已发布旧数据的单向升级使用，不是运行时 Provider 别名或选择兜底。
 * 依赖当前账号解释旧 Coding Plan 会使离线/SSH 迁移丢失原意图。
 * 同域 Individual 仅是确定性迁移落点，当前账号对应留给有效选择解析，不能据此绑定执行。
 * 迁移不查模型/档位是否可用；普通未知 ID 不构成旧格式证据。
 */
export function migrateLegacyModelProviderId(providerId: string): string | undefined {
  switch (providerId) {
    case "builtin:bigmodel":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
    case "builtin:zai":
      return BUILTIN_PROVIDER_TEMPLATE_IDS.zai;
    // fork（F4.11）：账号 Provider（account:zai|bigmodel-*）已从运行时删除；这里保留
    // F4.1a 发布的旧身份落点字面量，只用于存储迁移管线（随后由 Host 启动的
    // officialAccountDataMigration 清空 account:* 选择），不作为可解析的 Provider 身份。
    case "builtin:bigmodel-start-plan":
      return "account:bigmodel-start-plan";
    case "builtin:zai-start-plan":
      return "account:zai-start-plan";
    case "builtin:bigmodel-coding-plan":
      return "account:bigmodel-individual-coding-plan";
    case "builtin:zai-coding-plan":
      return "account:zai-individual-coding-plan";
    default:
      return providerId.startsWith("builtin:") ? undefined : providerId;
  }
}
