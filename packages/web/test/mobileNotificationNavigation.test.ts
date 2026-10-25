import { describe, expect, it, vi } from "vitest";
import {
  resolveMobileNotificationNavigation,
  validateMobileNotificationTask,
} from "../src/mobile-remote/mobileNotificationNavigation.js";

const target = {
  backendId: "b",
  workspaceKey: "ssh:a:/repo",
  workspacePath: "/repo",
  workspaceIdentity: "ssh:a:/repo",
  remoteSessionId: "attachment-a",
  taskId: "task",
  sessionId: "task",
};
function setup(overrides = {}) {
  const reader = {
    getNotification: vi
      .fn()
      .mockResolvedValue({ notificationId: "n", target: { ...target, ...overrides } }),
  };
  const listWorkspaces = vi.fn().mockResolvedValue({ workspaces: [{ kind: "remote", ...target }] });
  return { backendId: "b", notificationId: "n", reader: reader as any, listWorkspaces };
}
describe("notification click resolution", () => {
  it("uses the authoritative feed and current attachment, never native path data", async () => {
    const options = setup();
    expect(await resolveMobileNotificationNavigation(options)).toMatchObject({ target });
    expect(options.reader.getNotification).toHaveBeenCalledWith({ notificationId: "n" });
  });
  it.each([
    { backendId: "other" },
    { workspaceIdentity: "ssh:b:/repo", workspaceKey: "ssh:b:/repo" },
  ])("rejects a stale or mismatched route %j", async (change) => {
    await expect(resolveMobileNotificationNavigation(setup(change))).rejects.toThrow();
  });
  it("does not navigate a deleted or expired notification", async () => {
    const options = setup();
    options.reader.getNotification.mockResolvedValue(null);
    await expect(resolveMobileNotificationNavigation(options)).rejects.toThrow(
      "notification-unavailable",
    );
    expect(options.listWorkspaces).not.toHaveBeenCalled();
  });
  it("rejects a same-path task from another identity and missing tasks", async () => {
    const services = {
      zcodeTaskService: {
        getTaskMeta: vi.fn().mockResolvedValue({ ...target, workspaceIdentity: "ssh:b:/repo" }),
      },
    };
    await expect(validateMobileNotificationTask(services as any, target)).rejects.toThrow();
    services.zcodeTaskService.getTaskMeta.mockResolvedValue(null as any);
    await expect(validateMobileNotificationTask(services as any, target)).rejects.toThrow();
  });
  it("keeps the authoritative task/session mapping and refreshes an attachment by identity", async () => {
    const resolved = await resolveMobileNotificationNavigation(
      setup({ remoteSessionId: "old-attachment", sessionId: "distinct-session" }),
    );
    expect(resolved.target).toMatchObject({
      taskId: "task",
      sessionId: "distinct-session",
      remoteSessionId: "attachment-a",
    });
  });
});
