// @vitest-environment jsdom
/**
 * F27 任务菜单「重启任务」项（docs/task-restart-and-reload.md，来源 a60ba6a7）。
 * 菜单动作链（确认框/restartTask）由 taskRestart.test.ts 的 useTaskRestart 组覆盖；
 * 这里只断言菜单项渲染、门禁与回调。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";

function StubItem({
  children,
  disabled,
  onSelect,
  "data-testid": testId,
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  "data-testid"?: string;
  title?: string;
}) {
  return createElement(
    "div",
    {
      role: "menuitem",
      "data-testid": testId,
      "aria-disabled": disabled ? "true" : undefined,
      title,
      onClick: disabled ? undefined : onSelect,
    },
    children,
  );
}

function StubSeparator() {
  return createElement("div", { "data-testid": "menu-separator" });
}

function mountMenu(params: {
  onRestartTask?: () => void;
  restartPending?: boolean;
  disableTaskActions?: boolean;
}) {
  const intl = { formatMessage: ({ id }: { id: string }) => id };
  return render(
    createElement(TaskActionMenuContent, {
      intl: intl as never,
      isPinned: false,
      fileManagerLabel: "打开所在目录",
      taskSessionFile: { loading: false, path: "/tmp/a.json", exists: true },
      activeSessionId: "task-a",
      taskNativeSessionLogFile: { loading: false, path: "/tmp/a.log", exists: true },
      providerConfigFile: { loading: false, path: "/tmp/conf", exists: true },
      disableTaskActions: params.disableTaskActions ?? false,
      Item: StubItem,
      Separator: StubSeparator,
      onTogglePinTask: vi.fn(),
      onStartRenameTask: vi.fn(),
      onArchiveTask: vi.fn(),
      onMarkTaskAsUnread: vi.fn(),
      ...(params.onRestartTask ? { onRestartTask: params.onRestartTask } : {}),
      restartPending: params.restartPending ?? false,
      onOpenTaskPathInFileManager: vi.fn(),
      onCopyWorkspacePath: vi.fn(),
      onCopyTaskPath: vi.fn(),
      onCopyTaskLogPath: vi.fn(),
      onOpenProviderConfig: vi.fn(),
    }),
  );
}

afterEach(() => {
  cleanup();
});

describe("TaskActionMenuContent 重启任务项（F27）", () => {
  it("提供 onRestartTask 时渲染「重启任务」并触发回调", () => {
    const onRestartTask = vi.fn();
    mountMenu({ onRestartTask });

    const item = screen.getByTestId("task-restart");
    expect(item.textContent).toBe("taskList.restart");
    fireEvent.click(item);
    expect(onRestartTask).toHaveBeenCalledTimes(1);
  });

  it("未提供 onRestartTask 时不渲染该菜单项（既有调用方不受影响）", () => {
    mountMenu({});
    expect(screen.queryByTestId("task-restart")).toBeNull();
  });

  it("restartPending 或 disableTaskActions 时禁用并显示「正在重启任务…」", () => {
    const onRestartTask = vi.fn();
    mountMenu({ onRestartTask, restartPending: true });
    expect(screen.getByTestId("task-restart").textContent).toBe("taskList.restarting");
    expect(screen.getByTestId("task-restart").getAttribute("aria-disabled")).toBe("true");

    cleanup();
    mountMenu({ onRestartTask, disableTaskActions: true, restartPending: false });
    expect(screen.getByTestId("task-restart").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("task-restart"));
    expect(onRestartTask).not.toHaveBeenCalled();
  });
});
