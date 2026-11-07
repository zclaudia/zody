// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// I15 整卡打开（upstream v3.17.1，SHA a60ba6a7）：卡片主体与主按钮执行同一预览
// 动作；契约见 docs/ui/assistant-preview-cards.md「Whole-card open (I15)」。
// 这里 mock 校验投影，只考察行渲染与整卡点击合同。
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
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  // 必须返回稳定引用：校验结果的 fileService 比较按对象身份判断。
  const fileService = {};
  return { useWorkspaceServices: () => ({ fileService }) };
});
vi.mock("@/lib/assistantPreviewCardValidation.js", () => ({
  getAssistantPreviewCardsValidationSignature: (cards: unknown[]) => JSON.stringify(cards),
  resolveAssistantPreviewCardsWithoutFileStat: () => null,
  resolveValidatedAssistantPreviewCards: async (cards: unknown[]) => cards,
}));

const { AssistantPreviewCards, buildAssistantPreviewCardFileSource } =
  await import("../src/AssistantPreviewCards.js");
const { PlatformProvider } = await import("../src/hooks/usePlatform.js");

const TEST_PLATFORM = {
  getInstalledEditors: vi.fn(async () => []),
  getFileApplications: vi.fn(async () => []),
  openFileWithApplication: vi.fn(async () => ({ success: true })),
  openExternal: vi.fn(),
  openInEditor: vi.fn(async () => ({ success: true })),
} as never;

function renderCards(props: Record<string, unknown>) {
  return render(
    createElement(
      PlatformProvider,
      { platform: TEST_PLATFORM },
      createElement(AssistantPreviewCards, props as never),
    ),
  );
}

const PDF_CARD = {
  id: "file:pdf:/workspace/审计 报告.pdf",
  type: "file" as const,
  kind: "pdf" as const,
  title: "审计 报告.pdf",
  subtitleId: "chat.previewCards.pdf" as const,
  path: "/workspace/审计 报告.pdf",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AssistantPreviewCards I15 整卡打开", () => {
  it("整卡透明按钮与主按钮执行同一预览动作，各点击一次不双触发", async () => {
    const onOpenCodeViewer = vi.fn();
    renderCards({
      cards: [PDF_CARD],
      workspacePath: "/workspace",
      onOpenCodeViewer,
    });
    const titleNode = await screen.findByText("审计 报告.pdf");
    const card = titleNode.closest("div[data-preview-card-title]");
    expect(card).toBeTruthy();
    expect(card!.getAttribute("data-preview-card-title")).toBe("审计 报告.pdf");
    // 主按钮与整卡各一次。
    fireEvent.click(screen.getByRole("button", { name: "common.open" }));
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "chat.previewCards.openCard" }));
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(2);
    // 整卡动作与主按钮目标一致（同一 file source）。
    expect(onOpenCodeViewer).toHaveBeenLastCalledWith(
      buildAssistantPreviewCardFileSource(PDF_CARD, { workspacePath: "/workspace" }),
    );
  });

  it("无预览处理器时整卡透明按钮 disabled 不可点", async () => {
    renderCards({
      cards: [PDF_CARD],
      workspacePath: "/workspace",
    });
    const wholeCard = (await screen.findByRole("button", {
      name: "chat.previewCards.openCard",
    })) as HTMLButtonElement;
    expect(wholeCard.disabled).toBe(true);
    fireEvent.click(wholeCard);
    // 主按钮同样保持禁用，没有任何预览动作被触发。
    const primary = screen.getByRole("button", { name: "common.open" }) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
  });
});
