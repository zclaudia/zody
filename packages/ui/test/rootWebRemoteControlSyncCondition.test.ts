// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type { WindowTabState } from "@/store/tabStore.js";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";

/**
 * T2.2：renderer 的远控快照同步条件从「本窗口远控会话 running/active」改为「远程访问开关打开」，
 * 并且必须等到「标签页恢复完成」（hasCompletedFullTabRestore）之后才发布（方案「App 级聚合与路由 · 同步条件」）。
 * 这里用真实渲染覆盖三种组合，并确认「无远控会话时只推送已连接的远程 workspace」的行为保留。
 */

type HookProps = Parameters<typeof useRootPlatformEffects>[0];

function createPlatform() {
  return {
    onFocusTab: vi.fn(() => () => {}),
    onNewTab: vi.fn(() => () => {}),
    onNewTask: vi.fn(() => () => {}),
    onOpenWorkspace: vi.fn(() => () => {}),
    onTaskNotificationClick: vi.fn(() => () => {}),
    syncWindowTabs: vi.fn(),
    syncWebRemoteControlWorkspaces: vi.fn(),
    syncWindowUnreadCount: vi.fn(),
    syncActiveTaskSession: vi.fn(),
    setApplicationLocale: vi.fn(async () => {}),
  };
}

type PlatformMock = ReturnType<typeof createPlatform>;

function createTab(overrides: Partial<Extract<WindowTabState, { kind: "workspace" }>>) {
  return {
    id: overrides.id ?? "tab-1",
    kind: "workspace" as const,
    label: overrides.label ?? "demo",
    workspacePath: overrides.workspacePath ?? "/workspace/demo",
    workspaceIdentity: overrides.workspaceIdentity,
    workspacePurpose: overrides.workspacePurpose,
    remoteSessionId: overrides.remoteSessionId,
    remoteTarget: overrides.remoteTarget,
  } satisfies Extract<WindowTabState, { kind: "workspace" }>;
}

const localTab = createTab({ id: "local", label: "Local", workspacePath: "/workspace/local" });
const connectedRemoteTab = createTab({
  id: "remote",
  label: "Remote",
  workspacePath: "/workspace/remote",
  workspaceIdentity: "remote:ssh:host:/workspace/remote",
  remoteSessionId: "remote-session-1",
  remoteTarget: { kind: "ssh", host: "host", username: "root" },
});

function renderEffects({
  platform,
  tabs,
  remoteAccessEnabled,
  hasCompletedFullTabRestore,
}: {
  platform: PlatformMock;
  tabs: WindowTabState[];
  remoteAccessEnabled: boolean;
  hasCompletedFullTabRestore: boolean;
}) {
  const props = {
    addTab: vi.fn(),
    setIsBootstrappingInitialWorkspace: vi.fn(),
    platform: platform as unknown as IPlatformService,
    activateTabByPath: vi.fn(() => true),
    startDraftInWorkspace: vi.fn(),
    startNewTaskFromActiveWorkspace: vi.fn(),
    openWorkspace: vi.fn(),
    openWorkspacePath: vi.fn(),
    setWorkspaceActionError: vi.fn(),
    isDesktop: true,
    locale: "zh-CN" as never,
    tabs,
    totalUnreadTaskCount: 0,
    webRemoteAccessEnabled: remoteAccessEnabled,
    hasCompletedFullTabRestore,
    intl: { formatMessage: () => "" } as never,
    isRestoringOAuthSession: false,
    canBootstrapInitialWorkspace: false,
  } satisfies HookProps;

  return renderHook((hookProps: HookProps) => useRootPlatformEffects(hookProps), {
    initialProps: props,
  });
}

// tab store 只作为「当前激活的 tab」来源参与本 hook；用最小替身避免为单一断言搭建 TabStoreProvider。
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { tabs: WindowTabState[]; activeTabId: string | null }) => unknown) =>
    selector({ tabs: [], activeTabId: null }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => null,
}));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useRootPlatformEffects 远控快照同步条件", () => {
  it("远程访问开关打开且标签页恢复完成后，本窗口同步整份 workspace 目标", () => {
    const platform = createPlatform();
    renderEffects({
      platform,
      tabs: [localTab, connectedRemoteTab],
      remoteAccessEnabled: true,
      hasCompletedFullTabRestore: true,
    });

    expect(platform.syncWindowTabs).toHaveBeenCalledWith([localTab.workspacePath]);
    expect(platform.syncWebRemoteControlWorkspaces).toHaveBeenLastCalledWith([
      { workspacePath: "/workspace/local", label: "Local", kind: "local" },
      {
        workspacePath: "/workspace/remote",
        label: "Remote",
        kind: "remote",
        connectionState: "connected",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        remoteSessionId: "remote-session-1",
      },
    ]);
  });

  it("开关关闭时只推送已连接的远程 workspace（Bot 绑定路径保留），不推送整份快照", () => {
    const platform = createPlatform();
    renderEffects({
      platform,
      tabs: [localTab, connectedRemoteTab],
      remoteAccessEnabled: false,
      hasCompletedFullTabRestore: true,
    });

    expect(platform.syncWebRemoteControlWorkspaces).toHaveBeenCalledTimes(1);
    expect(platform.syncWebRemoteControlWorkspaces).toHaveBeenCalledWith([
      {
        workspacePath: "/workspace/remote",
        label: "Remote",
        kind: "remote",
        connectionState: "connected",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        remoteSessionId: "remote-session-1",
      },
    ]);
  });

  it("开关关闭且没有已连接的远程 workspace 时完全不推送", () => {
    const platform = createPlatform();
    renderEffects({
      platform,
      tabs: [localTab],
      remoteAccessEnabled: false,
      hasCompletedFullTabRestore: true,
    });

    expect(platform.syncWebRemoteControlWorkspaces).not.toHaveBeenCalled();
  });

  it("标签页恢复完成前不发布：整份快照和窗口标签都不上报", () => {
    const platform = createPlatform();
    renderEffects({
      platform,
      tabs: [localTab, connectedRemoteTab],
      remoteAccessEnabled: true,
      hasCompletedFullTabRestore: false,
    });

    expect(platform.syncWindowTabs).not.toHaveBeenCalled();
    expect(platform.syncWebRemoteControlWorkspaces).not.toHaveBeenCalled();
  });

  it("开关打开且窗口没有标签页时推送空列表，Main 据此整份替换本窗口快照", () => {
    const platform = createPlatform();
    renderEffects({
      platform,
      tabs: [],
      remoteAccessEnabled: true,
      hasCompletedFullTabRestore: true,
    });

    expect(platform.syncWebRemoteControlWorkspaces).toHaveBeenCalledTimes(1);
    expect(platform.syncWebRemoteControlWorkspaces).toHaveBeenCalledWith([]);
  });
});
