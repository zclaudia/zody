export const REQUEST_VERIFICATION_REJECTED_MESSAGE = "";
export function resolveRequestVerificationBusinessCode(
  _code: string | undefined,
  _message: string | undefined,
): "3007" | undefined {
  return undefined;
}
export function isRequestVerificationTerminalError(
  _error: { code?: string; message?: string } | null | undefined,
): boolean {
  return false;
}
export function isRequestVerificationRejectedMessage(_message: string | undefined): boolean {
  return false;
}
export const requestVerificationRecoveryAction = null;
export type RequestVerificationRecoveryAction = never;
export const requestVerificationActionMessages = {};
export const requestVerificationErrorAttribution = {};
// fork（F4.4）：requestVerificationClaimFailureMessageId（营销手动领取失败文案 id）与
// additionalRequestModalSelectors（营销二次请求弹窗选择器，消费者为 marketingPopupAdapter）
// 均随营销链路删除。
