// @vitest-environment jsdom
// CUA macOS「App 内确认弹窗」UI 侧测试（specs/computer-use-macos-phase1.md
// 「2026-10-31 App 内确认弹窗替代 Helper 原生 NSAlert」UI 侧合同，含 2026-10-31
// 用户修订的「遵循既有权限策略」）：固定 toolName cua_screenshot_confirm 的 permission
// 请求在 PermissionDialog 中专门展示标题「屏幕截图确认」与目标身份；选项集与普通工具
// 一致（allow_once 保留「允许本次截图」专用文案 + allow_always 项目规则 + deny），
// 跟随通用反馈输入行为；默认动作与 Esc 仍为拒绝。
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodyPermissionOption, ZodyPermissionRequest } from "@zody/shared";
import { PermissionDialog } from "../src/PermissionDialog.js";
import { ZodyIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  getCuaScreenshotConfirmOptionLabelMessageId,
  getCuaScreenshotConfirmTarget,
  isCuaScreenshotConfirmRequest,
} from "../src/lib/permissionRequest.js";

const WORKSPACE_PATH = "/Users/dev/ZCodeProject/demo";
const CUA_REASON = "Screenshot TextEdit window";

/** v4 投影后的标准选项集：allowOnce + allowAlways（项目规则）+ deny。 */
function standardCuaScreenshotConfirmOptions(): ZodyPermissionOption[] {
  return [
    {
      optionId: "allowOnce",
      kind: "allowOnce",
      name: "Allow once",
      response: { decision: "allow" },
    },
    {
      optionId: "allowAlways",
      kind: "allowAlways",
      name: "Always allow in this project",
      response: {
        decision: "allow",
        permissionUpdates: [
          {
            behavior: "allow",
            rules: [{ toolName: "cua_screenshot_confirm" }],
            type: "addRules",
          },
        ],
      },
    },
    {
      optionId: "deny",
      kind: "deny",
      name: "Deny",
      response: { decision: "deny" },
    },
  ];
}

function createCuaScreenshotConfirmRequest(
  overrides: Partial<ZodyPermissionRequest> = {},
): ZodyPermissionRequest {
  return {
    type: "permission_request",
    taskId: "task-cua-confirm",
    traceId: "trace-cua-confirm",
    requestId: "request-cua-confirm",
    description: CUA_REASON,
    kind: "cua_screenshot_confirm",
    title: "cua_screenshot_confirm",
    options: standardCuaScreenshotConfirmOptions(),
    raw: {
      requestId: "request-cua-confirm",
      toolCallId: "run-19065",
      toolName: "cua_screenshot_confirm",
      reason: CUA_REASON,
      riskLevel: "high",
      input: {
        target: {
          pid: 40077,
          windowId: 89384,
          ownerName: "TextEdit",
          windowName: "Untitled.txt",
        },
      },
    },
    ...overrides,
  };
}

function installAnimationFrameController() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId;
    nextFrameId += 1;
    callbacks.set(frameId, callback);
    return frameId;
  });
  const cancelAnimationFrame = vi.fn((frameId: number) => {
    callbacks.delete(frameId);
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

  return {
    flush() {
      const pendingCallbacks = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pendingCallbacks) {
        callback(performance.now());
      }
    },
  };
}

function renderPermissionDialog(
  request: ZodyPermissionRequest,
  onRespond: (requestId: string, option: ZodyPermissionOption) => void,
) {
  const animationFrame = installAnimationFrameController();
  const view = render(
    createElement(
      ZodyIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(PermissionDialog, {
        request,
        onRespond,
        workspacePath: WORKSPACE_PATH,
      }),
    ),
  );
  const flush = () => act(() => animationFrame.flush());
  flush();
  return { ...view, flush, onRespond };
}

beforeEach(() => {
  // jsdom 不提供 ResizeObserver；本测试不依赖布局。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("cua_screenshot_confirm request helpers", () => {
  it("按 kind 与 raw.toolName 识别固定 toolName，普通工具不命中", () => {
    expect(isCuaScreenshotConfirmRequest(createCuaScreenshotConfirmRequest())).toBe(true);
    expect(
      isCuaScreenshotConfirmRequest({
        kind: "Bash",
        raw: { toolName: "Bash", input: { command: "ls" } },
      }),
    ).toBe(false);
    // kind 可能是别的占位，但 raw 里 toolName 是 CLI 固定字面量。
    expect(
      isCuaScreenshotConfirmRequest({
        kind: "permission",
        raw: { toolName: "cua_screenshot_confirm", input: {} },
      }),
    ).toBe(true);
    expect(isCuaScreenshotConfirmRequest({ kind: "Bash", raw: {} })).toBe(false);
  });

  it("从 input.target 解析目标身份，畸形字段被忽略", () => {
    expect(getCuaScreenshotConfirmTarget(createCuaScreenshotConfirmRequest())).toEqual({
      ownerName: "TextEdit",
      windowName: "Untitled.txt",
      pid: 40077,
      windowId: 89384,
    });
    // 字段类型畸形时忽略该字段，不崩溃。
    expect(
      getCuaScreenshotConfirmTarget(
        createCuaScreenshotConfirmRequest({
          raw: {
            toolName: "cua_screenshot_confirm",
            input: { target: { ownerName: "TextEdit", pid: "40077", windowId: null } },
          },
        }),
      ),
    ).toEqual({
      ownerName: "TextEdit",
      windowName: null,
      pid: null,
      windowId: null,
    });
  });

  it("input 缺失或 target 非对象时返回 null", () => {
    expect(
      getCuaScreenshotConfirmTarget(createCuaScreenshotConfirmRequest({ raw: {} })),
    ).toBeNull();
    expect(
      getCuaScreenshotConfirmTarget(
        createCuaScreenshotConfirmRequest({
          raw: { toolName: "cua_screenshot_confirm", input: { target: "garbage" } },
        }),
      ),
    ).toBeNull();
    // rawInput 兼容形状同样解析（readRawToolCallInput 语义）。
    expect(
      getCuaScreenshotConfirmTarget(
        createCuaScreenshotConfirmRequest({
          raw: { rawInput: { target: { pid: 1, windowId: 2, ownerName: "A", windowName: "B" } } },
        }),
      ),
    ).toEqual({ ownerName: "A", windowName: "B", pid: 1, windowId: 2 });
  });

  it("只有 allow_once/allowOnce 映射到「允许本次截图」，allow_always/deny 用标准文案", () => {
    expect(getCuaScreenshotConfirmOptionLabelMessageId("allow_once")).toBe(
      "chat.permission.cua.screenshotConfirm.allowOnce",
    );
    // v4 投影把 allow_once 的 optionId 改写成 allowOnce（product-projection），
    // 真实 App 弹窗收到的就是这个形状。
    expect(getCuaScreenshotConfirmOptionLabelMessageId("allowOnce")).toBe(
      "chat.permission.cua.screenshotConfirm.allowOnce",
    );
    // 2026-10-31 用户修订：deny 与 allow_always 遵循通用权限文案。
    expect(getCuaScreenshotConfirmOptionLabelMessageId("deny")).toBeNull();
    expect(getCuaScreenshotConfirmOptionLabelMessageId("allow_always")).toBeNull();
    expect(getCuaScreenshotConfirmOptionLabelMessageId("allowAlways")).toBeNull();
  });

  it("getCuaScreenshotConfirmTarget 兼容 raw.target（v4 detail=input）形状", () => {
    expect(
      getCuaScreenshotConfirmTarget(
        createCuaScreenshotConfirmRequest({
          raw: {
            target: {
              pid: 40077,
              windowId: 89384,
              ownerName: "TextEdit",
              windowName: "未命名.txt",
            },
          },
        }),
      ),
    ).toEqual({
      ownerName: "TextEdit",
      windowName: "未命名.txt",
      pid: 40077,
      windowId: 89384,
    });
  });

  it("空字符串 ownerName/windowName 按缺失处理，不弹整块 fallback", () => {
    const request = createCuaScreenshotConfirmRequest({
      raw: {
        target: { pid: 40077, windowId: 89384, ownerName: "", windowName: "" },
      },
    });
    expect(getCuaScreenshotConfirmTarget(request)).toEqual({
      ownerName: null,
      windowName: null,
      pid: 40077,
      windowId: 89384,
    });
  });
});

describe("PermissionDialog cua_screenshot_confirm 展示", () => {
  it("标题与目标身份结构化展示（ownerName/windowName/pid/windowId + 本地化标签）", () => {
    const { getByText, queryByText } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest(),
      () => {},
    );

    expect(getByText("屏幕截图确认")).toBeTruthy();
    // 目标身份字段：结构化标签 + 值。
    expect(getByText("应用")).toBeTruthy();
    expect(getByText("TextEdit")).toBeTruthy();
    expect(getByText("窗口")).toBeTruthy();
    expect(getByText("Untitled.txt")).toBeTruthy();
    expect(getByText("PID")).toBeTruthy();
    expect(getByText("40077")).toBeTruthy();
    expect(getByText("窗口 ID")).toBeTruthy();
    expect(getByText("89384")).toBeTruthy();
    // 结构化展示时不再重复渲染英文 reason 摘要。
    expect(queryByText(CUA_REASON)).toBeNull();
    // 不出现协议原始 JSON 摊开（fallback 块被该 toolName 关闭）。
    expect(queryByText(/ownerName/)).toBeNull();
    expect(document.querySelector("pre")).toBeNull();
  });

  it("遵循标准选项集：允许本次截图 + 始终允许本项目 + 拒绝，无反馈输入（未开放 freeText）", () => {
    const { getAllByRole, queryByRole, queryByText } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest(),
      () => {},
    );

    const options = getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]!.getAttribute("aria-label")).toBe("允许本次截图");
    expect(options[1]!.getAttribute("aria-label")).toBe("始终允许本项目");
    expect(options[2]!.getAttribute("aria-label")).toBe("拒绝");
    // 该请求没有 freeText，遵循通用弹窗行为即不渲染反馈输入。
    expect(queryByRole("textbox")).toBeNull();
    // 不得出现会话免确认类文案。
    expect(queryByText("允许本会话")).toBeNull();
  });

  it("v4 形状（optionId allowOnce + raw.target + freeText:true）按通用行为渲染反馈输入", () => {
    const { getAllByRole, getByText, queryByRole, queryByText } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest({
        freeText: true,
        // pendingPermissionToLegacyRequest 把 v4 payload.detail（= 工具 input）直接放进 raw。
        raw: {
          target: {
            pid: 40077,
            windowId: 89384,
            ownerName: "TextEdit",
            windowName: "未命名.txt",
          },
        },
      }),
      () => {},
    );

    const options = getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]!.getAttribute("aria-label")).toBe("允许本次截图");
    expect(options[1]!.getAttribute("aria-label")).toBe("始终允许本项目");
    expect(options[2]!.getAttribute("aria-label")).toBe("拒绝");
    // 2026-10-31 用户修订：不再对该 toolName 屏蔽反馈输入，遵循通用弹窗行为。
    expect(queryByRole("textbox")).not.toBeNull();
    expect(getByText("TextEdit")).toBeTruthy();
    expect(getByText("未命名.txt")).toBeTruthy();
    expect(queryByText(/target/)).toBeNull();
  });

  it("空 ownerName/windowName 不显示对应行，但仍展示 PID 与窗口 ID", () => {
    const { getByText, queryByText } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest({
        raw: {
          target: { pid: 40077, windowId: 89384, ownerName: "", windowName: "" },
        },
      }),
      () => {},
    );

    expect(queryByText("应用")).toBeNull();
    expect(queryByText("窗口")).toBeNull();
    expect(getByText("PID")).toBeTruthy();
    expect(getByText("40077")).toBeTruthy();
    expect(getByText("窗口 ID")).toBeTruthy();
    expect(getByText("89384")).toBeTruthy();
  });

  it("input 缺失/畸形时回退显示 reason 字符串，动作按钮仍在", () => {
    const { getByText, getAllByRole } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest({
        raw: {
          requestId: "request-cua-confirm",
          toolCallId: "run-19065",
          toolName: "cua_screenshot_confirm",
          reason: CUA_REASON,
          riskLevel: "high",
        },
      }),
      () => {},
    );

    expect(getByText(CUA_REASON)).toBeTruthy();
    expect(getAllByRole("option")).toHaveLength(3);
  });

  it("target 只有部分字段有效时只渲染有效行", () => {
    const { getByText, queryByText } = renderPermissionDialog(
      createCuaScreenshotConfirmRequest({
        raw: {
          toolName: "cua_screenshot_confirm",
          reason: CUA_REASON,
          input: { target: { ownerName: "TextEdit", windowName: 42 } },
        },
      }),
      () => {},
    );

    expect(getByText("TextEdit")).toBeTruthy();
    expect(queryByText("PID")).toBeNull();
    expect(queryByText("窗口 ID")).toBeNull();
  });

  it("默认焦点落在拒绝选项，Enter 与确认按钮提交的都是拒绝", () => {
    const denyOption = standardCuaScreenshotConfirmOptions()[2]!;
    const view = renderPermissionDialog(createCuaScreenshotConfirmRequest(), vi.fn());
    const cancelOption = view.getAllByRole("option")[2]!;

    expect(document.activeElement).toBe(cancelOption);
    expect(cancelOption.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-cua-confirm",
      denyOption,
      undefined,
    );
    view.onRespond.mockClear();

    // 底部「确认」按钮同样提交当前选中的拒绝项。
    fireEvent.click(view.getByRole("button", { name: "确认" }));
    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-cua-confirm",
      denyOption,
      undefined,
    );
  });

  it("Esc 触发拒绝应答", () => {
    const denyOption = standardCuaScreenshotConfirmOptions()[2]!;
    const view = renderPermissionDialog(createCuaScreenshotConfirmRequest(), vi.fn());
    // 焦点即使在允许选项上，Esc 也必须是拒绝。
    const allowOption = view.getAllByRole("option")[0]!;
    act(() => allowOption.focus());
    fireEvent.keyDown(allowOption, { key: "Escape" });

    expect(view.onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-cua-confirm",
      denyOption,
      undefined,
    );
  });

  it("不影响普通工具弹窗的 Allow once / Deny 展示", () => {
    const { getAllByRole, queryByText } = renderPermissionDialog(
      {
        type: "permission_request",
        taskId: "task-1",
        traceId: "trace-1",
        requestId: "request-bash",
        description: "Run ls",
        kind: "Bash",
        title: "Bash",
        options: [
          {
            optionId: "allow_once",
            kind: "allowOnce",
            name: "Allow once",
            response: { decision: "allow" },
          },
          {
            optionId: "deny",
            kind: "deny",
            name: "Deny",
            response: { decision: "deny" },
          },
        ],
        raw: { toolName: "Bash", input: { command: "ls" } },
      },
      () => {},
    );

    const options = getAllByRole("option");
    expect(options[0]!.getAttribute("aria-label")).toBe("允许");
    expect(options[1]!.getAttribute("aria-label")).toBe("拒绝");
    expect(queryByText("允许本次截图")).toBeNull();
    expect(queryByText("屏幕截图确认")).toBeNull();
  });
});
