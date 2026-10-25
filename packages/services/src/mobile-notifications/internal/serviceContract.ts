import type { Event } from "@zcode/rpc";
import type {
  MobileNotification,
  MobileNotificationCursor,
  MobileNotificationOutboxClaim,
  MobileNotificationPrincipal,
  MobileNotificationRecordInput,
  MobileNotificationPage,
} from "../contract.js";

/** Host-only persistence/outbox API. Never expose this contract through an RPC descriptor. */
export interface IMobileNotificationService {
  record(input: MobileNotificationRecordInput): Promise<MobileNotification>;
  resolveInteraction(input: {
    backendId: string;
    workspaceKey: string;
    sessionId: string;
    interactionId: string;
  }): Promise<void>;
  listFeedForPrincipal(input: {
    principal: MobileNotificationPrincipal;
    before?: MobileNotificationCursor;
    limit?: number;
  }): Promise<MobileNotificationPage>;
  getNotificationForPrincipal(input: {
    principal: MobileNotificationPrincipal;
    notificationId: string;
  }): Promise<MobileNotification | null>;
  markReadForPrincipal(input: {
    principal: MobileNotificationPrincipal;
    notificationId: string;
  }): Promise<void>;
  markAllReadForPrincipal(input: {
    principal: MobileNotificationPrincipal;
    through: MobileNotificationCursor;
  }): Promise<void>;
  claimOutbox(input: {
    workerId: string;
    backendId: string;
    now: number;
    leaseMs: number;
  }): Promise<MobileNotificationOutboxClaim | null>;
  acknowledgeOutbox(input: {
    notificationId: string;
    leaseId: string;
    fencingToken: number;
    acceptedAt: number;
  }): Promise<boolean>;
  failOutbox(input: {
    notificationId: string;
    leaseId: string;
    fencingToken: number;
    failedAt: number;
    retryable: boolean;
  }): Promise<boolean>;
  onFeedChanged: Event<void>;
  dispose(): void;
}
