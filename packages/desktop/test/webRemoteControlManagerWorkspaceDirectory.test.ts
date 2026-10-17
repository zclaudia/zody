import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlTaskTarget, WebRemoteControlWorkspaceTarget } from "@zcode/shared";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";

/**
 * T2.2：renderer 的快照同步改写进 App 级 RemoteWorkspaceDirectory，
 * 且不再依赖「本窗口存在远控 runtime」。这里只覆盖这条契约；
 * 有 runtime 时的推送行为由 webRemoteControlManagerExternalRelay.test.ts 覆盖。
 */
function createManagerWithDirectory() {
  const directory = createRemoteWorkspaceDirectory();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = createWebRemoteControlManager({
    appVersion: "1.5.0",
    createDeviceTransport: () => ({
      start: () => {},
      sendPayload: () => false,
      sendPayloadResult: () => ({ kind: "unavailable" as const }),
      measurePayloadBytes: () => 0,
      disconnectClient: () => {},
      dispose: () => {},
    }),
    remoteAccessSettings: {
      isEnabled: async () => false,
      setEnabled: async () => {},
    },
    featureGate: createWebRemoteControlFeatureGate(),
    remoteWorkspaceDirectory: directory,
    logger,
    platformHandlers: {
      isDockerAvailable: async () => true,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      createTempTextAttachment: async () => ({
        filename: "attachment.txt",
        localPath: "/tmp/attachment.txt",
        mimeType: "text/plain" as const,
        sizeBytes: 0,
      }),
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: async () => {},
    attachWorkspaceHost: async () => {
      throw new Error("本测试不建立 bridge");
    },
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
  });

  return { directory, logger, manager };
}

const demoWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/demo",
  label: "demo",
  kind: "local",
};

const demoTask: WebRemoteControlTaskTarget = {
  taskId: "task-1",
  title: "Task one",
  workspacePath: demoWorkspace.workspacePath,
  workspaceLabel: demoWorkspace.label,
  workspaceKind: "local",
  createdAt: 1,
  updatedAt: 2,
};

describe("webRemoteControlManager 快照同步", () => {
  it("没有 runtime 时也把整份快照写进目录，不再直接 return", () => {
    const { directory, manager, logger } = createManagerWithDirectory();

    expect(() => manager.syncAvailableWorkspaces(7, [demoWorkspace])).not.toThrow();
    expect(() => manager.syncAvailableTasks(7, [demoTask])).not.toThrow();

    expect(directory.getWindowSnapshot(7)?.workspaces).toEqual([demoWorkspace]);
    expect(directory.getWindowSnapshot(7)?.tasks).toEqual([demoTask]);
    // 没有 runtime 只是暂时没有手机可推送，不应被当成异常。
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("窗口关闭时删除该窗口在目录里的快照", async () => {
    const { directory, manager } = createManagerWithDirectory();
    manager.syncAvailableWorkspaces(7, [demoWorkspace]);
    manager.syncAvailableTasks(7, [demoTask]);
    manager.syncAvailableWorkspaces(8, [demoWorkspace]);

    await manager.disposeWindow(7);

    expect(directory.getWindowSnapshot(7)).toBeUndefined();
    // 只清理被关闭的窗口，其它窗口的快照保留。
    expect(directory.getWindowSnapshot(8)?.workspaces).toEqual([demoWorkspace]);
  });

  it("窗口的 workspace 与 task 快照互相独立，重复同步整份替换", () => {
    const { directory, manager } = createManagerWithDirectory();

    manager.syncAvailableWorkspaces(7, [demoWorkspace]);
    manager.syncAvailableTasks(7, [demoTask]);
    manager.syncAvailableTasks(7, []);

    expect(directory.getWindowSnapshot(7)?.workspaces).toEqual([demoWorkspace]);
    expect(directory.getWindowSnapshot(7)?.tasks).toEqual([]);
  });
});
