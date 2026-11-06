/**
 * ZCode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useZodySessionStore, selectWorkspaceZodyState } from "../store/zodySessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useZodySessionStore(
    (state) => selectWorkspaceZodyState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
