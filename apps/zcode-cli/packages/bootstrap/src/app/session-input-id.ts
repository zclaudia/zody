/**
 * CLI admission 的 canonical queue item id 唯一格式。
 *
 * V4 CommandInbox（`queue_<commandId>`）与普通 CLI 提交边界（`queue_<sourceCommandId>`）
 * 共用该构造，避免两处前缀漂移后 session_input 账本与 canonical intent 对不上。
 */
export function queueItemIdForSubmission(sourceCommandId: string): string {
  return `queue_${sourceCommandId}`;
}
