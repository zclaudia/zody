import type { IServiceAccessor } from "@zcode/services";
import type { ProviderFamilyConnectionSelection } from "@zcode/shared";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";

/**
 * fork（F4.5）：官方 Coding Plan / Start Plan 权益与企业 pricing 已删除，
 * 账号连接失效后不再存在可切换的官方套餐目标。保留入口供 F4.7 统一删除；
 * 这里恒返回 null（只提示状态，不提供替代连接）。
 */
export interface AccountConnectionSwitchSuggestion {
  selection: ProviderFamilyConnectionSelection;
  label?: string;
  apply(): Promise<"switched" | "stale">;
}

export async function prepareAccountConnectionSwitch(
  _services: IServiceAccessor,
  _event: AccountConnectionLoss,
): Promise<AccountConnectionSwitchSuggestion | null> {
  return null;
}
