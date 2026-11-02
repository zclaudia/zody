import type { Event } from "@zody/rpc";
import { ServiceChannels } from "@zody/shared";
import type { ZCodeTaskMeta } from "@zody/shared";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostControllerTaskFrame,
  WindowHostControllerTaskRow,
  WindowHostControllerWorkspaceFrame,
  WindowHostTaskAddress,
} from "@zody/shared/zody-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { ZCodeArchivedTaskDeletionResult } from "#src/session/zodyTaskService.js";
import type {
  ZCodeTaskListItem,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListWorkspaceScope,
} from "../session/zodyTaskListTypes.js";

export type WindowHostControllerMutation =
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

export type WindowHostControllerTaskListItem = ZCodeTaskListItem & {
  remoteSessionId?: string;
  sourceAvailability: "online" | "offline";
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  activity?: WindowHostControllerTaskRow["activity"];
};

export interface WindowHostControllerTaskListResult extends Omit<ZCodeTaskListResult, "items"> {
  items: WindowHostControllerTaskListItem[];
}

export interface MobileHistorySearchSourceQuery {
  workspaceScope: ZCodeTaskListWorkspaceScope;
  query: string;
  includeArchived: boolean;
  limit: 50 | 100 | 200;
}

export type MobileHistorySearchSourceItem = Pick<
  ZCodeTaskMeta,
  | "taskId"
  | "traceId"
  | "title"
  | "titleOverridden"
  | "workspacePath"
  | "workspaceIdentity"
  | "workspacePurpose"
  | "createdAt"
  | "updatedAt"
  | "mode"
  | "provider"
  | "model"
  | "status"
> & {
  remoteSessionId?: string;
  searchSnippets?: string[];
};

export type MobileHistorySearchSourceResult =
  | { status: "ok"; items: MobileHistorySearchSourceItem[] }
  | { status: "offline" | "closed" | "unsupported" | "error"; errorCode?: string };

export type WindowHostControllerFrame =
  | WindowHostControllerTaskFrame
  | WindowHostControllerWorkspaceFrame;

/**
 * 窗口级 Controller 服务只承载列表投影与跨 source 路由。
 * conversation/file/git/terminal 仍由 attachment 对应的 scoped facade 提供。
 */
export interface IWindowControllerService {
  deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean>;
  deleteArchivedTasks(params: {
    address: WindowHostTaskAddress;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;
  listTaskList(params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult>;
  searchMobileHistory(
    params: MobileHistorySearchSourceQuery,
  ): Promise<MobileHistorySearchSourceResult>;
  mutateTask(params: {
    address: WindowHostTaskAddress;
    mutation: WindowHostControllerMutation;
  }): Promise<ZCodeTaskMeta | null>;
  subscribeControllerV4(params: ControllerSubscribeParams): Promise<ControllerSubscribeResult>;
  resyncControllerV4(params: ControllerResyncParams): Promise<ControllerResyncResult>;
  unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void>;
  onDynamicControllerFrame(): Event<WindowHostControllerFrame>;
}

export const IWindowControllerService = createServiceDescriptor<IWindowControllerService>(
  ServiceChannels.WindowController,
);
