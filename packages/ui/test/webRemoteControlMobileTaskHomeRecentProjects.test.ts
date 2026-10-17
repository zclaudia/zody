// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebRemoteControlWorkspaceListResult } from "@zcode/shared";
import { WebRemoteControlMobileTaskHome } from "@/WebRemoteControlMobileTaskHome.js";

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
  activeWorkspaceKey: "/workspace/demo",
  workspaces: [{ workspacePath: "/workspace/demo", label: "Demo", kind: "local" }],
  tasks: [],
};

function renderHome() {
  return render(
    createElement(WebRemoteControlMobileTaskHome, {
      activeTaskId: null,
      activeWorkspacePath: "/workspace/demo",
      initialResult: workspaceList,
      preferences: { organizeBy: "workspace", sortBy: "updated" },
      onPreferencesChange: () => {},
      switcher: {
        listWorkspaces: async () => workspaceList,
        switchWorkspace: async () => {},
        getRecentProjects: async () => ({
          desktopWindowState: "none",
          recentProjects: [{ id: "recent-1", label: "zcode", location: "/Users/dev/SourceCode" }],
        }),
        onRecentProjectsUpdated: () => () => {},
        openRecentProject: vi.fn(async () => "/workspace/zcode"),
        openDesktopWindow: vi.fn(async () => {}),
        onOpenSettings: vi.fn(),
      },
    }),
  );
}

afterEach(() => cleanup());

describe("mobile task home recent projects (T4.2)", () => {
  it("renders the recent projects section and no-window empty state", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    renderHome();

    expect(screen.getByText("webRemoteControl.mobileHome.recentProjects")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("zcode")).toBeTruthy());
    expect(screen.getByText("webRemoteControl.mobileStart.noWindowTitle")).toBeTruthy();
    expect(screen.getByText("webRemoteControl.mobileStart.openWindow").className).toContain("h-11");
  });
});
