import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
  },
}));

async function importDirectoryBrowserModule() {
  return (await import("../src/DirectoryBrowser.js")) as unknown as {
    DirectoryBrowser: typeof import("../src/DirectoryBrowser.js").DirectoryBrowser;
    createDirectoryBrowserReadParams: (
      path: string,
      showHiddenDirectories: boolean,
    ) => { path: string; includeHidden?: boolean };
    createDirectoryBrowserRequestGuard: () => {
      begin: () => number;
      isCurrent: (requestId: number) => boolean;
    };
    getDirectoryBrowserEntryIconKind: (entry: {
      type: "directory" | "file";
      isSymbolicLink?: boolean;
    }) => "folder" | "folder-symlink";
    getDirectoryBrowserParentPath: (path: string) => string | null;
    filterDirectoryBrowserEntries: (
      entries: Array<{
        name: string;
        path: string;
        type: "directory" | "file";
        isSymbolicLink?: boolean;
      }>,
    ) => Array<{
      name: string;
      path: string;
      type: "directory" | "file";
      isSymbolicLink?: boolean;
    }>;
  };
}

async function renderDirectoryBrowser(embedded = false) {
  const { DirectoryBrowser } = await importDirectoryBrowserModule();

  return renderToStaticMarkup(
    createElement(DirectoryBrowser, {
      services: {
        fileService: {
          readdir: vi.fn(async () => []),
        },
        systemService: {
          info: vi.fn(async () => ({ homedir: "/Users/tester" })),
        },
      } as never,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      embedded,
    }),
  );
}

describe("DirectoryBrowser", () => {
  it("renders the hidden directory toggle", async () => {
    const html = await renderDirectoryBrowser(true);

    expect(html).toContain("directoryBrowser.showHidden");
  });

  it("renders a select action in non-embedded mode", async () => {
    const html = await renderDirectoryBrowser();

    expect(html).toContain("directoryBrowser.selectDir");
  });

  it("leaves the select action to the parent in embedded mode", async () => {
    const html = await renderDirectoryBrowser(true);

    expect(html).not.toContain("directoryBrowser.selectDir");
  });

  it("does not request hidden entries by default", async () => {
    const { createDirectoryBrowserReadParams } = await importDirectoryBrowserModule();

    expect(createDirectoryBrowserReadParams("/root", false)).toEqual({
      path: "/root",
    });
  });

  it("requests hidden entries when the toggle is enabled", async () => {
    const { createDirectoryBrowserReadParams } = await importDirectoryBrowserModule();

    expect(createDirectoryBrowserReadParams("/root", true)).toEqual({
      path: "/root",
      includeHidden: true,
    });
  });

  it("marks older directory reads as stale after a newer navigation starts", async () => {
    const { createDirectoryBrowserRequestGuard } = await importDirectoryBrowserModule();
    const guard = createDirectoryBrowserRequestGuard();

    const firstRequestId = guard.begin();
    const secondRequestId = guard.begin();

    expect(guard.isCurrent(firstRequestId)).toBe(false);
    expect(guard.isCurrent(secondRequestId)).toBe(true);
  });

  it("keeps hidden directories returned by the service but still filters files", async () => {
    const { filterDirectoryBrowserEntries } = await importDirectoryBrowserModule();

    expect(
      filterDirectoryBrowserEntries([
        { name: ".ssh", path: "/root/.ssh", type: "directory" },
        { name: ".bashrc", path: "/root/.bashrc", type: "file" },
        { name: "project", path: "/root/project", type: "directory" },
      ]),
    ).toEqual([
      { name: ".ssh", path: "/root/.ssh", type: "directory" },
      { name: "project", path: "/root/project", type: "directory" },
    ]);
  });

  it("uses a symlink folder icon kind for directory symlinks", async () => {
    const { getDirectoryBrowserEntryIconKind } = await importDirectoryBrowserModule();

    expect(
      getDirectoryBrowserEntryIconKind({
        type: "directory",
        isSymbolicLink: true,
      }),
    ).toBe("folder-symlink");
    expect(
      getDirectoryBrowserEntryIconKind({
        type: "directory",
      }),
    ).toBe("folder");
  });

  // searchfile-1：旧实现只认 "/" 分隔符，Windows 远控路径下「..」按钮点了没反应。
  it("resolves parent paths for POSIX directories（searchfile-1）", async () => {
    const { getDirectoryBrowserParentPath } = await importDirectoryBrowserModule();

    expect(getDirectoryBrowserParentPath("/Users/tester/repos/zody")).toBe("/Users/tester/repos");
    expect(getDirectoryBrowserParentPath("/Users/tester/repos")).toBe("/Users/tester");
    expect(getDirectoryBrowserParentPath("/Users/tester")).toBe("/Users");
    expect(getDirectoryBrowserParentPath("/Users")).toBe("/");
    expect(getDirectoryBrowserParentPath("/")).toBeNull();
    expect(getDirectoryBrowserParentPath("")).toBeNull();
    // 尾部分隔符不影响父级提取。
    expect(getDirectoryBrowserParentPath("/Users/tester/")).toBe("/Users");
  });

  it("resolves parent paths for Windows directories incl. drive roots（searchfile-1）", async () => {
    const { getDirectoryBrowserParentPath } = await importDirectoryBrowserModule();

    expect(getDirectoryBrowserParentPath("C:\\Users\\tester\\repos")).toBe("C:\\Users\\tester");
    expect(getDirectoryBrowserParentPath("C:\\Users\\tester")).toBe("C:\\Users");
    expect(getDirectoryBrowserParentPath("C:\\Users")).toBe("C:\\");
    // 盘根没有上级：不再回退到原路径（旧实现会原地踏步）。
    expect(getDirectoryBrowserParentPath("C:\\")).toBeNull();
    // 正斜杠的 Windows 盘符路径同样支持。
    expect(getDirectoryBrowserParentPath("C:/Users/tester")).toBe("C:/Users");
    expect(getDirectoryBrowserParentPath("C:/")).toBeNull();
  });

  it("keeps desktop autofocus and adds touch-scoped hit/font adjustments", async () => {
    const { DirectoryBrowser } = await importDirectoryBrowserModule();

    // 无 window（SSR/桌面基线）：保持 autoFocus 与 text-ui-base，桌面渲染不变。
    const desktopHtml = renderToStaticMarkup(
      createElement(DirectoryBrowser, {
        services: {
          fileService: { readdir: vi.fn(async () => []) },
          systemService: { info: vi.fn(async () => ({ homedir: "/Users/tester" })) },
        } as never,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(desktopHtml).toContain("autofocus");
    expect(desktopHtml).not.toContain("text-mobile-input-safe");

    // 触屏态（hover:none + pointer:coarse）：不自动聚焦（避免软键盘遮住目录列表），
    // 输入框用 16px 的 text-mobile-input-safe，按钮命中区抬到 ≥44px。
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
      }),
    });
    try {
      const touchHtml = renderToStaticMarkup(
        createElement(DirectoryBrowser, {
          services: {
            fileService: { readdir: vi.fn(async () => []) },
            systemService: { info: vi.fn(async () => ({ homedir: "/Users/tester" })) },
          } as never,
          onSelect: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
      expect(touchHtml).not.toContain("autofocus");
      expect(touchHtml).toContain("text-mobile-input-safe");
      expect(touchHtml).toContain("[@media(hover:none)_and_(pointer:coarse)]:h-11");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
