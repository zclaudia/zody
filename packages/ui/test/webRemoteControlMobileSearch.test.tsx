// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// 只断言本批次的呈现行为（键盘动作键、find-highlight 高亮、长 token 折行、触控命中区），
// 搜索状态机由 useMobileHistorySearch 的既有测试覆盖，这里整只替换为轻量 stub。
vi.mock("@/hooks/useMobileHistorySearch.js", () => ({
  useMobileHistorySearch: () => ({
    query: "fix",
    setQuery: vi.fn(),
    submittedQuery: "fix",
    includeArchived: false,
    setIncludeArchived: vi.fn(),
    isSearching: false,
    items: [
      {
        workspaceKey: "ws-key",
        task: {
          taskId: "task-1",
          title: "fix: login crash at https://example.com/very/long/url-path",
          workspacePath: "/repo",
        },
        snippets: ["stack at commit 0123456789abcdef0123456789abcdef01234567 parser crashed"],
      },
    ],
    outcomes: [],
    retryingScopes: [],
    retryScope: vi.fn(),
    runSearch: vi.fn(),
    showMore: vi.fn(),
    canShowMore: false,
    limit: 50,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

import { WebRemoteControlMobileSearch } from "../src/WebRemoteControlMobileSearch.js";

function renderSearch() {
  return render(
    createElement(WebRemoteControlMobileSearch, {
      workspaces: [],
      connection: { backendId: "backend", connectionGeneration: 1 },
      send: vi.fn(async () => {
        throw new Error("not used");
      }),
      createRequestId: () => "request-1",
      onSelectTask: vi.fn(),
      onBack: vi.fn(),
    }),
  );
}

describe("WebRemoteControlMobileSearch（键盘/高亮/折行/触控）", () => {
  afterEach(() => cleanup());

  it("keyboard-5: 搜索输入声明 inputMode/enterKeyHint，键盘动作键显示为「搜索」", () => {
    const { container } = renderSearch();

    const input = screen.getByRole("textbox");
    expect(input.getAttribute("inputmode")).toBe("search");
    expect(input.getAttribute("enterkeyhint")).toBe("search");
    // 输入框继续使用 16px 的 iOS 防缩放 token（既有行为不回退）。
    expect(input.className).toContain("text-mobile-input-safe");
    expect(container).toBeTruthy();
  });

  it("searchfile-10: 命中高亮 <mark> 使用 find-highlight 语义 token，不用浏览器默认亮黄", () => {
    const { container } = renderSearch();

    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.className).toContain("bg-find-highlight");
    expect(mark?.className).toContain("text-foreground");
    expect(mark?.textContent).toBe("fix");
  });

  it("viewport-5: 标题与 snippet 使用 break-all，长无空格 token 折行不产生横向滚动", () => {
    const { container } = renderSearch();

    // 标题（含高亮 mark 的 span）与 snippet span 都带 break-all。
    const mark = container.querySelector("mark");
    expect(mark?.parentElement?.className).toContain("break-all");
    const snippet = container.querySelector("span.break-all.text-ui-sm");
    expect(snippet?.className).toContain("break-all");
  });

  it("touch-8: 返回按钮触屏态命中区抬到 ≥44px，桌面类名不变", () => {
    const { container } = renderSearch();

    const backButton = screen.getByRole("button", { name: "mobileSearch.back" });
    expect(backButton.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:h-11");
    expect(backButton.className).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-w-11");
    expect(container).toBeTruthy();
  });
});
