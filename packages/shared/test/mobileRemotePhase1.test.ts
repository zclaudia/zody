import { describe, expect, it } from "vitest";
import {
  mobileTargetRefSchema,
  mobileRequestContextSchema,
  isCurrentMobileRequest,
  supportsMobileCapability,
} from "../src/mobile-remote-phase1.js";

describe("mobile phase 1 boundaries", () => {
  const target = {
    backendId: "computer-a",
    workspaceKey: "ssh:a",
    workspaceIdentity: "ssh:a",
    workspacePath: "/project",
    remoteSessionId: "attachment-1",
    taskId: "task",
    sessionId: "session",
  };
  it("preserves task/session distinction and remote identity without falling back to path", () => {
    expect(mobileTargetRefSchema.parse(target)).toEqual(target);
    expect(mobileTargetRefSchema.safeParse({ ...target, workspaceKey: "/project" }).success).toBe(
      false,
    );
    expect(mobileTargetRefSchema.safeParse({ ...target, remoteSessionId: undefined }).success).toBe(
      false,
    );
    expect(mobileTargetRefSchema.safeParse({ ...target, backendId: "" }).success).toBe(false);
    expect(
      mobileTargetRefSchema.parse({ backendId: "a", workspaceKey: "/p", workspacePath: "/p" }),
    ).toBeTruthy();
  });
  it("rejects stale backend, connection, workspace and request generations", () => {
    const current = mobileRequestContextSchema.parse({
      backendId: "a",
      workspaceKey: "w",
      connectionGeneration: 1,
      requestId: "r",
    });
    expect(isCurrentMobileRequest(current, current)).toBe(true);
    for (const changed of [
      { backendId: "b" },
      { workspaceKey: "w2" },
      { connectionGeneration: 2 },
      { requestId: "old" },
    ]) {
      expect(isCurrentMobileRequest(current, { ...current, ...changed })).toBe(false);
    }
    expect(
      mobileRequestContextSchema.safeParse({ ...current, connectionGeneration: -1 }).success,
    ).toBe(false);
  });
  it("fails closed for old or unadvertised optional features", () => {
    expect(supportsMobileCapability(undefined, "historySearch")).toBe(false);
    expect(supportsMobileCapability({ historySearch: 1 }, "historySearch")).toBe(true);
    expect(supportsMobileCapability({ historySearch: 1 }, "notificationFeed")).toBe(false);
  });
});
