import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ElicitationDialog } from "../src/ElicitationDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import type { ZCodeElicitationRequest } from "@zody/shared";

const TOUCH_SIZE_11 = "[@media(hover:none)_and_(pointer:coarse)]:size-11";
const TOUCH_MIN_H_11 = "[@media(hover:none)_and_(pointer:coarse)]:min-h-11";
const TOUCH_HIDDEN = "[@media(hover:none)_and_(pointer:coarse)]:hidden";

function createMultiQuestionRequest(): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "run-1",
    requestId: "request-1",
    message: "请选择方案",
    options: [],
    questions: [
      {
        question: "请选择方案",
        header: "方案",
        options: [
          { value: "fast", label: "快速" },
          { value: "safe", label: "稳妥" },
        ],
      },
      {
        question: "请选择保障项",
        header: "保障项",
        options: [
          { value: "tests", label: "测试" },
          { value: "docs", label: "文档" },
        ],
      },
    ],
  } as ZCodeElicitationRequest;
}

function renderDialog(props: Record<string, unknown>): string {
  const Dialog = ElicitationDialog as ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(Dialog, {
        request: createMultiQuestionRequest(),
        onRespond: () => {},
        ...props,
      }),
    ),
  );
}

describe("ElicitationDialog 触控目标（dialogs-3 / dialogs-5）", () => {
  it("最后一分钟倒计时按钮在触屏态命中区 ≥44×44px（spec D1）", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(940_001);
    try {
      const html = renderDialog({
        autoResolution: {
          state: "visibleCountdown",
          startedAt: 700_000,
          visibleAt: 760_000,
          deadlineAt: 1_000_000,
        },
        onFirstInteraction: () => {},
      });
      expect(html).toContain('data-elicitation-countdown-seconds="59"');
      expect(html).toContain(TOUCH_MIN_H_11);
      expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-w-11");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("翻题/折叠图标按钮在触屏态命中区 ≥44×44px（spec D1）", () => {
    const html = renderDialog({});
    // 上一题 / 下一题 / 折叠态展开按钮都带触屏 size-11。
    expect(html).toContain(`aria-label="上一题"`);
    expect(html).toContain(`aria-label="下一题"`);
    const size11Count = html.split(TOUCH_SIZE_11).length - 1;
    expect(size11Count).toBeGreaterThanOrEqual(3);
  });

  it("桌面键盘提示在触屏态隐藏（dialogs-5）", () => {
    const html = renderDialog({});
    expect(html).toContain("使用 Tab / 上下键选择，回车或空格选中");
    expect(html).toContain(TOUCH_HIDDEN);
  });
});
