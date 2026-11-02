import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlTaskTarget,
  type WebRemoteControlWorkspaceTarget,
} from "@zody/shared";

/**
 * RemoteWorkspaceDirectory —— 各窗口 workspace 标签页与任务索引的只读投影（方案「状态归属」）。
 *
 * 事实源仍是各窗口 renderer 的 tabStore 和任务列表：renderer 在完成标签页恢复后，把本窗口的
 * 整份 workspace 目标和任务目标同步到 Main，这里按 `BrowserWindow.id` 保存每个窗口最近一次的
 * 快照（每次同步整体替换对应部分），再对外提供跨窗口聚合和 `resolveWindow(workspaceKey)`。
 * 目录只做投影，不推断、不合并增量，避免出现第二份业务事实。
 *
 * 不变量：id 空间统一为 `BrowserWindow.id`。renderer 同步到达的 id 就是它
 * （`desktopMainIpcPlatform.ts` 用 `BrowserWindow.fromWebContents(event.sender).id`），
 * `attachWorkspaceHost(windowId, …)` 与 `desktopRemoteSessions` 的窗口校验也都吃它；
 * `webContents.id` 只在 attach 内部做一次转换，目录不维护第二份映射，也不做任何 id 换算。
 */
export interface RemoteWorkspaceDirectorySnapshot {
  /** 快照所属窗口的 `BrowserWindow.id`，与同步时传入的值逐位相等。 */
  readonly windowId: number;
  /** 该窗口最近一次同步的 workspace 目标（整份替换）。 */
  readonly workspaces: readonly WebRemoteControlWorkspaceTarget[];
  /** 该窗口最近一次同步的任务目标（整份替换）。 */
  readonly tasks: readonly WebRemoteControlTaskTarget[];
}

interface RemoteWorkspaceDirectoryDependencies {
  /**
   * 当前聚焦窗口的 `BrowserWindow.id`；没有窗口聚焦时返回 undefined。
   * 同一个 workspaceKey 出现在多个窗口时，先优先选择有效连接的远程投影；候选连接状态相同，
   * 聚合与 `resolveWindow` 才按聚焦窗口优先，其次取最近同步的窗口。
   */
  getFocusedWindowId?: () => number | undefined;
}

export interface RemoteWorkspaceDirectory {
  /** 整份替换某个窗口的 workspace 快照；没有 runtime 的窗口也要记录，供聚合与路由读取。 */
  syncWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void;
  /** 整份替换某个窗口的任务快照。 */
  syncTasks(windowId: number, tasks: WebRemoteControlTaskTarget[]): void;
  /** 读取某个窗口最近一次的快照；从未同步过的窗口返回 undefined。 */
  getWindowSnapshot(windowId: number): RemoteWorkspaceDirectorySnapshot | undefined;
  /** 跨窗口聚合的 workspace 列表，按 `workspaceKey` 去重。 */
  listWorkspaces(): WebRemoteControlWorkspaceTarget[];
  /** 跨窗口聚合的任务列表，按 `workspaceKey + taskId` 去重。 */
  listTasks(): WebRemoteControlTaskTarget[];
  /** 按 `workspaceKey` 解析所属窗口：优先有效连接，再按聚焦窗口和最近同步顺序选择。 */
  resolveWindow(workspaceKey: string): number | undefined;
  /** 窗口关闭时删除该窗口的快照。 */
  removeWindow(windowId: number): void;
}

interface InternalWindowSnapshot {
  windowId: number;
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks: WebRemoteControlTaskTarget[];
  /** 单调递增的同步序号；「最近同步」按它判定，不用系统时钟，避免同毫秒并列。 */
  syncSequence: number;
}

export function createRemoteWorkspaceDirectory(
  dependencies: RemoteWorkspaceDirectoryDependencies = {},
): RemoteWorkspaceDirectory {
  const snapshots = new Map<number, InternalWindowSnapshot>();
  let syncSequence = 0;

  function getOrCreateSnapshot(windowId: number): InternalWindowSnapshot {
    const existing = snapshots.get(windowId);
    if (existing) {
      return existing;
    }
    const created: InternalWindowSnapshot = {
      windowId,
      workspaces: [],
      tasks: [],
      syncSequence: 0,
    };
    snapshots.set(windowId, created);
    return created;
  }

  /**
   * 按「聚焦窗口 → 最近同步」排序的窗口快照；有效连接优先级在聚合 workspace owner 时再比较。
   * 同一 key 出现在多个窗口时，`listWorkspaces` 与 `resolveWindow` 使用相同的选择规则。
   */
  function listSnapshotsByPreference(): InternalWindowSnapshot[] {
    const focusedWindowId = dependencies.getFocusedWindowId?.();
    return [...snapshots.values()].sort((left, right) => {
      if (left.windowId === right.windowId) {
        return 0;
      }
      if (left.windowId === focusedWindowId) {
        return -1;
      }
      if (right.windowId === focusedWindowId) {
        return 1;
      }
      return right.syncSequence - left.syncSequence;
    });
  }

  function workspaceProjectionPriority(workspace: WebRemoteControlWorkspaceTarget): number {
    if (workspace.kind !== "remote") {
      return 0;
    }
    // Bugfix：聚焦窗口可能只有旧 identity 的恢复占位 tab；它不能盖过仍连接的 owner Host 投影。
    // 显式断开/重连即使保留旧 session id 也不是健康 owner，不能据此伪装在线。
    if (
      workspace.connectionState === "disconnected" ||
      workspace.connectionState === "reconnecting"
    ) {
      return 0;
    }
    if (!workspace.remoteSessionId) {
      return 0;
    }
    return workspace.connectionState === "connected" ? 2 : 1;
  }

  function selectWorkspaceOwners(): Map<
    string,
    { windowId: number; workspace: WebRemoteControlWorkspaceTarget; priority: number }
  > {
    const owners = new Map<
      string,
      { windowId: number; workspace: WebRemoteControlWorkspaceTarget; priority: number }
    >();
    for (const snapshot of listSnapshotsByPreference()) {
      for (const workspace of snapshot.workspaces) {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        const priority = workspaceProjectionPriority(workspace);
        const current = owners.get(workspaceKey);
        if (!current || priority > current.priority) {
          owners.set(workspaceKey, { windowId: snapshot.windowId, workspace, priority });
        }
      }
    }
    return owners;
  }

  return {
    syncWorkspaces(windowId, workspaces) {
      const snapshot = getOrCreateSnapshot(windowId);
      // 整份替换：renderer 每次发的是本窗口当前完整的标签页集合，增量合并会留下已经关闭的 workspace。
      snapshot.workspaces = [...workspaces];
      snapshot.syncSequence = ++syncSequence;
    },

    syncTasks(windowId, tasks) {
      const snapshot = getOrCreateSnapshot(windowId);
      snapshot.tasks = [...tasks];
      snapshot.syncSequence = ++syncSequence;
    },

    getWindowSnapshot(windowId) {
      return snapshots.get(windowId);
    },

    listWorkspaces() {
      return [...selectWorkspaceOwners().values()].map(({ workspace }) => workspace);
    },

    listTasks() {
      const owners = selectWorkspaceOwners();
      const selectedTasks = new Map<
        string,
        { task: WebRemoteControlTaskTarget; matchesWorkspaceOwner: boolean }
      >();
      for (const snapshot of listSnapshotsByPreference()) {
        for (const task of snapshot.tasks) {
          // JSON tuple：workspaceKey 和 taskId 都是用户可见字符串，不能用控制字符拼接复合 key。
          const taskKey = JSON.stringify([resolveWebRemoteControlWorkspaceKey(task), task.taskId]);
          const owner = owners.get(resolveWebRemoteControlWorkspaceKey(task));
          const matchesWorkspaceOwner = !owner || owner.windowId === snapshot.windowId;
          const current = selectedTasks.get(taskKey);
          if (!current || (matchesWorkspaceOwner && !current.matchesWorkspaceOwner)) {
            selectedTasks.set(taskKey, { task, matchesWorkspaceOwner });
          }
        }
      }
      return [...selectedTasks.values()].map(({ task }) => task);
    },

    resolveWindow(workspaceKey) {
      return selectWorkspaceOwners().get(workspaceKey)?.windowId;
    },

    removeWindow(windowId) {
      snapshots.delete(windowId);
    },
  };
}
