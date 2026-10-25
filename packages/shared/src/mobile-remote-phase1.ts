import { z } from "zod";
import { resolveWebRemoteControlWorkspaceKey } from "./web-remote-control.js";

const id = z.string().trim().min(1).max(256);
const path = z.string().min(1).max(8192);
export const mobileTargetRefSchema = z
  .object({
    backendId: id,
    workspaceKey: path,
    workspacePath: path,
    workspaceIdentity: path.optional(),
    remoteSessionId: id.optional(),
    taskId: id.optional(),
    sessionId: id.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.workspaceKey !== resolveWebRemoteControlWorkspaceKey(target)) {
      context.addIssue({
        code: "custom",
        path: ["workspaceKey"],
        message: "Workspace identity mismatch",
      });
    }
    if (Boolean(target.workspaceIdentity?.trim()) !== Boolean(target.remoteSessionId)) {
      context.addIssue({
        code: "custom",
        path: ["remoteSessionId"],
        message: "Remote routes require both identity and attachment",
      });
    }
  });
export type MobileTargetRef = z.infer<typeof mobileTargetRefSchema>;

export const mobileRequestContextSchema = z
  .object({
    backendId: id,
    connectionGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    workspaceKey: path,
    requestId: id,
  })
  .strict();
export type MobileRequestContext = z.infer<typeof mobileRequestContextSchema>;
export function isCurrentMobileRequest(
  current: MobileRequestContext,
  response: MobileRequestContext,
): boolean {
  return (
    current.backendId === response.backendId &&
    current.connectionGeneration === response.connectionGeneration &&
    current.workspaceKey === response.workspaceKey &&
    current.requestId === response.requestId
  );
}

/** Optional capabilities are advertised only after their runtime adapters are installed. */
export const mobileCapabilitiesSchema = z
  .object({
    historySearch: z.literal(1).optional(),
    fileBrowser: z.literal(1).optional(),
    notificationFeed: z.literal(1).optional(),
    notificationPush: z.literal(1).optional(),
  })
  .strict();
export type MobileCapabilities = z.infer<typeof mobileCapabilitiesSchema>;
export function supportsMobileCapability(
  capabilities: MobileCapabilities | undefined,
  capability: keyof MobileCapabilities,
): boolean {
  return capabilities?.[capability] === 1;
}

/** Injected by Main from the authenticated gateway offer and channel hello, never from app payloads. */
export const mobileNotificationPrincipalSchema = z
  .object({ backendId: id, deviceSubject: id, clientInstanceId: id })
  .strict();
export type MobileNotificationPrincipal = z.infer<typeof mobileNotificationPrincipalSchema>;
