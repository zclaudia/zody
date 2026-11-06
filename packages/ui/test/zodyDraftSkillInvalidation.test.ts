import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IZodySessionService } from "@zody/services";
import { invalidateDeferredDraftSessionForSkillChange } from "../src/lib/zodyDraftSkillInvalidation.js";
import { useZodySessionStore } from "../src/store/zodySessionStore.js";

function createSessionService(
  closeSession: IZodySessionService["closeSession"] = vi.fn(async () => {}),
): Pick<IZodySessionService, "closeSession"> {
  return { closeSession };
}

beforeEach(() => {
  useZodySessionStore.setState((state) => ({
    ...state,
    workspaces: {},
  }));
});

describe("invalidateDeferredDraftSessionForSkillChange", () => {
  it("closes and clears the current workspace draft session", async () => {
    const closeSession = vi.fn(async () => {});
    const workspacePath = "/workspace/app";
    const workspaceIdentity = "ssh:dev";
    useZodySessionStore.getState().setDraftSessionId(workspacePath, "draft-1", workspaceIdentity);

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      workspaceIdentity,
      zodySessionService: createSessionService(closeSession),
    });

    expect(closeSession).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
      sessionId: "draft-1",
    });
    expect(
      useZodySessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .draftSessionId,
    ).toBeNull();
    expect(
      useZodySessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });

  it("invalidates a protocol-v4 prewarm even when there is no legacy draft session", async () => {
    const closeSession = vi.fn(async () => {});
    const workspacePath = "/workspace/app";

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      zodySessionService: createSessionService(closeSession),
    });

    expect(closeSession).not.toHaveBeenCalled();
    expect(
      useZodySessionStore.getState().getWorkspaceState(workspacePath)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });

  it("still clears the draft when closing the stale session fails", async () => {
    const closeSession = vi.fn(async () => {
      throw new Error("stale draft");
    });
    const workspacePath = "/workspace/app";
    useZodySessionStore.getState().setDraftSessionId(workspacePath, "draft-1");

    await invalidateDeferredDraftSessionForSkillChange({
      reason: "test",
      workspacePath,
      zodySessionService: createSessionService(closeSession),
    });

    expect(closeSession).toHaveBeenCalledWith({
      workspacePath,
      sessionId: "draft-1",
    });
    expect(
      useZodySessionStore.getState().getWorkspaceState(workspacePath).draftSessionId,
    ).toBeNull();
    expect(
      useZodySessionStore.getState().getWorkspaceState(workspacePath)
        .draftRuntimeInvalidationVersion,
    ).toBe(1);
  });
});
