import type { ZCodeEnv } from "@zcode/shared";

/**
 * fork（F6.1，决策门 D4a 方案 ii）：暂时隐藏 SSH/远程工作区的「部署/新建」入口。
 *
 * 原因：打包版不再随包携带远端运行时资源，fork 版本号在官方 CDN 上也没有对应制品，
 * 新建远程工作区会在部署阶段失败。仅摘除 UI 入口，不删除连接、部署与持久化类型/服务面，
 * 已有远程工作区仍按历史快照恢复并可重连；D4a 选择自建 CDN 后（F6.5）把本开关置回 true 即可恢复。
 */
export const REMOTE_CONNECTION_CREATION_ENABLED = false;

export function shouldShowRemoteConnectionEntry(params: {
  env: ZCodeEnv;
  isIntranet: boolean;
}): boolean {
  void params;
  return REMOTE_CONNECTION_CREATION_ENABLED;
}

export function useRemoteConnectionEntryVisibility(): boolean {
  // 该 hook 只控制“新建远程工作区”入口的可见性。
  // 已有远程工作区的恢复与重连能力不再复用本开关（见 useRemoteWorkspaceHistory），
  // 否则隐藏新建入口会一并禁用旧数据重连。
  return REMOTE_CONNECTION_CREATION_ENABLED;
}
