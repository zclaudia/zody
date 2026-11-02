// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodePermissionRequest } from "@zody/shared";
import { PermissionDialog } from "../src/PermissionDialog.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

// jsdom 没有 ResizeObserver，PermissionDialog 内的工具调用块（ExecuteCommand）会用到。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});


const WORKSPACE_PATH = "/Users/dev/ZCodeProject/demo";
const TOUCH_MEDIA_MARKER = "(hover: none)";
const TOUCH_HIDDEN_CLASS = "[@media(hover:none)_and_(pointer:coarse)]:hidden";

function stubMatchMedia(matchesTouchViewport: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: matchesTouchViewport && query.includes(TOUCH_MEDIA_MARKER),
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

function createFeedbackRequest(): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-feedback-enter",
    traceId: "trace-feedback-enter",
    requestId: "request-feedback-enter",
    description: "Run ls",
    kind: "Bash",
    freeText: true,
    options: [
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
    raw: { command: "ls" },
  } as ZCodePermissionRequest;
}

function renderFeedbackDialog(onRespond: () => void) {
  const Dialog = PermissionDialog as unknown as React.ComponentType<Record<string, unknown>>;
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(Dialog, {
        request: createFeedbackRequest(),
        onRespond,
        workspacePath: WORKSPACE_PATH,
      }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PermissionDialog 手机反馈输入（keyboard-4 / dialogs-5）", () => {
  it("手机触屏视口：反馈 textarea 的 Enter 不提交，换行留给软键盘，提交走按钮", () => {
    stubMatchMedia(true);
    const onRespond = vi.fn();
    const { container } = renderFeedbackDialog(onRespond);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    fireEvent.change(textarea!, { target: { value: "第一行反馈" } });
    fireEvent.keyDown(textarea!, { key: "Enter" });

    expect(onRespond).not.toHaveBeenCalled();
  });

  it("桌面视口：Enter 仍然提交反馈，既有快捷键不变", () => {
    stubMatchMedia(false);
    const onRespond = vi.fn();
    const { container } = renderFeedbackDialog(onRespond);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    fireEvent.change(textarea!, { target: { value: "拒绝理由" } });
    fireEvent.keyDown(textarea!, { key: "Enter" });

    expect(onRespond).toHaveBeenCalledTimes(1);
    // submitFeedback 传的是 Deny 选项对象 + 反馈文案。
    expect(onRespond).toHaveBeenCalledWith(
      "request-feedback-enter",
      expect.objectContaining({ optionId: "deny" }),
      "拒绝理由",
    );
  });

  it("桌面键盘提示在触屏态隐藏（dialogs-5）", () => {
    stubMatchMedia(false);
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(PermissionDialog as unknown as React.ComponentType<Record<string, unknown>>, {
          request: createFeedbackRequest(),
          onRespond: () => {},
          workspacePath: WORKSPACE_PATH,
        }),
      ),
    );
    // 提示文案仍在 DOM（桌面渲染不变），但携带触屏 hidden 类。
    expect(html).toContain("使用 Tab / 上下键选择，回车确认");
    expect(html).toContain(TOUCH_HIDDEN_CLASS);
  });
});
