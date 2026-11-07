// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileApplicationInfo, IPlatformService } from "@zody/shared";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { OpenSplitButton } from "../src/OpenSplitButton.js";

// F16 OpenSplitButton 扩展（upstream v3.17.1 renderCard，来源 SHA a60ba6a7）：
// 本机文件按格式打开以系统关联为唯一事实源，空结果回退静态编辑器菜单（裁决 4，
// docs/ui/file-open-apps.md 共存章节）；renderCard 让整卡与按钮共用同一动作（I15）。
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZodyIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useFileContextActions.js", () => ({
  useFileContextActions: () => ({
    copyAbsolutePath: vi.fn(async () => true),
    copyRelativePath: vi.fn(async () => true),
  }),
}));
vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({ remoteTarget: undefined, isRemoteWorkspace: false }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => null,
  useServices: () => {
    throw new Error("not needed in this test");
  },
}));

function buildPlatform(options: {
  applications?: FileApplicationInfo[];
  editors?: { id: string; name: string; iconDataUrl: string }[];
  openFileWithApplication?: IPlatformService["openFileWithApplication"];
}) {
  return {
    getInstalledEditors: vi.fn(async () => options.editors ?? []),
    getFileApplications: vi.fn(async () => options.applications ?? []),
    openFileWithApplication:
      options.openFileWithApplication ?? vi.fn(async () => ({ success: true })),
    openExternal: vi.fn(),
    openInEditor: vi.fn(async () => ({ success: true })),
  } as never;
}

function renderButton(
  platform: IPlatformService,
  props: Partial<Parameters<typeof OpenSplitButton>[0]> = {},
) {
  return render(
    createElement(
      PlatformProvider,
      { platform },
      createElement(OpenSplitButton, {
        target: {
          type: "file",
          path: "/workspace/产品 报告.docx",
          title: "产品 报告.docx",
          label: "产品 报告.docx",
          previewSource: {
            type: "file",
            title: "产品 报告.docx",
            path: "/workspace/产品 报告.docx",
          },
        },
        onOpenCodeViewer: props.onOpenCodeViewer ?? vi.fn(),
        ...props,
      }),
    ),
  );
}

function pointerStubs() {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => {} },
    setPointerCapture: { configurable: true, value: () => {} },
    scrollIntoView: { configurable: true, value: () => {} },
  });
}

function openDropdown() {
  const trigger = screen.getByRole("button", { name: "appHeader.selectOpenApp" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OpenSplitButton 系统关联优先与静态菜单回退（裁决 4）", () => {
  it("系统关联非空时菜单只展示系统关联应用，不出现静态编辑器", async () => {
    pointerStubs();
    const platform = buildPlatform({
      applications: [
        { id: "sys-default", name: "WPS Office", isDefault: true },
        { id: "sys-other", name: "Pages", isDefault: false },
      ],
      editors: [{ id: "vscode", name: "VS Code", iconDataUrl: "" }],
    });
    renderButton(platform);
    openDropdown();
    // 默认项渲染为“用 {application} 打开”；非默认项显示应用名。
    await waitFor(() => expect(screen.getByText("fileActions.openInApplication")).toBeTruthy());
    expect(screen.getByText("Pages")).toBeTruthy();
    expect(screen.queryByText("VS Code")).toBeNull();
    expect((platform.getFileApplications as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      path: "/workspace/产品 报告.docx",
      pathKind: "file",
      workspaceIdentity: undefined,
    });
  });

  it("系统关联为空时回退静态编辑器菜单", async () => {
    pointerStubs();
    const platform = buildPlatform({
      applications: [],
      editors: [{ id: "vscode", name: "VS Code", iconDataUrl: "" }],
    });
    renderButton(platform);
    openDropdown();
    await waitFor(() => expect(screen.getByText("VS Code")).toBeTruthy());
    expect(screen.queryByText("fileActions.openInApplication")).toBeNull();
  });

  it("选择系统应用经 renderer 分发 id+target", async () => {
    pointerStubs();
    const openFileWithApplication = vi.fn(async () => ({ success: true }));
    const platform = buildPlatform({
      applications: [{ id: "sys-other", name: "Pages", isDefault: false }],
      openFileWithApplication,
    });
    renderButton(platform);
    openDropdown();
    const item = await screen.findByText("Pages");
    fireEvent.click(item);
    await waitFor(() =>
      expect(openFileWithApplication).toHaveBeenCalledWith("sys-other", {
        path: "/workspace/产品 报告.docx",
        pathKind: "file",
        workspaceIdentity: undefined,
      }),
    );
  });

  it("下拉提供另存为入口", async () => {
    pointerStubs();
    const platform = buildPlatform({ applications: [] });
    renderButton(platform);
    openDropdown();
    expect(await screen.findByText("fileActions.saveAs")).toBeTruthy();
  });
});

describe("OpenSplitButton renderCard 与 I15 整卡打开", () => {
  it("整卡点击与主按钮执行同一预览动作且各只触发一次", async () => {
    const onOpenCodeViewer = vi.fn();
    const platform = buildPlatform({ applications: [] });
    render(
      createElement(
        PlatformProvider,
        { platform },
        createElement(OpenSplitButton, {
          target: {
            type: "file",
            path: "/workspace/报告.pdf",
            title: "报告.pdf",
            label: "报告.pdf",
          },
          onOpenCodeViewer,
          renderCard: (button, { handlePreview, canPreview }) =>
            createElement(
              "div",
              { "data-preview-card-title": "报告.pdf" },
              createElement(
                "button",
                {
                  type: "button",
                  "aria-label": "card-body",
                  disabled: !canPreview,
                  onClick: handlePreview,
                },
                "card body",
              ),
              button,
            ),
        }),
      ),
    );
    // 主按钮与整卡各点一次，分别触发一次预览，不会双触发。
    fireEvent.click(screen.getByRole("button", { name: "common.open" }));
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "card-body" }));
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(2);
  });
});
