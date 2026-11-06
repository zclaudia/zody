// @vitest-environment jsdom
// 「会话页可读性」批次：触屏（hover:none）作用域下的可发现性与命中区修复。
// 覆盖走查发现 chat-1 / chat-2 / chat-5 / chat-7；chat-3 / chat-4 在
// v4ConversationStatusPanel.test.ts 中就近扩展。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CopyIcon } from "lucide-react";
import { ToolSummaryRow } from "@/ToolCallBlocks/ToolSummaryRow.js";
import {
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { Collapsible } from "@/components/ui/collapsible.js";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/store/StoreProvider.js", () => ({
  useZodyStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "zai-light",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => null,
  useOptionalPlatform: () => null,
}));

function renderToolSummaryRow(isExpanded: boolean) {
  return renderToStaticMarkup(
    createElement(
      Collapsible,
      { open: isExpanded },
      createElement(ToolSummaryRow, {
        animateContent: false,
        canToggle: true,
        contentKey: "content-key",
        disableContentAnimation: true,
        forceOpen: false,
        icon: null,
        isExpanded,
        kindLabel: "Bash",
        kindLabelClassName: "",
        primaryText: "pnpm vitest run",
        showIcon: false,
        toggleAriaLabel: "toggle tool detail",
        toolId: "tool-1",
      }),
    ),
  );
}

function renderReasoningTrigger(defaultOpen: boolean) {
  return renderToStaticMarkup(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        Reasoning,
        { defaultOpen },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, "先分析，再回答。"),
      ),
    ),
  );
}

describe("触屏（hover:none）作用域的会话页可发现性与命中区", () => {
  // chat-1：手机没有 hover，折叠的工具调用行过去完全看不到展开箭头，工具详情入口不可发现。
  it("折叠工具调用行在触屏常显展开箭头，桌面仍由 hover 揭示", () => {
    const collapsedHtml = renderToolSummaryRow(false);

    expect(collapsedHtml).toContain("rotate-0");
    expect(collapsedHtml).toContain("[@media(hover:none)]:opacity-100");
    // 桌面形态不变：默认隐藏、hover 揭示。
    expect(collapsedHtml).toContain("opacity-0");
    expect(collapsedHtml).toContain("group-hover/tool-summary:opacity-100");

    const expandedHtml = renderToolSummaryRow(true);
    expect(expandedHtml).toContain("rotate-90");
    expect(expandedHtml).toContain("opacity-100");
  });

  // chat-2：思考行折叠态在触屏上没有任何箭头提示，无法发现思考过程可点开。
  it("折叠思考行在触屏常显箭头，桌面仍由 hover 揭示", () => {
    const collapsedHtml = renderReasoningTrigger(false);

    expect(collapsedHtml).toContain("[@media(hover:none)]:opacity-100");
    expect(collapsedHtml).toContain("opacity-0");
    expect(collapsedHtml).toContain("group-hover/reasoning:opacity-100");

    const expandedHtml = renderReasoningTrigger(true);
    expect(expandedHtml).toContain("rotate-90");
  });

  // chat-5：消息操作按钮触屏命中区 ≥44×44（size-11），视觉图标与桌面（icon-sm = size-6）一致。
  // 命中区作用域按 D1 §1 统一为 (hover: none) and (pointer: coarse)。
  it("MessageAction 在触屏把图标按钮命中区抬到 44px，桌面保持 24px", () => {
    const html = renderToStaticMarkup(
      createElement(
        MessageActions,
        null,
        createElement(
          MessageAction,
          { "aria-label": "复制", label: "复制" },
          createElement(CopyIcon),
        ),
      ),
    );

    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
    // 桌面 icon-sm 盒不变。
    expect(html).toContain("size-6");

    // 非图标尺寸（文本按钮）不套用固定 44px 方盒，避免压宽文本。
    const textButtonHtml = renderToStaticMarkup(
      createElement(MessageAction, { label: "动作", size: "sm" }, "动作"),
    );
    expect(textButtonHtml).not.toContain("[@media(hover:none)_and_(pointer:coarse)]:size-11");
  });

  // chat-7：长无断点 token 过去撑破正文容器，被时间线 overflow-x-hidden 裁掉且无横向滚动。
  it("assistant markdown 正常渲染容器带 wrap-anywhere 断行兜底", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZodyIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          MessageResponse,
          { onOpenExternalUrl: vi.fn(), theme: "zai-light" },
          "正文段落",
        ),
      ),
    );

    // 兜底挂在 Streamdown 正常渲染容器上（与桌面共用同一排版管线）。
    expect(html).toMatch(/class="[^"]*leading-\[1\.75\][^"]*wrap-anywhere[^"]*"/u);
    expect(html).toContain("正文段落");
  });
});
