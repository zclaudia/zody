import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebRemoteControlAppPayload,
  WebRemoteControlRecentProjectTarget,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import {
  createWebRemoteControlManager,
  WEB_REMOTE_CONTROL_WORKSPACE_OPEN_TIMEOUT_MS,
} from "../src/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";
import { createRemoteWorkspaceDirectory } from "../src/main/remote-access/remoteWorkspaceDirectory.js";
import { createWebRemoteControlRecentProjectsRegistry } from "../src/main/remote-access/recentProjects.js";

const demoWorkspace: WebRemoteControlWorkspaceTarget = {
  workspacePath: "/workspace/demo",
  label: "demo",
  kind: "local",
};

function createHarness(
  options: {
    recentProjects?: string[];
    hasOpenWindow?: boolean;
    canCreateWindow?: () => boolean;
    ensurePrimaryWindow?: () => Promise<void>;
    openWorkspacePath?: (workspacePath: string) => boolean;
  } = {},
) {
  const sentPayloads: WebRemoteControlAppPayload[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let recentProjects = options.recentProjects ?? [];
  let hasOpenWindow = options.hasOpenWindow ?? true;
  let deliverPayload: ((payload: WebRemoteControlAppPayload) => void) | undefined;

  const canCreateWindow = vi.fn(options.canCreateWindow ?? (() => true));
  const ensurePrimaryWindow = vi.fn(options.ensurePrimaryWindow ?? (async () => {}));
  const openWorkspacePath = vi.fn(options.openWorkspacePath ?? (() => true));
  const remoteWorkspaceDirectory = createRemoteWorkspaceDirectory();

  const manager = createWebRemoteControlManager({
    relayWsUrl: "ws://relay.test/ws",
    mobileRemoteControlUrl: "https://example.test/remote/v3",
    deviceMid: "mid-1",
    deviceName: "MacBook",
    appVersion: "1.5.0",
    authProvider: {
      createPassword: () => "password",
      createPassHash: () => "hash-1",
      calculateProof: () => "proof",
    },
    authStorageProvider: {
      load: async () => undefined,
      save: async () => {},
      clear: async () => {},
      rotate: async () => {},
    },
    remoteAccessSettings: {
      isEnabled: async () => true,
      setEnabled: async () => {},
    },
    featureGate: createWebRemoteControlFeatureGate(),
    remoteWorkspaceDirectory,
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
    getRecentProjects: async () => recentProjects,
    hasOpenWindow: () => hasOpenWindow,
    canCreateWindow,
    ensurePrimaryWindow,
    openWorkspacePath,
    reconnectWorkspace: async () => {},
    attachWorkspaceHost: async () => {
      throw new Error("本测试不建立 bridge");
    },
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
    createDeviceTransport: (transportOptions) => ({
      start: () => {
        deliverPayload = transportOptions.onPayload;
        if (transportOptions.auth.mode === "register") {
          transportOptions.onRegisteredAuth({ deviceSid: "sid-1", passHash: "hash-1" });
        }
        transportOptions.onStateChange("waiting_terminal");
      },
      sendPayload: (payload) => {
        sentPayloads.push(payload);
        return true;
      },
      measurePayloadBytes: (payload) => JSON.stringify(payload).length,
      sendPayloadResult: (payload) => {
        sentPayloads.push(payload);
        return { kind: "sent" as const, bytes: JSON.stringify(payload).length };
      },
      dispose: vi.fn(),
    }),
  });

  return {
    canCreateWindow,
    ensurePrimaryWindow,
    logger,
    manager,
    openWorkspacePath,
    sentPayloads,
    setRecentProjects: (paths: string[]) => {
      recentProjects = paths;
    },
    setHasOpenWindow: (open: boolean) => {
      hasOpenWindow = open;
    },
    deliver: (payload: WebRemoteControlAppPayload) => {
      if (!deliverPayload) {
        throw new Error("transport not started");
      }
      deliverPayload(payload);
    },
  };
}

async function startHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  // 启动上下文本身也是一个已打开的 workspace；用一个不在最近项目里的路径，
  // 避免把待测的最近项目误判为「已打开」。
  await harness.manager.start({ workspacePath: "/workspace/current" });
  harness.sentPayloads.length = 0;
}

function findPayload<T extends WebRemoteControlAppPayload["zcode_type"]>(
  payloads: WebRemoteControlAppPayload[],
  zcodeType: T,
): Extract<WebRemoteControlAppPayload, { zcode_type: T }> | undefined {
  return payloads.find(
    (payload): payload is Extract<WebRemoteControlAppPayload, { zcode_type: T }> =>
      payload.zcode_type === zcodeType,
  );
}

describe("recent projects registry", () => {
  it("同一路径在会话内保持稳定 id，移除后 id 失效，且 id 不携带路径", () => {
    const registry = createWebRemoteControlRecentProjectsRegistry();
    const first = registry.buildResult({
      paths: ["/workspace/demo"],
      openWorkspacePaths: new Set(),
      desktopWindowState: "open",
    });
    const second = registry.buildResult({
      paths: ["/workspace/demo"],
      openWorkspacePaths: new Set(),
      desktopWindowState: "open",
    });

    const firstProject = first.recentProjects[0]!;
    expect(second.recentProjects[0]!.id).toBe(firstProject.id);
    expect(firstProject).toEqual({ id: firstProject.id, label: "demo", location: "/workspace" });
    expect(firstProject.id).not.toContain("/workspace");
    expect(registry.resolvePath(firstProject.id)).toBe("/workspace/demo");

    const afterRemoval = registry.buildResult({
      paths: [],
      openWorkspacePaths: new Set(),
      desktopWindowState: "open",
    });
    expect(afterRemoval.recentProjects).toEqual([]);
    expect(registry.resolvePath(firstProject.id)).toBeUndefined();
  });

  it("已打开项目与重复路径都不进列表", () => {
    const registry = createWebRemoteControlRecentProjectsRegistry();
    const result = registry.buildResult({
      paths: ["/workspace/demo", "/workspace/demo", "/workspace/open", "", "   "],
      openWorkspacePaths: new Set(["/workspace/open"]),
      desktopWindowState: "none",
    });

    expect(result.recentProjects.map((project) => project.label)).toEqual(["demo"]);
    expect(result.desktopWindowState).toBe("none");
  });
});

describe("webRemoteControlManager recent projects", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bootstrap 下发未打开项目的最近项目与窗口状态，id 是会话内不透明标识", async () => {
    const harness = createHarness({
      recentProjects: ["/workspace/demo", "/workspace/other", "/workspace/open"],
    });
    await startHarness(harness);
    harness.manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/open", label: "open", kind: "local" },
    ]);

    harness.deliver({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" });
    const response = findPayload(harness.sentPayloads, "bootstrap-response");
    expect(response).toBeDefined();
    expect(response?.result.desktopWindowState).toBe("open");
    const projects: WebRemoteControlRecentProjectTarget[] = response?.result.recentProjects ?? [];
    expect(projects.map((project) => project.label).sort()).toEqual(["demo", "other"]);
    for (const project of projects) {
      expect(project.location).toBe("/workspace");
      expect(project.id).not.toBe("/workspace/demo");
      expect(project.id).not.toContain("/workspace");
    }
  });

  it("workspace-open-request 只接受当前列表里的 id；路径字符串与未知 id 都被拒绝", async () => {
    const harness = createHarness({ recentProjects: ["/workspace/demo"] });
    await startHarness(harness);

    harness.deliver({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" });
    const response = findPayload(harness.sentPayloads, "bootstrap-response");
    const recentProject = response?.result.recentProjects?.[0];
    expect(recentProject).toBeDefined();

    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-path",
      recentProjectId: "/workspace/demo",
    });
    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-unknown",
      recentProjectId: "not-a-known-id",
    });
    await vi.waitFor(() => {
      const responses = harness.sentPayloads.filter(
        (payload) => payload.zcode_type === "workspace-open-response",
      );
      expect(responses).toHaveLength(2);
      for (const item of responses) {
        expect(item).toMatchObject({ success: false });
      }
    });
    expect(harness.openWorkspacePath).not.toHaveBeenCalled();

    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-demo",
      recentProjectId: recentProject!.id,
    });
    await vi.waitFor(() =>
      expect(harness.openWorkspacePath).toHaveBeenCalledWith("/workspace/demo"),
    );

    // 成功判定：该 workspace 出现在聚合列表里。
    harness.manager.syncAvailableWorkspaces(1, [demoWorkspace]);
    await vi.waitFor(() => {
      expect(
        harness.sentPayloads.find(
          (payload) =>
            payload.zcode_type === "workspace-open-response" && payload.requestId === "open-demo",
        ),
      ).toEqual({
        zcode_type: "workspace-open-response",
        requestId: "open-demo",
        success: true,
        workspaceKey: "/workspace/demo",
      });
    });
  });

  it("打开项目超过 10 秒仍未出现在聚合列表时返回失败", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ recentProjects: ["/workspace/demo"] });
    await startHarness(harness);
    harness.deliver({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" });
    const id = findPayload(harness.sentPayloads, "bootstrap-response")?.result.recentProjects?.[0]
      ?.id;
    expect(id).toBeDefined();

    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-timeout",
      recentProjectId: id!,
    });
    // fake timers 下用 advance(0) 排空微任务，避免 vi.waitFor 依赖真实定时器。
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.openWorkspacePath).toHaveBeenCalledWith("/workspace/demo");
    await vi.advanceTimersByTimeAsync(WEB_REMOTE_CONTROL_WORKSPACE_OPEN_TIMEOUT_MS);

    expect(
      harness.sentPayloads.find(
        (payload) =>
          payload.zcode_type === "workspace-open-response" && payload.requestId === "open-timeout",
      ),
    ).toMatchObject({ success: false, error: expect.stringContaining("10 seconds") });
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it('没有窗口时先 ensurePrimaryWindow("remote-control")；canCreateWindow 阻断时直接失败', async () => {
    const harness = createHarness({
      recentProjects: ["/workspace/demo"],
      hasOpenWindow: false,
    });
    await startHarness(harness);
    harness.deliver({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" });
    const id = findPayload(harness.sentPayloads, "bootstrap-response")?.result.recentProjects?.[0]
      ?.id;

    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-demo",
      recentProjectId: id!,
    });
    await vi.waitFor(() =>
      expect(harness.ensurePrimaryWindow).toHaveBeenCalledWith("remote-control"),
    );
    expect(harness.openWorkspacePath).toHaveBeenCalledWith("/workspace/demo");

    // 新请求：gate 阻断后不再 ensure/open。
    harness.ensurePrimaryWindow.mockClear();
    harness.openWorkspacePath.mockClear();
    harness.canCreateWindow.mockReturnValue(false);
    harness.deliver({
      zcode_type: "workspace-open-request",
      requestId: "open-blocked",
      recentProjectId: id!,
    });
    await vi.waitFor(() => {
      expect(
        harness.sentPayloads.find(
          (payload) =>
            payload.zcode_type === "workspace-open-response" &&
            payload.requestId === "open-blocked",
        ),
      ).toMatchObject({ success: false });
    });
    expect(harness.ensurePrimaryWindow).not.toHaveBeenCalled();
    expect(harness.openWorkspacePath).not.toHaveBeenCalled();
  });

  it("desktop-window-open-request 走 ensurePrimaryWindow 并返回成功；gate 阻断时失败", async () => {
    const harness = createHarness();
    await startHarness(harness);

    harness.deliver({ zcode_type: "desktop-window-open-request", requestId: "window-1" });
    await vi.waitFor(() => {
      expect(
        harness.sentPayloads.find(
          (payload) =>
            payload.zcode_type === "desktop-window-open-response" &&
            payload.requestId === "window-1",
        ),
      ).toEqual({
        zcode_type: "desktop-window-open-response",
        requestId: "window-1",
        success: true,
      });
    });
    expect(harness.ensurePrimaryWindow).toHaveBeenCalledWith("remote-control");

    harness.canCreateWindow.mockReturnValue(false);
    harness.deliver({ zcode_type: "desktop-window-open-request", requestId: "window-2" });
    await vi.waitFor(() => {
      expect(
        harness.sentPayloads.find(
          (payload) =>
            payload.zcode_type === "desktop-window-open-response" &&
            payload.requestId === "window-2",
        ),
      ).toMatchObject({ success: false });
    });
  });

  it("recent-projects-updated 按签名去重，设置变化后推送新快照", async () => {
    const harness = createHarness({ recentProjects: ["/workspace/demo"] });
    await startHarness(harness);

    harness.manager.syncAvailableWorkspaces(1, []);
    await vi.waitFor(() =>
      expect(findPayload(harness.sentPayloads, "recent-projects-updated")).toBeDefined(),
    );
    const firstPush = findPayload(harness.sentPayloads, "recent-projects-updated");
    expect(firstPush?.result.recentProjects.map((project) => project.label)).toEqual(["demo"]);

    harness.sentPayloads.length = 0;
    harness.manager.syncAvailableWorkspaces(1, []);
    await Promise.resolve();
    await Promise.resolve();
    expect(findPayload(harness.sentPayloads, "recent-projects-updated")).toBeUndefined();

    harness.setRecentProjects(["/workspace/other"]);
    harness.manager.notifyRecentProjectsChanged();
    await vi.waitFor(() => {
      const pushed = findPayload(harness.sentPayloads, "recent-projects-updated");
      expect(pushed?.result.recentProjects.map((project) => project.label)).toEqual(["other"]);
    });
  });

  it("窗口关闭导致 desktopWindowState 变为 none 时推送新快照", async () => {
    const harness = createHarness({ recentProjects: ["/workspace/demo"], hasOpenWindow: true });
    await startHarness(harness);
    harness.deliver({ zcode_type: "bootstrap-request", requestId: "bootstrap-1" });
    expect(findPayload(harness.sentPayloads, "bootstrap-response")?.result.desktopWindowState).toBe(
      "open",
    );

    harness.sentPayloads.length = 0;
    harness.setHasOpenWindow(false);
    await harness.manager.disposeWindow(7);

    await vi.waitFor(() => {
      const pushed = findPayload(harness.sentPayloads, "recent-projects-updated");
      expect(pushed?.result.desktopWindowState).toBe("none");
      expect(pushed?.result.recentProjects).toHaveLength(1);
    });
  });
});
