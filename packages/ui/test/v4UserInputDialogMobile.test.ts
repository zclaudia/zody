// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_USER_INPUT_DIALOG, TID_V4_USER_INPUT_OPTION, testId } from "@zcode/shared";
import { V4UserInputDialog } from "../src/v4/V4UserInputDialog.js";
import type { V4UserInputViewModel } from "../src/v4/pendingInteractionAdapter.js";

const TOUCH_MEDIA_CLASS_MIN_H = "[@media(hover:none)_and_(pointer:coarse)]:min-h-11";
// matchMedia 查询串里带空格（"(hover: none)"）；class 字符串里不带空格，由完整类常量断言。
const TOUCH_QUERY_MARKER = "(hover: none)";

function stubMatchMedia(matchesTouchViewport: boolean) {
  // jsdom 的 matchMedia 恒为 false；这里按 mobileTextInput 的查询内核返回可控结果。
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: matchesTouchViewport && query.includes(TOUCH_QUERY_MARKER),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  );
}

function createModel(overrides: Partial<V4UserInputViewModel> = {}): V4UserInputViewModel {
  return {
    interactionId: "interaction-1",
    prompt: "请输入访问令牌",
    freeText: true,
    options: [
      { optionId: "retry", label: "重试" },
      { optionId: "cancel", label: "取消" },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("V4UserInputDialog 手机适配（dialogs-1 / keyboard-2）", () => {
  it("手机触屏视口：输入框用 16px text-mobile-input-safe，桌面不附加", () => {
    stubMatchMedia(true);
    const mobileHtml = renderToStaticMarkup(
      createElement(V4UserInputDialog, {
        model: createModel(),
        onSubmit: () => {},
      }),
    );
    expect(mobileHtml).toContain("text-mobile-input-safe");

    stubMatchMedia(false);
    const desktopHtml = renderToStaticMarkup(
      createElement(V4UserInputDialog, {
        model: createModel(),
        onSubmit: () => {},
      }),
    );
    expect(desktopHtml).not.toContain("text-mobile-input-safe");
  });

  it("弹窗限高并内部滚动，底部消费键盘 inset 工具类", () => {
    stubMatchMedia(true);
    render(
      createElement(V4UserInputDialog, {
        model: createModel(),
        onSubmit: () => {},
      }),
    );

    const dialog = screen.getByTestId(TID_V4_USER_INPUT_DIALOG);
    // 卡片：max-h + 内部滚动（dialogs-1：选项多/键盘弹起时内容不再溢出且可滚动）。
    const card = dialog.querySelector(".max-h-full.overflow-y-auto");
    expect(card).not.toBeNull();
    // 键盘避让占位消费 .zcode-keyboard-inset-bottom（spec D2，iOS 键盘弹起时顶起居中区域）。
    const keyboardSpacer = dialog.querySelector(".zcode-keyboard-inset-bottom");
    expect(keyboardSpacer).not.toBeNull();
  });

  it("选项与提交按钮带触屏态 ≥44px 命中区类，且类限定在触屏 media 内", () => {
    // 触控类是静态 media 作用域（桌面永不生效），因此桌面 HTML 也会包含类字符串；
    // 这里断言命中区类挂在选项/提交按钮上且带 (hover:none) media 前缀，桌面密度由 media 保证。
    stubMatchMedia(true);
    render(
      createElement(V4UserInputDialog, {
        model: createModel(),
        onSubmit: () => {},
      }),
    );
    const option = screen.getByTestId(testId(TID_V4_USER_INPUT_OPTION, "retry"));
    expect(option.className).toContain(TOUCH_MEDIA_CLASS_MIN_H);

    const submit = screen.getByText("提交").closest("button");
    expect(submit).not.toBeNull();
    expect(submit!.className).toContain(TOUCH_MEDIA_CLASS_MIN_H);
  });
});
