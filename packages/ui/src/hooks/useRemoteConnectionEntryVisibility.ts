import type { ZCodeEnv } from "@zcode/shared";

// 随包运行时已接入本地上传；目标类型由 useRemoteConnectionForm 限定为 SSH/Windows WSL。
export const REMOTE_CONNECTION_CREATION_ENABLED = true;

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
