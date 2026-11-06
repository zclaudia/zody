import { describe, expect, it, vi } from "vitest";
import {
  loadProjectPermissionRuleset,
  persistProjectPermissionUpdates,
} from "../src/tool/executor/permission-rules-persistence.js";

describe("session permission isolation", () => {
  it("reads and writes session-scoped grants without inheriting workspace approval", async () => {
    const sessionStore = {
      getSession: vi.fn(async () => ({
        id: "s",
        projectID: "project",
        permission: { version: 1, scope: "session" },
      })),
      getProjectPermission: vi.fn(async () => ({ version: 1, allow: [{ toolName: "Bash" }] })),
      saveProjectPermission: vi.fn(),
      updateSession: vi.fn(async () => undefined),
    };
    const deps = { sessionId: "s", sessionStore } as never;
    expect(await loadProjectPermissionRuleset(deps)).toEqual({ version: 1, scope: "session" });
    await persistProjectPermissionUpdates(
      deps,
      [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Read" }] }],
      {} as never,
    );
    expect(sessionStore.getProjectPermission).not.toHaveBeenCalled();
    expect(sessionStore.saveProjectPermission).not.toHaveBeenCalled();
    expect(sessionStore.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s",
        permission: expect.objectContaining({ scope: "session", allow: [{ toolName: "Read" }] }),
      }),
    );
  });
  // fork（bots 移除）：原「group task approval 初始化」用例测的 ensureGroupTaskPermissionScope
  // （bot 群任务会话级授权收紧）随 bot channels 全量删除（specs/bot-channels-removal.md）；
  // session-scoped 权限规则持久化属权限审批管线，本用例保留。
});
