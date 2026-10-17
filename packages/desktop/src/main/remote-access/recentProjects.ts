import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import type {
  WebRemoteControlDesktopWindowState,
  WebRemoteControlRecentProjectTarget,
  WebRemoteControlRecentProjectsResult,
} from "@zcode/shared";

/**
 * 最近项目投影（T2.4）。
 *
 * 事实源是 `AppSettings.recentProjects`（最近打开的路径，最近优先）。这里给每个路径分配一个
 * 只在本次进程会话内有效的随机 id：id 不携带路径，手机端只能回传当前列表里出现过的 id，
 * 不能自行构造任意路径。映射只保存在内存里，进程重启后全部失效。
 */
export interface BuildWebRemoteControlRecentProjectsOptions {
  paths: readonly string[];
  /** 已打开项目：不出现在最近项目列表里，也不接受它们的 id。 */
  openWorkspacePaths: ReadonlySet<string>;
  desktopWindowState: WebRemoteControlDesktopWindowState;
}

export interface WebRemoteControlRecentProjectsRegistry {
  /** 按当前设置与已打开列表生成快照；同时把本次快照里的 id 更新为唯一可接受的集合。 */
  buildResult(
    options: BuildWebRemoteControlRecentProjectsOptions,
  ): WebRemoteControlRecentProjectsResult;
  /** 只解析最近一次 buildResult 里出现过的 id；不在当前列表里的 id 一律返回 undefined。 */
  resolvePath(recentProjectId: string): string | undefined;
}

export function createWebRemoteControlRecentProjectsRegistry(): WebRemoteControlRecentProjectsRegistry {
  /** 路径 → 会话内 id；路径仍在设置里时保持 id 稳定。 */
  const idByPath = new Map<string, string>();
  /** 最近一次下发给手机的 id 集合。 */
  let pathById = new Map<string, string>();

  return {
    buildResult({ paths, openWorkspacePaths, desktopWindowState }) {
      const settingsPaths = new Set(paths);
      for (const knownPath of idByPath.keys()) {
        // 设置里已经移除的路径不再分配 id，避免旧 id 永久有效。
        if (!settingsPaths.has(knownPath)) {
          idByPath.delete(knownPath);
        }
      }

      const seenPaths = new Set<string>();
      const recentProjects: WebRemoteControlRecentProjectTarget[] = [];
      const nextPathById = new Map<string, string>();

      for (const workspacePath of paths) {
        // 空路径来自损坏的设置；既不能展示，也不能作为打开目标。
        if (!workspacePath.trim()) {
          continue;
        }
        // recentProjects 可能存在重复项；已打开的项目不进列表。
        if (seenPaths.has(workspacePath) || openWorkspacePaths.has(workspacePath)) {
          continue;
        }
        seenPaths.add(workspacePath);

        let id = idByPath.get(workspacePath);
        if (!id) {
          id = randomUUID();
          idByPath.set(workspacePath, id);
        }
        nextPathById.set(id, workspacePath);
        recentProjects.push({
          id,
          label: basename(workspacePath) || workspacePath,
          location: dirname(workspacePath),
        });
      }

      pathById = nextPathById;
      return { desktopWindowState, recentProjects };
    },

    resolvePath(recentProjectId) {
      return pathById.get(recentProjectId);
    },
  };
}
