// @vitest-environment jsdom

import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebRemoteControlWorkspaceListResult } from "@zody/shared";
import {
  WebRemoteControlMobileTaskHome,
  resetWebRemoteControlMobileTaskHomeExpandedWorkspaceKeysForTests,
} from "@/WebRemoteControlMobileTaskHome.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    selector: (state: { theme: string; setTheme: (theme: string) => void }) => unknown,
  ) => selector({ theme: "dark", setTheme: vi.fn() }),
}));

const workspaceList: WebRemoteControlWorkspaceListResult = {
  activeTaskId: "remote-task",
  activeWorkspaceKey: "ssh://dev/workspace/remote",
  workspaces: [
    {
      workspacePath: "/workspace/local",
      label: "Local App",
      kind: "local",
    },
    {
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://dev/workspace/remote",
      remoteSessionId: "remote-session",
      label: "Remote App",
      kind: "remote",
    },
  ],
  tasks: [
    {
      taskId: "remote-task",
      title: "Remote task",
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://dev/workspace/remote",
      remoteSessionId: "remote-session",
      workspaceLabel: "Remote App",
      workspaceKind: "remote",
      createdAt: 1,
      updatedAt: 20,
      provider: "codex",
      displayStatus: "running",
    },
    {
      taskId: "local-task",
      title: "Local task",
      workspacePath: "/workspace/local",
      workspaceLabel: "Local App",
      workspaceKind: "local",
      createdAt: 1,
      updatedAt: 10,
      displayStatus: "completed",
    },
  ],
};

const disconnectedWorkspaceList: WebRemoteControlWorkspaceListResult = {
  activeWorkspaceKey: "/workspace/remote",
  workspaces: [
    {
      workspacePath: "/workspace/remote",
      workspaceIdentity: "ssh://dev/workspace/remote",
      label: "Remote App",
      kind: "remote",
      connectionState: "disconnected",
      lastConnectionError: "ssh closed",
    },
  ],
  tasks: [],
};

const defaultPreferences = {
  organizeBy: "workspace" as const,
  sortBy: "updated" as const,
};

function createSwitcher(overrides: Record<string, unknown> = {}) {
  return {
    listWorkspaces: vi.fn(async () => workspaceList),
    switchWorkspace: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderHome({
  initialResult = workspaceList,
  preferences = defaultPreferences,
  switcherOverrides = {},
  onOpenFiles,
}: {
  initialResult?: WebRemoteControlWorkspaceListResult;
  preferences?: { organizeBy: "workspace" | "timeline"; sortBy: "created" | "updated" };
  switcherOverrides?: Record<string, unknown>;
  onOpenFiles?: (workspaceKey: string) => void;
} = {}) {
  return render(
    createElement(WebRemoteControlMobileTaskHome, {
      activeTaskId: "remote-task",
      activeWorkspacePath: "/workspace/remote",
      activeWorkspaceIdentity: "ssh://dev/workspace/remote",
      initialResult,
      preferences,
      onPreferencesChange: () => {},
      onOpenFiles,
      switcher: createSwitcher(switcherOverrides),
    }),
  );
}

/** 按 workspace 路径定位卡片根节点（路径只出现在卡片头部的路径行里）。 */
function findCard(workspacePath: string) {
  const path = screen.getByText(workspacePath);
  return path.closest("li") as HTMLLIElement;
}

beforeEach(() => {
  resetWebRemoteControlMobileTaskHomeExpandedWorkspaceKeysForTests();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
});

afterEach(() => {
  cleanup();
  resetWebRemoteControlMobileTaskHomeExpandedWorkspaceKeysForTests();
});

describe("WebRemoteControlMobileTaskHome workspace 卡头重构（touch-1/shell-2/design-2/home-1）", () => {
  it("workspace 卡只渲染一个「打开文件」按钮，且不在展开按钮内部；点击它不再连带展开/收起", () => {
    const onOpenFiles = vi.fn();
    renderHome({ onOpenFiles });

    const card = findCard("/workspace/local");
    const expandButton = card.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    // 修复前：标题行内嵌一个 + 兄弟位置一个 = 两个相同图标按钮，且嵌套 button 是无效 HTML。
    const fileButtons = within(card).getAllByRole("button", {
      name: "mobileFileBrowser.title",
    });
    expect(fileButtons).toHaveLength(1);
    expect(expandButton.contains(fileButtons[0]!)).toBe(false);

    fireEvent.click(fileButtons[0]!);
    expect(onOpenFiles).toHaveBeenCalledWith("/workspace/local");
    // 点击文件按钮只打开文件浮层，不触发外层展开/收起。
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandButton);
    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
  });

  it("手动展开/收起的 workspace 卡在卸载重挂载后保留（进入聊天页再返回不重置）", () => {
    // shell-4：Shell 在进入聊天页时会整体卸载任务首页组件；
    // expandedWorkspaceKeys 的所有者是模块级 store，重挂载后从所有者恢复。
    const first = renderHome();
    const expandButton = findCard("/workspace/local").querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    fireEvent.click(expandButton);
    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
    first.unmount();

    const second = renderHome();
    const remountedExpandButton = findCard("/workspace/local").querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    expect(remountedExpandButton.getAttribute("aria-expanded")).toBe("true");

    // 显式收起同样跨挂载保留（用户的选择不被默认展开规则覆盖）。
    fireEvent.click(remountedExpandButton);
    expect(remountedExpandButton.getAttribute("aria-expanded")).toBe("false");
    second.unmount();

    renderHome();
    const finalExpandButton = findCard("/workspace/local").querySelector(
      "button[aria-expanded]",
    ) as HTMLButtonElement;
    expect(finalExpandButton.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("WebRemoteControlMobileTaskHome 触控目标（home-3/home-6/touch-4/touch-5）", () => {
  it("新建任务与打开文件按钮具备可访问名称且命中区扩到 44px", () => {
    renderHome({ onOpenFiles: vi.fn() });

    const newTaskButton = within(findCard("/workspace/remote")).getByRole("button", {
      name: "sidebar.newTask",
    });
    expect(newTaskButton.className).toContain("size-11");

    const fileButton = within(findCard("/workspace/remote")).getByRole("button", {
      name: "mobileFileBrowser.title",
    });
    expect(fileButton.className).toContain("size-11");
  });

  it("断连 workspace 的重连按钮具备可访问名称且命中区扩到 44px", () => {
    renderHome({
      initialResult: disconnectedWorkspaceList,
      switcherOverrides: { reconnectWorkspace: vi.fn(async () => {}) },
    });

    // 断连卡的重连按钮以 aria-label 提供名称（原先只有 sr-only 文本 + 24px 命中区）。
    const reconnectButton = within(findCard("/workspace/remote")).getByRole("button", {
      name: "webRemoteControl.mobileHome.reconnect",
    });
    expect(reconnectButton.className).toContain("size-11");
  });

  it("列表工具行三个按钮与主题菜单触发器命中区扩到 44px", () => {
    renderHome();

    for (const name of [
      "webRemoteControl.mobileHome.collapseAll",
      "webRemoteControl.mobileHome.organize",
      "webRemoteControl.mobileHome.refresh",
      "webRemoteControl.themeMenu.trigger",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toContain("size-11");
    }
  });
});

describe("WebRemoteControlMobileTaskHome token 与字号（design-7/home-8）", () => {
  it("卡片聚合未读点走语义 brand token，不再使用 raw sky 色板", () => {
    const unreadList: WebRemoteControlWorkspaceListResult = {
      ...workspaceList,
      tasks: workspaceList.tasks.map((task) =>
        task.taskId === "local-task" ? { ...task, unreadAt: 123 } : task,
      ),
    };
    const { container } = renderHome({ initialResult: unreadList });

    const indicator = container.querySelector("[data-workspace-unread-indicator]")!;
    expect(indicator.className).toContain("bg-brand");
    expect(indicator.className).not.toContain("bg-sky-");
    expect(container.innerHTML).not.toContain("bg-sky-500");
    expect(container.innerHTML).not.toContain("bg-sky-400");
  });

  it("时间线任务行内的未读点同样迁移到 brand token", () => {
    const unreadList: WebRemoteControlWorkspaceListResult = {
      ...workspaceList,
      tasks: workspaceList.tasks.map((task) =>
        task.taskId === "local-task" ? { ...task, unreadAt: 123 } : task,
      ),
    };
    const { container } = renderHome({
      initialResult: unreadList,
      preferences: { organizeBy: "timeline", sortBy: "updated" },
    });

    const rowDots = container.querySelectorAll("span.h-1\\.5.w-1\\.5.bg-brand");
    expect(rowDots.length).toBeGreaterThan(0);
    expect(container.innerHTML).not.toContain("bg-sky-500");
    expect(container.innerHTML).not.toContain("bg-sky-400");
  });

  it("卡片路径与任务行副行降为 text-ui-sm 元信息字号", () => {
    renderHome();

    const path = findCard("/workspace/remote").querySelector("span.font-mono") as HTMLElement;
    expect(path.className).toContain("text-ui-sm");
    expect(path.className).not.toContain("text-ui-base");

    const taskButton = screen.getByTestId("task-item-remote-task");
    expect(taskButton.textContent).toContain("Remote task");
    expect(taskButton.innerHTML).toContain("text-ui-sm");
  });
});

describe("home-9 打开最近项目的行内错误反馈", () => {
  it("打开最近项目失败在对应行内反馈，不再只渲染全局错误条", async () => {
    renderHome({
      switcherOverrides: {
        getRecentProjects: async () => ({
          desktopWindowState: "open" as const,
          recentProjects: [{ id: "recent-1", label: "zcode", location: "/Users/dev/SourceCode" }],
        }),
        onRecentProjectsUpdated: () => () => {},
        openRecentProject: vi.fn(async () => {
          throw new Error("desktop offline");
        }),
      },
    });

    const row = await screen.findByText("zcode");
    fireEvent.click(row);

    // 错误出现在被点击的行内（role=alert），且不再渲染全局 <p> 错误条。
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe("desktop offline");
      expect(alert.closest("button")).toBe(row.closest("button"));
    });
  });
});

describe("WebRemoteControlThemeMenu 触发器 className 透传", () => {
  it("触发器保持 icon-sm 变体，命中区类由调用方透传", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlThemeMenu.tsx"),
      "utf8",
    );
    // 触发器内部尺寸不变大（icon-sm），命中区由调用方 className 提供。
    expect(source).toContain('size="icon-sm"');
    expect(source).toContain("className={className}");

    const { container } = render(createElement(WebRemoteControlThemeMenu, { className: "size-11" }));
    const trigger = container.querySelector(
      'button[aria-label="webRemoteControl.themeMenu.trigger"]',
    ) as HTMLButtonElement;
    // twMerge 保证调用方类覆盖 icon-sm 的默认 size-6。
    expect(trigger.className).toContain("size-11");
    expect(trigger.className).not.toContain("size-6");
  });

  it("主题菜单选项行抬升到 44px 触屏高度", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlThemeMenu.tsx"),
      "utf8",
    );
    expect(source).toContain('className="min-h-11"');
  });
});

describe("perf-4 memo 化结构", () => {
  it("任务行与 workspace 卡抽取为 memo 组件，最近项目区 memo 化", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlMobileTaskHome.tsx"),
      "utf8",
    );
    expect(source).toContain("memo(function MobileTaskRow");
    expect(source).toContain("memo(function MobileWorkspaceCard");

    const recentProjectsSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WebRemoteControlRecentProjects.tsx"),
      "utf8",
    );
    expect(recentProjectsSource).toContain(
      "export const WebRemoteControlRecentProjectsSection = memo(",
    );
  });
});
