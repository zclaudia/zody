import type { Event } from "@zcode/rpc";
import type { MobileNotificationPrincipal, MobileNotificationPushAction } from "@zcode/shared";
export type { MobileNotificationPrincipal } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type MobileNotificationKind = "completed" | "failed" | "permission" | "question";
export type MobileNotificationDeliveryState = "recorded" | "submitted" | "accepted" | "failed";

export interface MobileNotificationTarget {
  backendId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskId: string;
  sessionId: string;
}

export interface MobileNotificationRecordInput {
  target: MobileNotificationTarget;
  sourceEventId: string;
  sourceKind: "turn.completed" | "turn.failed" | "interaction.pending";
  interactionId?: string;
  turnId?: string;
  occurredAt: number;
  kind: MobileNotificationKind;
  title: string;
  recovered?: boolean;
  /**
   * 第二批 E4：permission 类通知的操作按钮（optionId + optionKind，脱敏）。
   * 在 interaction pending 时刻从 pendingInteraction payload.options 固化；
   * question/终态通知不携带。
   */
  actions?: MobileNotificationPushAction[];
}

export interface MobileNotification {
  notificationId: string;
  target: MobileNotificationTarget;
  sourceEventId: string;
  sourceKind: MobileNotificationRecordInput["sourceKind"];
  interactionId?: string;
  turnId?: string;
  occurredAt: number;
  kind: MobileNotificationKind;
  title: string;
  recovered: boolean;
  resolved: boolean;
  read: boolean;
  deliveryState: MobileNotificationDeliveryState;
  actions?: MobileNotificationPushAction[];
}

export interface MobileNotificationCursor {
  occurredAt: number;
  notificationId: string;
}

export interface MobileNotificationPage {
  items: MobileNotification[];
  nextCursor?: MobileNotificationCursor;
  unreadCount: number;
}

export interface MobileNotificationOutboxClaim {
  notification: MobileNotification;
  leaseId: string;
  fencingToken: number;
  attempt: number;
  leaseUntil: number;
}

export interface IMobileNotificationReader {
  listFeed(input: {
    before?: MobileNotificationCursor;
    limit?: number;
  }): Promise<MobileNotificationPage>;
  getNotification(input: { notificationId: string }): Promise<MobileNotification | null>;
  markRead(input: { notificationId: string }): Promise<void>;
  markAllRead(input: { through: MobileNotificationCursor }): Promise<void>;
  onFeedChanged: Event<void>;
}

export const IMobileNotificationReader = createServiceDescriptor<IMobileNotificationReader>(
  "mobile-notification-reader",
);
