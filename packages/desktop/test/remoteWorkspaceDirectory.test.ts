import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlTaskTarget, WebRemoteControlWorkspaceTarget } from "@zcode/shared";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

function createWorkspace(
  overrides: Partial<WebRemoteControlWorkspaceTarget> = {},
): WebRemoteControlWorkspaceTarget {
  return {
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    label: overrides.label ?? "demo",
    kind: overrides.kind ?? "local",
    ...overrides,
  };
}

function createTask(overrides: Partial<WebRemoteControlTaskTarget> = {}): WebRemoteControlTaskTarget {
  return {
    taskId: overrides.taskId ?? "task-1",
    title: overrides.title ?? "Task one",
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    workspaceLabel: overrides.workspaceLabel ?? "demo",
    workspaceKind: overrides.workspaceKind ?? "local",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 2,
    ...overrides,
  };
}

const remoteIdentity = "remote:ssh:host:/workspace/remote";

describe("createRemoteWorkspaceDirectory", () => {
  it("按窗口整份替换快照，而不是合并增量", () => {
    const directory = createRemoteWorkspaceDirectory();
    const first = createWorkspace({ workspacePath: "/workspace/first" });
    const second = createWorkspace({ workspacePath: "/workspace/second" });

    directory.syncWorkspaces(7, [first, second]);
    expect(directory.getWindowSnapshot(7)?.workspaces).toEqual([first, second]);

    directory.syncWorkspaces(7, [second]);
    expect(directory.getWindowSnapshot(7)?.workspaces).toEqual([second]);

    directory.syncTasks(7, [createTask({ taskId: "task-1" })]);
    directory.syncTasks(7, []);
    expect(directory.getWindowSnapshot(7)?.tasks).toEqual([]);
  });

  it("窗口从未同步过时没有快照，也没有聚合结果", () => {
    const directory = createRemoteWorkspaceDirectory();

    expect(directory.getWindowSnapshot(7)).toBeUndefined();
    // 标签页恢复完成前 renderer 不发布快照；目录此时既没有窗口数据，也解析不出窗口。
    expect(directory.listWorkspaces()).toEqual([]);
    expect(directory.listTasks()).toEqual([]);
    expect(directory.resolveWindow("/workspace/demo")).toBeUndefined();
  });

  it("跨窗口聚合 workspace，按 workspaceKey 去重且各自命名空间互不干扰", () => {
    const directory = createRemoteWorkspaceDirectory();
    const focused = createWorkspace({ workspacePath: "/workspace/a", label: "A" });
    const shared = createWorkspace({ workspacePath: "/workspace/shared", label: "shared-from-1" });
    const sharedInOtherWindow = createWorkspace({
      workspacePath: "/workspace/shared",
      label: "shared-from-2",
    });
    const otherIdentity = createWorkspace({
      workspacePath: remoteIdentity,
      workspaceIdentity: remoteIdentity,
      remoteSessionId: "remote-session-1",
      label: "remote",
      kind: "remote",
    });

    directory.syncWorkspaces(1, [focused, shared]);
    directory.syncWorkspaces(2, [sharedInOtherWindow, otherIdentity]);

    expect(directory.listWorkspaces()).toEqual([sharedInOtherWindow, otherIdentity, focused]);
  });

  it("跨窗口聚合任务，按 workspaceKey + taskId 去重且保留不同 workspace 的同名 task", () => {
    const directory = createRemoteWorkspaceDirectory();
    const localTask = createTask({ taskId: "task-1", title: "local" });
    const remoteTask = createTask({
      taskId: "task-1",
      title: "remote",
      workspacePath: remoteIdentity,
      workspaceIdentity: remoteIdentity,
      remoteSessionId: "remote-session-1",
      workspaceKind: "remote",
      workspaceLabel: "remote",
    });

    directory.syncTasks(1, [localTask]);
    directory.syncTasks(2, [localTask, remoteTask]);

    expect(directory.listTasks()).toEqual([localTask, remoteTask]);
  });

  it("同一个 workspaceKey 出现在多个窗口时优先聚焦窗口，其次最近同步的窗口", () => {
    const focusedWindowId = { current: 2 as number | undefined };
    const directory = createRemoteWorkspaceDirectory({
      getFocusedWindowId: () => focusedWindowId.current,
    });
    const fromWindow1 = createWorkspace({ workspacePath: "/workspace/shared", label: "window-1" });
    const fromWindow2 = createWorkspace({ workspacePath: "/workspace/shared", label: "window-2" });
    const fromWindow3 = createWorkspace({ workspacePath: "/workspace/shared", label: "window-3" });

    directory.syncWorkspaces(1, [fromWindow1]);
    directory.syncWorkspaces(2, [fromWindow2]);
    directory.syncWorkspaces(3, [fromWindow3]);

    // 最近同步的是窗口 3，但窗口 2 处于聚焦态，所以它的 workspace 胜出。
    expect(directory.resolveWindow("/workspace/shared")).toBe(2);
    expect(directory.listWorkspaces()).toEqual([fromWindow2]);

    // 没有窗口聚焦时按最近同步的窗口选择。
    focusedWindowId.current = undefined;
    expect(directory.resolveWindow("/workspace/shared")).toBe(3);
    expect(directory.listWorkspaces()).toEqual([fromWindow3]);

    // 聚焦窗口没有这个 workspaceKey 时同样回落到最近同步的窗口。
    focusedWindowId.current = 1;
    directory.syncWorkspaces(3, [fromWindow3]);
    directory.syncWorkspaces(1, [createWorkspace({ workspacePath: "/workspace/other" })]);
    expect(directory.resolveWindow("/workspace/shared")).toBe(3);
  });

  it("按 workspaceKey 解析窗口时只用 workspace 快照，不看任务", () => {
    const directory = createRemoteWorkspaceDirectory();
    directory.syncWorkspaces(1, [createWorkspace({ workspacePath: "/workspace/demo" })]);
    directory.syncTasks(2, [createTask({ workspacePath: "/workspace/only-task" })]);

    expect(directory.resolveWindow("/workspace/only-task")).toBeUndefined();
    expect(directory.resolveWindow("/workspace/demo")).toBe(1);
  });

  it("窗口关闭时删除该窗口的快照", () => {
    const directory = createRemoteWorkspaceDirectory();
    directory.syncWorkspaces(1, [createWorkspace({ workspacePath: "/workspace/one" })]);
    directory.syncTasks(1, [createTask({ workspacePath: "/workspace/one" })]);
    directory.syncWorkspaces(2, [createWorkspace({ workspacePath: "/workspace/two" })]);

    directory.removeWindow(1);

    expect(directory.getWindowSnapshot(1)).toBeUndefined();
    expect(directory.resolveWindow("/workspace/one")).toBeUndefined();
    expect(directory.listWorkspaces()).toEqual([createWorkspace({ workspacePath: "/workspace/two" })]);
    expect(directory.listTasks()).toEqual([]);
  });

  it("只按传入的 BrowserWindow.id 存取，不做任何 id 换算或混存", () => {
    const directory = createRemoteWorkspaceDirectory();
    const workspace = createWorkspace({ workspacePath: "/workspace/demo" });
    // 24 是 BrowserWindow.id，99 是同一窗口的 webContents.id（attach 内部才做这次转换）。
    directory.syncWorkspaces(24, [workspace]);
    directory.syncTasks(24, [createTask()]);

    expect(directory.resolveWindow("/workspace/demo")).toBe(24);
    expect(directory.getWindowSnapshot(24)?.windowId).toBe(24);
    // 用 webContents.id 查询不会命中 BrowserWindow.id 的快照，两者不会互换。
    expect(directory.getWindowSnapshot(99)).toBeUndefined();
    expect(directory.resolveWindow("/workspace/demo")).not.toBe(99);
  });

  it("快照里的 windowId 就是同步时传入的值，目录不派生第二份窗口身份", () => {
    const directory = createRemoteWorkspaceDirectory();
    directory.syncTasks(42, []);
    expect(directory.getWindowSnapshot(42)?.windowId).toBe(42);
  });

  it("IPC 与 attach 各自只使用一个 id 空间：同步用 BrowserWindow.id，webContents.id 只在 attach 内部转换", () => {
    const ipcPlatform = source("../src/main/desktopMainIpcPlatform.ts");
    expect(ipcPlatform).toContain("const win = BrowserWindow.fromWebContents(event.sender);");
    expect(ipcPlatform).toContain("options.syncWebRemoteControlWorkspaces(win.id, result.data);");
    expect(ipcPlatform).toContain("options.syncWebRemoteControlTasks(win.id, result.data);");
    expect(ipcPlatform).not.toContain("syncWebRemoteControlWorkspaces(event.sender.id");
    expect(ipcPlatform).not.toContain("syncWebRemoteControlTasks(event.sender.id");

    const attachments = source("../src/main/webRemoteControlSharedHostAttachments.ts");
    // 唯一的转换点；目录与 manager 都不允许再维护一份 webContents 映射。
    expect(attachments).toContain(
      "const hostProcessWindowId = BrowserWindow.fromId(windowId)?.webContents.id ?? windowId;",
    );
    // 目录不接触 Electron 窗口对象，只按 id 存取，所以没有第二份 id 空间可混入。
    const directory = source("../src/main/remote-access/remoteWorkspaceDirectory.ts");
    expect(directory).not.toContain('from "electron"');
  });
});

describe("createRemoteWorkspaceDirectory 依赖注入", () => {
  it("没有 getFocusedWindowId 时按最近同步的窗口聚合", () => {
    const directory = createRemoteWorkspaceDirectory();
    directory.syncWorkspaces(1, [createWorkspace({ workspacePath: "/workspace/a" })]);
    directory.syncWorkspaces(2, [createWorkspace({ workspacePath: "/workspace/b" })]);
    expect(directory.listWorkspaces().map((workspace) => workspace.workspacePath)).toEqual([
      "/workspace/b",
      "/workspace/a",
    ]);
  });

  it("聚焦窗口查询抛错不影响已存快照语义（查询方只传递 id）", () => {
    const getFocusedWindowId = vi.fn(() => undefined);
    const directory = createRemoteWorkspaceDirectory({ getFocusedWindowId });
    directory.syncWorkspaces(3, [createWorkspace({ workspacePath: "/workspace/c" })]);

    expect(directory.resolveWindow("/workspace/c")).toBe(3);
    expect(getFocusedWindowId).toHaveBeenCalled();
  });
});
