import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebRemoteControlAppPayload,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { encodeWebRemoteControlRpcTransportMessage } from "@zcode/shared";
import { createWebRemoteControlManager } from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";

function createFakePort() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    postMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
}

type AttachWorkspaceHost = Parameters<
  typeof createWebRemoteControlManager
>[0]["attachWorkspaceHost"];

function createManagerHarness(options?: {
  featureEnabled?: boolean;
  canSendPayload?: () => boolean;
  /** T2.3：启动恢复只看 App 级开关，不再读 webRemoteControlLastEnabledContext。 */
  remoteAccessEnabled?: boolean;
  /** 让两个窗口共享同一目录时可注入聚焦窗口，用于路由规则测试。 */
  getFocusedWindowId?: () => number | undefined;
  attachWorkspaceHost?: AttachWorkspaceHost;
  releaseWorkspaceHostAttachment?: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow?: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession?: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  reconnectWorkspace?: (windowId: number, workspaceKey: string) => Promise<void>;
  onStatusChanged?: Parameters<typeof createWebRemoteControlManager>[0]["onStatusChanged"];
  /** T3.2：gateway backend 连接状态由 Main 的 RemoteGatewayBackend 注入。 */
  getGatewayConnectionStatus?: Parameters<
    typeof createWebRemoteControlManager
  >[0]["getGatewayConnectionStatus"];
  reportRemoteUsageEvent?: Parameters<
    typeof createWebRemoteControlManager
  >[0]["reportRemoteUsageEvent"];
}) {
  const sentPayloads: WebRemoteControlAppPayload[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const remoteWorkspaceDirectory = createRemoteWorkspaceDirectory({
    getFocusedWindowId: options?.getFocusedWindowId,
  });
  let remoteAccessEnabled = options?.remoteAccessEnabled ?? false;
  let deliverPayload: ((payload: WebRemoteControlAppPayload) => void) | undefined;
  let latestTransportOptions:
    | Parameters<
        NonNullable<Parameters<typeof createWebRemoteControlManager>[0]["createDeviceTransport"]>
      >[0]
    | undefined;
  let emitTransportState:
    | Parameters<
        NonNullable<Parameters<typeof createWebRemoteControlManager>[0]["createDeviceTransport"]>
      >[0]["onStateChange"]
    | undefined;
  const disposeTransport = vi.fn();
  const disconnectClientTransport = vi.fn();
  const reportRemoteUsageEvent = options?.reportRemoteUsageEvent ?? vi.fn();
  const reportRendererTelemetryEvent = vi.fn();
  const defaultAttachWorkspaceHost = vi.fn(async () => ({
    entryId: "entry-1",
    attachmentId: "attachment-1",
    process: {} as never,
    port: createFakePort() as never,
  }));
  const releaseWorkspaceHostAttachment = options?.releaseWorkspaceHostAttachment ?? vi.fn();
  const disposeWorkspaceHostAttachmentsForWindow =
    options?.disposeWorkspaceHostAttachmentsForWindow ?? vi.fn();
  const disposeWorkspaceHostAttachmentsForRemoteSession =
    options?.disposeWorkspaceHostAttachmentsForRemoteSession ?? vi.fn();
  const manager = createWebRemoteControlManager({
    appVersion: "1.5.0",
    remoteAccessSettings: {
      isEnabled: async () => remoteAccessEnabled,
      setEnabled: async (enabled) => {
        remoteAccessEnabled = enabled;
      },
    },
    featureGate: createWebRemoteControlFeatureGate(options?.featureEnabled ?? true),
    getGatewayConnectionStatus: options?.getGatewayConnectionStatus,
    // T2.2：快照投影改为注入的 App 级目录，测试用独立实例观察同步结果。
    remoteWorkspaceDirectory: remoteWorkspaceDirectory,
    logger,
    platformHandlers: {
      isDockerAvailable: async () => true,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: options?.reconnectWorkspace ?? vi.fn(async () => undefined),
    reportRemoteUsageEvent,
    reportRendererTelemetryEvent,
    attachWorkspaceHost: options?.attachWorkspaceHost ?? defaultAttachWorkspaceHost,
    releaseWorkspaceHostAttachment,
    disposeWorkspaceHostAttachmentsForWindow,
    disposeWorkspaceHostAttachmentsForRemoteSession,
    onStatusChanged: options?.onStatusChanged,
    createDeviceTransport: (transportOptions) => ({
      start: () => {
        latestTransportOptions = transportOptions;
        emitTransportState = transportOptions.onStateChange;
        deliverPayload = transportOptions.onPayload;
        transportOptions.onStateChange("waiting_terminal");
      },
      sendPayload: (payload) => {
        if (options?.canSendPayload && !options.canSendPayload()) {
          return false;
        }
        sentPayloads.push(payload);
        return true;
      },
      measurePayloadBytes: (payload) => JSON.stringify(payload).length,
      sendPayloadResult: (payload) => {
        if (options?.canSendPayload && !options.canSendPayload()) {
          return { kind: "unavailable" as const };
        }
        sentPayloads.push(payload);
        return { kind: "sent" as const, bytes: JSON.stringify(payload).length };
      },
      disconnectClient: disconnectClientTransport,
      dispose: disposeTransport,
    }),
  });

  return {
    defaultAttachWorkspaceHost,
    disconnectClientTransport,
    disposeWorkspaceHostAttachmentsForRemoteSession,
    disposeWorkspaceHostAttachmentsForWindow,
    disposeTransport,
    manager,
    logger,
    remoteWorkspaceDirectory,
    releaseWorkspaceHostAttachment,
    reportRemoteUsageEvent,
    reportRendererTelemetryEvent,
    sentPayloads,
    getRemoteAccessEnabled: () => remoteAccessEnabled,
    getLatestTransportOptions: () => latestTransportOptions,
    deliverPayload: (payload: WebRemoteControlAppPayload) => {
      if (!deliverPayload) {
        throw new Error("transport not started");
      }
      deliverPayload(payload);
    },
    emitTransportState: (state: Parameters<NonNullable<typeof emitTransportState>>[0]) => {
      if (!emitTransportState) {
        throw new Error("transport not started");
      }
      emitTransportState(state);
    },
    emitTransportSendReady: (kind: "same-socket" | "reconnected-socket") => {
      if (!latestTransportOptions?.onSendReady) {
        throw new Error("transport not started");
      }
      latestTransportOptions.onSendReady({ kind });
    },
  };
}

const localWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/demo",
  label: "demo",
  kind: "local",
};

const remoteWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/remote",
  workspaceIdentity: "remote:ssh:host:/workspace/remote",
  remoteSessionId: "remote-session-1",
  label: "remote",
  kind: "remote",
  connectionState: "connected",
};

function createTaskTarget(
  overrides: Partial<WebRemoteControlTaskTarget> = {},
): WebRemoteControlTaskTarget {
  return {
    taskId: "task-1",
    title: "Task one",
    workspacePath: localWorkspace.workspacePath,
    workspaceLabel: localWorkspace.label,
    workspaceKind: "local",
    createdAt: 1,
    updatedAt: 2,
    displayStatus: "completed",
    ...overrides,
  };
}

async function createPrimedTaskSyncHarness(
  taskOverrides: Partial<WebRemoteControlTaskTarget> = {},
) {
  const harness = createManagerHarness();
  await harness.manager.start({ workspacePath: localWorkspace.workspacePath });
  harness.manager.syncAvailableWorkspaces(1, [localWorkspace]);
  const task = createTaskTarget(taskOverrides);
  harness.manager.syncAvailableTasks(1, [task]);
  harness.sentPayloads.length = 0;
  return { ...harness, task };
}

async function createPrimedWorkspaceSyncHarness(
  workspaceOverrides: Partial<WebRemoteControlWorkspaceTarget> = {},
) {
  const harness = createManagerHarness();
  await harness.manager.start({ workspacePath: localWorkspace.workspacePath });
  const workspace = { ...remoteWorkspace, ...workspaceOverrides };
  harness.manager.syncAvailableWorkspaces(1, [workspace]);
  harness.sentPayloads.length = 0;
  return { ...harness, workspace };
}

async function createPrimedRemoteTaskSyncHarness(
  taskOverrides: Partial<WebRemoteControlTaskTarget> = {},
) {
  const harness = await createPrimedWorkspaceSyncHarness();
  const task = createTaskTarget({
    workspacePath: remoteWorkspace.workspacePath,
    workspaceIdentity: remoteWorkspace.workspaceIdentity,
    remoteSessionId: remoteWorkspace.remoteSessionId,
    workspaceLabel: remoteWorkspace.label,
    workspaceKind: "remote",
    ...taskOverrides,
  });
  harness.manager.syncAvailableTasks(1, [task]);
  harness.sentPayloads.length = 0;
  return { ...harness, task };
}

describe("createWebRemoteControlManager app runtime", () => {
  it("returns the desktop's own version before a workspace bridge is attached", async () => {
    const h = createManagerHarness();
    await h.manager.start({ workspacePath: localWorkspace.workspacePath });
    h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "version-check" });
    expect(h.sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "bootstrap-response",
        requestId: "version-check",
        result: expect.objectContaining({ desktopAppVersion: "1.5.0" }),
      }),
    );
    expect(h.defaultAttachWorkspaceHost).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("按首次配对和重连上报低频配对成功事件", async () => {
    const { emitTransportState, manager, reportRemoteUsageEvent } = createManagerHarness();

    await manager.start({ workspacePath: localWorkspace.workspacePath }, 1);
    emitTransportState("paired");
    emitTransportState("waiting_terminal");
    emitTransportState("paired");

    expect(reportRemoteUsageEvent).toHaveBeenNthCalledWith(1, 1, {
      elementName: "web_remote_control_pair_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        pair_kind: "initial",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "",
      },
    });
    expect(reportRemoteUsageEvent).toHaveBeenNthCalledWith(2, 1, {
      elementName: "web_remote_control_pair_result",
      eventRegion: "web_remote_control",
      eventType: "result",
      eventExtraDetail: {
        result: "success",
        pair_kind: "reconnect",
        workspace_kind: "local",
        remote_kind: "",
        error_category: "",
      },
    });
  });

  it("在远程 shared-host attachment 成功后上报 bridge 实际使用", async () => {
    const attachWorkspaceHost = vi.fn(async () => ({
      entryId: "entry-remote",
      attachmentId: "attachment-remote",
      process: {} as never,
      port: createFakePort() as never,
      remoteKind: "ssh" as const,
    }));
    const { deliverPayload, manager, reportRemoteUsageEvent } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({
      workspacePath: remoteWorkspace.workspacePath,
      workspaceIdentity: remoteWorkspace.workspaceIdentity,
      remoteSessionId: remoteWorkspace.remoteSessionId,
    });
    manager.syncAvailableWorkspaces(1, [remoteWorkspace]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-request-remote",
      bridgeSessionId: "bridge-remote",
      workspaceKey: remoteWorkspace.workspaceIdentity!,
      taskId: "task-1",
    });

    await vi.waitFor(() =>
      expect(reportRemoteUsageEvent).toHaveBeenCalledWith(1, {
        elementName: "web_remote_control_bridge_result",
        eventRegion: "web_remote_control",
        eventType: "result",
        eventExtraDetail: {
          result: "success",
          workspace_kind: "remote",
          remote_kind: "ssh",
          entry_kind: "task",
          error_category: "",
        },
      }),
    );
  });

  it("bridge 失败只上报错误分类，不泄漏原始目标信息", async () => {
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => {
      throw Object.assign(new Error("secret-host.example.com attach failed"), {
        code: "REMOTE_SESSION_MISSING",
      });
    });
    const { deliverPayload, manager, reportRemoteUsageEvent } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({ workspacePath: localWorkspace.workspacePath });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-request-failed",
      bridgeSessionId: "bridge-failed",
      workspaceKey: localWorkspace.workspacePath,
    });

    await vi.waitFor(() =>
      expect(reportRemoteUsageEvent).toHaveBeenCalledWith(1, {
        elementName: "web_remote_control_bridge_result",
        eventRegion: "web_remote_control",
        eventType: "result",
        eventExtraDetail: {
          result: "failure",
          workspace_kind: "local",
          remote_kind: "",
          entry_kind: "home",
          error_category: "attach",
        },
      }),
    );
    expect(JSON.stringify(reportRemoteUsageEvent.mock.calls)).not.toContain(
      "secret-host.example.com",
    );
  });

  it("matches remote workspace bridge requests by workspace identity and strips legacy bridge fields", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open" as const,
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-1",
          bridge: expect.objectContaining({
            kind: "remote",
            workspaceKey: "remote:ssh:host:/workspace/demo",
            workspaceIdentity: "remote:ssh:host:/workspace/demo",
          }),
        }),
      );
    });
    const readyPayload = sentPayloads.find(
      (payload) => payload.zcode_type === "workspace-bridge-ready",
    );
    expect(JSON.stringify(readyPayload)).not.toContain("bridgeToken");
    expect(JSON.stringify(readyPayload)).not.toContain("wsUrl");
  });

  it("keeps the App-level runtime alive when the initiating window closes", async () => {
    const { disposeTransport, manager } = createManagerHarness();

    // T2.3：runtime 属于 App，不属于启动窗口；windowId 只用于遥测/路由兜底。
    await manager.start({ workspacePath: "/workspace/demo" }, 1);

    await manager.disposeWindow(1);

    expect(disposeTransport).not.toHaveBeenCalled();
    expect(manager.getStatus()).toMatchObject({ status: "running" });

    await manager.suspend("test-stop");
    expect(disposeTransport).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toEqual({ status: "idle" });
  });

  it("stops the App-level runtime when remote access is disabled", async () => {
    const { disposeTransport, getRemoteAccessEnabled, manager } = createManagerHarness({
      remoteAccessEnabled: true,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    await manager.setRemoteAccessEnabled(false);

    expect(getRemoteAccessEnabled()).toBe(false);
    expect(disposeTransport).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toEqual({ status: "idle" });
  });

  it("applies the remote access value synced from renderer settings without writing it again", async () => {
    const { getRemoteAccessEnabled, manager } = createManagerHarness();

    // 设置页直接 useSettings.update 时，Main 只对开关值做出反应，不重复持久化。
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    await manager.applyRemoteAccessEnabled(true);
    expect(manager.getStatus()).toMatchObject({ status: "running" });
    expect(getRemoteAccessEnabled()).toBe(false);

    await manager.applyRemoteAccessEnabled(false);
    expect(manager.getStatus()).toEqual({ status: "idle" });
  });

  it("auto-starts once when remote access is enabled and a workspace context is available", async () => {
    const { getLatestTransportOptions, manager } = createManagerHarness({
      remoteAccessEnabled: true,
    });

    await expect(
      manager.restorePreviouslyEnabled(1, [{ workspacePath: "/workspace/other" }]),
    ).resolves.toBe(true);
    expect(manager.getStatus()).toEqual(
      expect.objectContaining({
        status: "running",
        workspacePath: "/workspace/other",
      }),
    );
    expect(getLatestTransportOptions()).toBeDefined();

    // 已启动后重复同步不会再造一个 runtime。
    await expect(
      manager.restorePreviouslyEnabled(1, [{ workspacePath: "/workspace/demo" }]),
    ).resolves.toBe(false);
  });

  it("does not auto-start when the remote access switch is off", async () => {
    const { manager } = createManagerHarness();

    await expect(
      manager.restorePreviouslyEnabled(1, [{ workspacePath: "/workspace/demo" }]),
    ).resolves.toBe(false);
    expect(manager.getStatus()).toEqual({ status: "idle" });
  });

  it("releases only the previous attachment when mobile reconnects to the same workspace", async () => {
    let nextAttachmentId = 0;
    const attachWorkspaceHost = vi.fn(async () => ({
      entryId: "entry-1",
      attachmentId: `attachment-${++nextAttachmentId}`,
      process: {} as never,
      port: createFakePort() as never,
    }));
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      releaseWorkspaceHostAttachment,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
      taskId: "task-1",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-1" })),
    );

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-2",
      bridgeSessionId: "bridge-2",
      workspaceKey: "/workspace/demo",
      taskId: "task-1",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-2" })),
    );

    expect(attachWorkspaceHost).toHaveBeenCalledTimes(2);
    expect(attachWorkspaceHost).toHaveBeenLastCalledWith(1, {
      workspacePath: "/workspace/demo",
      workspaceIdentity: undefined,
      remoteSessionId: undefined,
      initialTaskId: "task-1",
      kind: "local",
    });
    expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");
  });

  it("lists disconnected remote workspaces but does not create a bridge before reconnect", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start({ workspacePath: "/workspace/local" });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/remote",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        label: "remote",
        kind: "remote",
        connectionState: "disconnected",
        lastConnectionError: "ssh closed",
      },
    ]);

    sentPayloads.length = 0;
    deliverPayload({ zcode_type: "workspace-list-request", requestId: "list-1" });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-list-response",
          result: expect.objectContaining({
            workspaces: expect.arrayContaining([
              expect.objectContaining({
                workspaceIdentity: "remote:ssh:host:/workspace/remote",
                connectionState: "disconnected",
                lastConnectionError: "ssh closed",
              }),
            ]),
          }),
        }),
      ),
    );

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "bridge-req-1",
      bridgeSessionId: "bridge-disconnected",
      workspaceKey: "remote:ssh:host:/workspace/remote",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          bridgeSessionId: "bridge-disconnected",
        }),
      ),
    );
  });

  it("pushes workspace list updates after renderer syncs task membership changes", async () => {
    const { manager, sentPayloads } = createManagerHarness();

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        label: "demo",
        kind: "local",
      },
    ]);

    sentPayloads.length = 0;
    manager.syncAvailableTasks(1, [
      {
        taskId: "task-1",
        title: "Task one",
        workspacePath: "/workspace/demo",
        workspaceLabel: "demo",
        workspaceKind: "local",
        createdAt: 1,
        updatedAt: 2,
      },
    ]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              taskId: "task-1",
              workspacePath: "/workspace/demo",
            }),
          ],
        }),
      }),
    );
  });

  it.each([
    ["displayStatus", { displayStatus: "running" }, { displayStatus: "completed" }],
    ["hasBackgroundWork", {}, { hasBackgroundWork: true }],
    [
      "workflowActivity",
      {},
      {
        workflowActivity: {
          runs: [{ runId: "run-1", status: "running", phases: [], agentsWorking: 0 }],
        },
      },
    ],
    [
      "workflowActivity phase",
      {
        workflowActivity: {
          runs: [
            {
              runId: "run-1",
              status: "running",
              phases: [{ name: "a", status: "running" }],
              agentsWorking: 0,
            },
          ],
        },
      },
      {
        workflowActivity: {
          runs: [
            {
              runId: "run-1",
              status: "running",
              phases: [{ name: "a", status: "done" }],
              agentsWorking: 0,
            },
          ],
        },
      },
    ],
    ["unreadAt", { unreadAt: 3 }, { unreadAt: undefined }],
    ["title", {}, { title: "Task renamed" }],
    ["pinned", {}, { pinned: true }],
    ["archived", {}, { archived: true }],
  ] satisfies Array<
    [string, Partial<WebRemoteControlTaskTarget>, Partial<WebRemoteControlTaskTarget>]
  >)("pushes workspace list updates when task %s changes", async (_field, initial, patch) => {
    const { manager, sentPayloads, task } = await createPrimedTaskSyncHarness(initial);

    manager.syncAvailableTasks(1, [{ ...task, ...patch }]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          tasks: [expect.objectContaining({ taskId: task.taskId, ...patch })],
        }),
      }),
    );
  });

  it.each([
    ["connectionState", {}, { connectionState: "reconnecting" }],
    ["remoteSessionId", {}, { remoteSessionId: "remote-session-2" }],
    [
      "lastConnectionError",
      { connectionState: "disconnected", lastConnectionError: "ssh closed" },
      { lastConnectionError: "authentication failed" },
    ],
  ] satisfies Array<
    [string, Partial<WebRemoteControlWorkspaceTarget>, Partial<WebRemoteControlWorkspaceTarget>]
  >)("pushes workspace list updates when workspace %s changes", async (_field, initial, patch) => {
    const { manager, sentPayloads, workspace } = await createPrimedWorkspaceSyncHarness(initial);

    manager.syncAvailableWorkspaces(1, [{ ...workspace, ...patch }]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          workspaces: expect.arrayContaining([
            expect.objectContaining({
              workspaceIdentity: workspace.workspaceIdentity,
              ...patch,
            }),
          ]),
        }),
      }),
    );
  });

  it("pushes workspace list updates when a task remote session changes", async () => {
    const { manager, sentPayloads, task } = await createPrimedRemoteTaskSyncHarness();

    manager.syncAvailableTasks(1, [{ ...task, remoteSessionId: "remote-session-2" }]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              taskId: task.taskId,
              remoteSessionId: "remote-session-2",
            }),
          ],
        }),
      }),
    );
  });

  it("does not push workspace list updates when only high-frequency task time changes", async () => {
    const { manager, sentPayloads, task } = await createPrimedTaskSyncHarness({
      displayStatus: "running",
    });

    manager.syncAvailableTasks(1, [{ ...task, updatedAt: task.updatedAt + 1 }]);

    expect(sentPayloads).toEqual([]);
  });

  it("does not collide when task signature fields contain control separators", async () => {
    const { manager, sentPayloads, task } = await createPrimedRemoteTaskSyncHarness({
      title: "Title\u0001session",
      remoteSessionId: "tail",
    });

    manager.syncAvailableTasks(1, [
      {
        ...task,
        title: "Title",
        remoteSessionId: "session\u0001tail",
      },
    ]);

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          tasks: [
            expect.objectContaining({
              title: "Title",
              remoteSessionId: "session\u0001tail",
            }),
          ],
        }),
      }),
    );
  });

  it("forwards mobile workspace reconnect requests to the desktop renderer", async () => {
    const reconnectWorkspace = vi.fn(async () => undefined);
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      reconnectWorkspace,
    });

    // 没有目录快照时回退到启动来源窗口（T2.3 保留的兜底路由）。
    await manager.start({ workspacePath: "/workspace/demo" }, 1);

    deliverPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "reconnect-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual({
        zcode_type: "workspace-reconnect-response",
        requestId: "reconnect-1",
        workspaceKey: "remote:ssh:host:/workspace/demo",
        success: true,
      }),
    );
    expect(reconnectWorkspace).toHaveBeenCalledWith(1, "remote:ssh:host:/workspace/demo");
  });

  it("releases stale attachments when an older bridge open completes after reconnect", async () => {
    let resolveFirst: ((value: Awaited<ReturnType<AttachWorkspaceHost>>) => void) | undefined;
    const attachWorkspaceHost = vi
      .fn<AttachWorkspaceHost>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        entryId: "entry-1",
        attachmentId: "attachment-2",
        process: {} as never,
        port: createFakePort() as never,
      });
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      releaseWorkspaceHostAttachment,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-2",
      bridgeSessionId: "bridge-2",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(expect.objectContaining({ bridgeSessionId: "bridge-2" })),
    );

    resolveFirst?.({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: createFakePort() as never,
    });

    await vi.waitFor(() =>
      expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1"),
    );
    expect(releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith("");
    expect(
      sentPayloads.filter(
        (payload) =>
          payload.zcode_type === "workspace-bridge-ready" && payload.bridgeSessionId === "bridge-1",
      ),
    ).toEqual([]);
  });

  it("does not match a remote workspace by path when identity is present", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);

    sentPayloads.length = 0;
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-path",
      bridgeSessionId: "bridge-path",
      workspaceKey: "/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: "req-path",
        }),
      );
    });
  });

  it.each([
    ["DESKTOP_HOST_MISSING", "desktop-disconnected"],
    ["REMOTE_SESSION_MISSING", "workspace-closed"],
    ["REMOTE_WORKSPACE_IDENTITY_MISSING", "unsupported-action"],
  ] as const)("maps workspace bridge attach error %s to %s", async (code, reason) => {
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => {
      throw Object.assign(new Error(`attach failed: ${code}`), { code });
    });
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: `req-${code}`,
      bridgeSessionId: `bridge-${code}`,
      workspaceKey: "/workspace/demo",
    });

    await vi.waitFor(() => {
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-error",
          requestId: `req-${code}`,
          bridgeSessionId: `bridge-${code}`,
          reason,
        }),
      );
    });
  });

  it("production feature gate rejects start", async () => {
    const { manager } = createManagerHarness({ featureEnabled: false });

    await expect(
      manager.start({
        workspacePath: "/workspace/demo",
      }),
    ).rejects.toThrow("Web remote control is disabled");
    expect(manager.getStatus()).toEqual({
      status: "idle",
      failure: {
        reason: "unsupported-action",
        message: "Web remote control is disabled in this build.",
      },
    });
  });

  it("starts the gateway channel transport without relay pairing material", async () => {
    const { manager } = createManagerHarness();

    await expect(manager.start({ workspacePath: "/workspace/demo" })).resolves.toBeUndefined();
    expect(manager.getStatus()).toMatchObject({
      status: "running",
      mobileConnected: false,
    });
    expect(manager.getStatus()).not.toHaveProperty("qrUrl");
    expect(manager.getStatus()).not.toHaveProperty("connectUrl");
    expect(manager.getStatus()).not.toHaveProperty("sessionId");
  });

  it("emits a status update as soon as the gateway channel session is ready", async () => {
    const onStatusChanged = vi.fn();
    const { manager } = createManagerHarness({ onStatusChanged });

    await manager.start({
      workspacePath: "/workspace/demo",
    });

    // T2.3：状态是 App 级事件，不再携带 windowId；广播由 index.ts 负责。
    expect(onStatusChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
  });

  it("keeps the dialog active during a short paired-session reconnect", async () => {
    vi.useFakeTimers();
    const { emitTransportState, manager } = createManagerHarness();

    await manager.start({
      workspacePath: "/workspace/demo",
    });
    emitTransportState("paired");
    expect(manager.getStatus()).toMatchObject({
      status: "active",
      mobileConnected: true,
    });

    emitTransportState("waiting_terminal");
    expect(manager.getStatus()).toMatchObject({
      status: "active",
      mobileConnected: true,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(manager.getStatus()).toMatchObject({
      status: "running",
      mobileConnected: false,
    });
  });

  it("flushes buffered outbound payloads after a normal reconnect becomes paired", async () => {
    let canSendPayload = true;
    const { deliverPayload, emitTransportState, manager, sentPayloads } = createManagerHarness({
      canSendPayload: () => canSendPayload,
    });

    await manager.start({
      workspacePath: "/workspace/demo",
    });
    emitTransportState("paired");
    sentPayloads.length = 0;

    canSendPayload = false;
    deliverPayload({
      zcode_type: "workspace-list-request",
      requestId: "req-buffered",
    });
    expect(sentPayloads).toEqual([]);

    canSendPayload = true;
    emitTransportState("waiting_terminal");
    emitTransportState("paired");

    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-response",
        requestId: "req-buffered",
      }),
    );
  });

  it("drops duplicate mobile rpc frames before forwarding to the host", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    const [frame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([1]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 1,
      messageSeq: 1,
    });
    deliverPayload(frame);
    deliverPayload(frame);

    expect(hostPort.postMessage).toHaveBeenCalledTimes(1);
  });

  it("marks a bridge degraded and does not forward mobile rpc frame gaps", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    const [gapFrame] = encodeWebRemoteControlRpcTransportMessage(new Uint8Array([2]), {
      bridgeSessionId: "bridge-1",
      firstPhysicalSeq: 2,
      messageSeq: 1,
    });
    deliverPayload(gapFrame);

    expect(hostPort.postMessage).not.toHaveBeenCalled();
    expect(sentPayloads).toContainEqual({
      zcode_type: "bridge-degraded",
      bridgeSessionId: "bridge-1",
      reason: "rpc-transport-fault",
    });
  });

  it("keeps raw bridge frames out of the ordinary 50-item buffer", async () => {
    let canSendPayload = true;
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({
        attachWorkspaceHost,
        canSendPayload: () => canSendPayload,
      });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    canSendPayload = false;
    for (let index = 0; index < 51; index += 1) {
      hostPort.emit("message", { data: new Uint8Array([index]) });
    }

    canSendPayload = true;
    emitTransportSendReady("same-socket");

    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(51);
    expect(sentPayloads.some((payload) => payload.zcode_type === "bridge-degraded")).toBe(false);
  });

  it("does not apply the ordinary app buffer timeout to raw bridge frames", async () => {
    vi.useFakeTimers();
    let canSendPayload = true;
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({
        attachWorkspaceHost,
        canSendPayload: () => canSendPayload,
      });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    canSendPayload = false;
    hostPort.emit("message", { data: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(5_000);

    canSendPayload = true;
    emitTransportSendReady("same-socket");

    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(1);
    expect(sentPayloads.some((payload) => payload.zcode_type === "bridge-degraded")).toBe(false);
  });

  it("replays lost-ACK raw frames after same-socket peer readiness and stops after cumulative ACK", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportSendReady, emitTransportState, manager, sentPayloads } =
      createManagerHarness({ attachWorkspaceHost });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-1",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    sentPayloads.length = 0;
    hostPort.emit("message", { data: new Uint8Array([1, 2, 3]) });
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(1);
    const firstFrame = sentPayloads[0];

    emitTransportSendReady("same-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(2);
    expect(sentPayloads[1]).toBe(firstFrame);

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "foreign-bridge",
      ackMessageSeq: 1,
    });
    emitTransportSendReady("reconnected-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(3);

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-1",
      ackMessageSeq: 1,
    });
    emitTransportSendReady("reconnected-socket");
    expect(sentPayloads.filter((payload) => payload.zcode_type === "rpc-frame")).toHaveLength(3);
  });

  it("forwards raw adapter saturated/drained edges only to the owning host attachment", async () => {
    const hostPort = createFakePort();
    const attachWorkspaceHost = vi.fn<AttachWorkspaceHost>(async () => ({
      entryId: "entry-1",
      attachmentId: "attachment-1",
      process: {} as never,
      port: hostPort as never,
    }));
    const { deliverPayload, emitTransportState, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/demo", label: "demo", kind: "local" },
    ]);
    emitTransportState("paired");
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-bridge",
      bridgeSessionId: "bridge-flow",
      workspaceKey: "/workspace/demo",
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );

    hostPort.emit("message", { data: new Uint8Array(900_000) });
    expect(hostPort.postMessage).toHaveBeenCalledWith({
      __zcodeRpcControl: "connection-flow-v1",
      state: "saturated",
    });

    deliverPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: "bridge-flow",
      ackMessageSeq: 1,
    });
    expect(hostPort.postMessage).toHaveBeenCalledWith({
      __zcodeRpcControl: "connection-flow-v1",
      state: "drained",
    });
  });

  it("exposes the latest mobile device info from view state updates", async () => {
    const { deliverPayload, manager } = createManagerHarness();

    await manager.start({
      workspacePath: "/workspace/demo",
    });

    deliverPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: "/workspace/demo",
        activeTaskId: "task-1",
        updatedAt: 1,
      },
      deviceInfo: {
        platform: "web",
        version: "1.7.0",
        name: "mobile-browser",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        language: "zh-CN",
        languages: ["zh-CN", "en-US"],
        browserPlatform: "iPhone",
        viewport: {
          width: 390,
          height: 844,
          devicePixelRatio: 3,
        },
        screen: {
          width: 390,
          height: 844,
        },
        timezone: "Asia/Shanghai",
        online: true,
        updatedAt: 2,
      },
    });

    expect(manager.getStatus()).toMatchObject({
      mobileViewState: {
        activeWorkspaceKey: "/workspace/demo",
        activeTaskId: "task-1",
      },
      mobileDeviceInfo: {
        platform: "web",
        userAgent: "Mozilla/5.0 Mobile Safari/604.1",
        viewport: {
          width: 390,
          height: 844,
        },
      },
    });
  });

  it("手机 session_create 保留来源和手机 context，宿主只转发一次", async () => {
    const { deliverPayload, manager, reportRendererTelemetryEvent } = createManagerHarness();
    await manager.start({ workspacePath: "/workspace/demo" });
    const event = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: "s1",
      messageId: "mobile-first-command",
      context: {
        clientTimezone: "Asia/Shanghai",
        clientLanguage: "zh-CN",
        screenResolution: "390x844",
      },
      eventExtraDetail: {
        create_source: "session",
        client_kind: "mobile",
        workspace_kind: "remote",
        remote_kind: "ssh",
      },
    } as const;
    deliverPayload({ zcode_type: "telemetry-report", event });
    expect(reportRendererTelemetryEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it("logs mobile diagnostics as desktop log summaries", async () => {
    const { deliverPayload, logger, manager } = createManagerHarness();

    await manager.start({
      workspacePath: "/workspace/demo",
    });

    deliverPayload({
      zcode_type: "mobile-diagnostic",
      event: "socket-close",
      timestamp: 1710000000000,
      state: "reconnecting",
      closeCode: 1006,
      visibilityState: "visible",
      online: true,
    });

    expect(logger.info).toHaveBeenCalledWith(
      "[web-remote-control] mobile diagnostic",
      expect.objectContaining({
        event: "socket-close",
        closeCode: 1006,
        state: "reconnecting",
        visibilityState: "visible",
        online: true,
      }),
    );
  });

  it("keeps the dialog status target on the window workspace after mobile opens another workspace bridge", async () => {
    const { deliverPayload, manager, sentPayloads } = createManagerHarness();

    await manager.start({ workspacePath: "/workspace/z-code" });
    manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/z-code", label: "z-code", kind: "local" },
      { workspacePath: "/workspace/cgx-dev-web", label: "cgx-dev-web", kind: "local" },
    ]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-cgx",
      bridgeSessionId: "bridge-cgx",
      workspaceKey: "/workspace/cgx-dev-web",
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-cgx",
        }),
      ),
    );

    expect(manager.getStatus()).toMatchObject({
      status: "active",
      workspacePath: "/workspace/z-code",
    });
  });

  it("disposes the origin window's workspace host attachments when stopping the app runtime", async () => {
    const disposeWorkspaceHostAttachmentsForWindow = vi.fn();
    const { manager } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForWindow,
    });

    await manager.start({ workspacePath: "/workspace/demo" }, 1);
    await manager.suspend("manual-stop");

    expect(disposeWorkspaceHostAttachmentsForWindow).toHaveBeenCalledWith(1, "manual-stop");
  });

  it("disposes workspace host attachments when a remote session fails", async () => {
    const disposeWorkspaceHostAttachmentsForRemoteSession = vi.fn();
    const { deliverPayload, manager } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForRemoteSession,
    });

    await manager.start({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });
    manager.syncAvailableWorkspaces(1, [
      {
        workspacePath: "/workspace/demo",
        workspaceIdentity: "remote:ssh:host:/workspace/demo",
        remoteSessionId: "remote-session-1",
        label: "demo",
        kind: "remote",
      },
    ]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "remote:ssh:host:/workspace/demo",
    });
    await vi.waitFor(() => expect(manager.getStatus().status).toBe("active"));

    manager.failRemoteSession("remote-session-1", "remote-closed", {
      reason: "workspace-closed",
      message: "closed",
    });

    expect(disposeWorkspaceHostAttachmentsForRemoteSession).toHaveBeenCalledWith(
      "remote-session-1",
      "remote-closed",
    );
  });

  it("routes workspace bridge opens to the window that owns the workspace (App-level)", async () => {
    const attachWorkspaceHost = vi.fn(async (windowId: number) => ({
      entryId: `entry-${windowId}`,
      attachmentId: `attachment-${windowId}`,
      process: {} as never,
      port: createFakePort() as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({ attachWorkspaceHost });

    await manager.start({ workspacePath: "/workspace/origin" }, 1);
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    manager.syncAvailableWorkspaces(2, [remoteWorkspace]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-remote",
      bridgeSessionId: "bridge-remote",
      workspaceKey: remoteWorkspace.workspaceIdentity!,
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-remote",
        }),
      ),
    );
    expect(attachWorkspaceHost).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({ kind: "remote" }),
    );

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-local",
      bridgeSessionId: "bridge-local",
      workspaceKey: localWorkspace.workspacePath,
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-local",
        }),
      ),
    );
    expect(attachWorkspaceHost).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ kind: "local" }),
    );
  });

  it("prefers the focused window when a workspace is open in multiple windows", async () => {
    const attachWorkspaceHost = vi.fn(async (windowId: number) => ({
      entryId: `entry-${windowId}`,
      attachmentId: `attachment-${windowId}`,
      process: {} as never,
      port: createFakePort() as never,
    }));
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      attachWorkspaceHost,
      getFocusedWindowId: () => 2,
    });

    await manager.start({ workspacePath: "/workspace/origin" });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    manager.syncAvailableWorkspaces(2, [localWorkspace]);

    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-focused",
      bridgeSessionId: "bridge-focused",
      workspaceKey: localWorkspace.workspacePath,
    });
    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual(
        expect.objectContaining({ zcode_type: "workspace-bridge-ready" }),
      ),
    );
    expect(attachWorkspaceHost).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({ kind: "local" }),
    );
  });

  it("releases only the bridge owned by the disposed window", async () => {
    const releaseWorkspaceHostAttachment = vi.fn();
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      releaseWorkspaceHostAttachment,
    });

    await manager.start({ workspacePath: "/workspace/origin" });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    manager.syncAvailableWorkspaces(2, [remoteWorkspace]);
    deliverPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-remote",
      bridgeSessionId: "bridge-remote",
      workspaceKey: remoteWorkspace.workspaceIdentity!,
    });
    await vi.waitFor(() => expect(manager.getStatus()).toMatchObject({ status: "active" }));

    // 关闭另一个窗口不应影响当前 bridge。
    await manager.disposeWindow(1);
    expect(releaseWorkspaceHostAttachment).not.toHaveBeenCalled();
    expect(manager.getStatus()).toMatchObject({ status: "active" });

    sentPayloads.length = 0;
    await manager.disposeWindow(2);
    expect(releaseWorkspaceHostAttachment).toHaveBeenCalledWith("attachment-1");
    expect(sentPayloads).toContainEqual(
      expect.objectContaining({
        zcode_type: "workspace-bridge-error",
        bridgeSessionId: "bridge-remote",
        reason: "workspace-closed",
      }),
    );
    expect(manager.getStatus()).toMatchObject({ status: "running" });
  });

  it("forwards workspace reconnect requests to the window that owns the workspace", async () => {
    const reconnectWorkspace = vi.fn(async () => undefined);
    const { deliverPayload, manager, sentPayloads } = createManagerHarness({
      reconnectWorkspace,
    });

    await manager.start({ workspacePath: "/workspace/origin" });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    manager.syncAvailableWorkspaces(2, [
      { ...remoteWorkspace, connectionState: "disconnected", remoteSessionId: undefined },
    ]);

    deliverPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "reconnect-remote",
      workspaceKey: remoteWorkspace.workspaceIdentity!,
    });

    await vi.waitFor(() =>
      expect(sentPayloads).toContainEqual({
        zcode_type: "workspace-reconnect-response",
        requestId: "reconnect-remote",
        workspaceKey: remoteWorkspace.workspaceIdentity,
        success: true,
      }),
    );
    expect(reconnectWorkspace).toHaveBeenCalledWith(2, remoteWorkspace.workspaceIdentity);
  });

  it("pushes the aggregated workspace list after a window is disposed", async () => {
    const { manager, sentPayloads } = createManagerHarness();

    await manager.start({ workspacePath: "/workspace/origin" });
    manager.syncAvailableWorkspaces(1, [localWorkspace]);
    manager.syncAvailableWorkspaces(2, [remoteWorkspace]);
    sentPayloads.length = 0;

    await manager.disposeWindow(2);

    const updated = sentPayloads.find((payload) => payload.zcode_type === "workspace-list-updated");
    expect(updated).toEqual(
      expect.objectContaining({
        zcode_type: "workspace-list-updated",
        result: expect.objectContaining({
          workspaces: expect.arrayContaining([
            expect.objectContaining({ workspacePath: localWorkspace.workspacePath }),
          ]),
        }),
      }),
    );
    // 关闭的窗口快照被删除，聚合列表里不能再出现它独有的 remote workspace。
    expect(JSON.stringify(updated)).not.toContain(remoteWorkspace.workspaceIdentity);
  });

  it("disconnects the mobile client without stopping the app runtime", async () => {
    const { disconnectClientTransport, emitTransportState, manager } = createManagerHarness();

    await manager.start({ workspacePath: "/workspace/demo" });
    emitTransportState("paired");
    expect(manager.getStatus()).toMatchObject({ status: "active", mobileConnected: true });

    manager.disconnectRemoteClient();

    expect(disconnectClientTransport).toHaveBeenCalledOnce();
    expect(manager.getStatus()).toMatchObject({ status: "running", mobileConnected: false });
  });

  it("reports the app-level remote access status", async () => {
    const { manager } = createManagerHarness({
      remoteAccessEnabled: true,
      getGatewayConnectionStatus: () => ({ state: "online", backendId: "backend-1", epoch: 3 }),
    });

    await expect(manager.getRemoteAccessStatus()).resolves.toEqual({
      enabled: true,
      status: { status: "idle" },
      gateway: { state: "online", backendId: "backend-1", epoch: 3 },
    });

    await manager.start({ workspacePath: "/workspace/demo" });
    const status = await manager.getRemoteAccessStatus();
    expect(status.enabled).toBe(true);
    expect(status.status).toMatchObject({ status: "running" });
  });

  it("keeps the desktop relay session alive when a waiting remote workspace session closes", async () => {
    const disposeWorkspaceHostAttachmentsForRemoteSession = vi.fn();
    const { disposeTransport, manager, sentPayloads } = createManagerHarness({
      disposeWorkspaceHostAttachmentsForRemoteSession,
    });

    await manager.start({
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      remoteSessionId: "remote-session-1",
    });

    manager.failRemoteSession("remote-session-1", "remote-closed", {
      reason: "workspace-closed",
      message: "closed",
    });

    expect(manager.getStatus()).toMatchObject({
      status: "running",
      failure: undefined,
    });
    expect(disposeTransport).not.toHaveBeenCalled();
    expect(sentPayloads).not.toContainEqual(expect.objectContaining({ zcode_type: "app-error" }));
    expect(disposeWorkspaceHostAttachmentsForRemoteSession).toHaveBeenCalledWith(
      "remote-session-1",
      "remote-closed",
    );
  });
});
