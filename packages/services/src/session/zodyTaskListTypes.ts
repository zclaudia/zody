import type { WorkspacePurpose, ZodyTaskMeta } from "@zody/shared";

export type ZodyTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZodyTaskListSortBy = "created" | "updated";

export interface ZodyTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZodyTaskListQuery {
  kind: ZodyTaskListKind;
  workspaceScopes: ZodyTaskListWorkspaceScope[];
  sortBy: ZodyTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ZodyTaskListItem = ZodyTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZodyTaskListResult {
  items: ZodyTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ZodyTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZodyTaskGroup {
  id: string;
  title: string;
  color: ZodyTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZodyGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZodyGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ZodyGroupedTaskRef };

export type ZodyGroupedTaskViewNode =
  | {
      type: "group";
      group: ZodyTaskGroup;
      tasks: ZodyTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ZodyTaskListItem;
      sortOrder?: number;
    };

export interface ZodyGroupedTaskView {
  nodes: ZodyGroupedTaskViewNode[];
}

export interface ZodyGroupedTaskViewQuery {
  workspaceScopes: ZodyTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface ZodyGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type ZodyGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ZodyGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: ZodyTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: ZodyGroupedTaskViewStructureMember[];
  topLevelOrders: ZodyGroupedTaskViewStructureTopOrder[];
}

export interface ZodyGroupedTaskViewOrderInput {
  workspaceScopes: ZodyTaskListWorkspaceScope[];
  topLevelNodes: ZodyGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZodyGroupedTaskRef[];
  }>;
}

export interface ZodyWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
