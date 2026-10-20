import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TID_V4_USER_INPUT_DIALOG } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  // fork（bot-channels 移除）：buildV4ElicitationProgressKey / resolveV4ElicitationRequest
  // 的 bot 代答进度用例删除后不再被本文件引用。
  createInteractionAutoResolutionIntentTracker,
  getCurrentSessionInteractionSnapshot,
  V4InteractionDialogs,
} from "../src/v4/V4InteractionDialogs.js";

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({
    sendCommand: vi.fn(),
  }),
}));

describe("V4InteractionDialogs", () => {
  it("ignores a stale snapshot while switching back to another task", () => {
    const staleSnapshot = {
      sessionId: "task-b",
      pendingInteractions: [],
    } as ConversationSnapshot;

    expect(getCurrentSessionInteractionSnapshot("task-a", staleSnapshot)).toBeNull();
    expect(getCurrentSessionInteractionSnapshot("task-b", staleSnapshot)).toBe(staleSnapshot);
  });

  // fork（bot-channels 移除）：原「uses Bot question progress for the same v4 elicitation
  // request」用例随 Bot 代答进度链（botsTaskBroadcast 写入 elicitationRequest）删除
  //（specs/bot-channels-removal.md），progress 覆盖场景不再有生产者。

  it("remembers early user input and consumes the snooze intent exactly once", () => {
    const tracker = createInteractionAutoResolutionIntentTracker();

    tracker.markInteracted("ask-1");
    expect(tracker.consumeSnooze("ask-1", false)).toBe(false);
    expect(tracker.consumeSnooze("ask-1", true)).toBe(true);
    expect(tracker.consumeSnooze("ask-1", true)).toBe(false);
    tracker.releaseSnooze("ask-1");
    expect(tracker.consumeSnooze("ask-1", true)).toBe(true);
    expect(tracker.consumeSnooze("other", true)).toBe(false);
  });

  it("does not downgrade workspaceHookReview to a generic interaction dialog", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "workspace-review-1",
          kind: "workspaceHookReview",
          anchorRowId: null,
          createdAt: 300,
          payload: {
            kind: "workspaceHookReview",
            reviewFlowId: "flow-1",
            generation: 1,
            interactionId: "workspace-review-1",
            sessionId: "sess-1",
            taskId: "sess-1",
            runId: "run-1",
            workspaceIdentity: "/workspace",
            workspaceLabel: "workspace",
            bundleDigest: "a".repeat(64),
            createdAt: 300,
            deadlineAt: 600_300,
            sourceFiles: [],
            summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
            items: [],
            warningCode: "workspace_hooks_execute_code",
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toBe("");
  });

  it("renders the first generic interaction after a workspaceHookReview", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "workspace-review-1",
          kind: "workspaceHookReview",
          anchorRowId: null,
          createdAt: 300,
          payload: {
            kind: "workspaceHookReview",
            reviewFlowId: "flow-1",
            generation: 1,
            interactionId: "workspace-review-1",
            sessionId: "sess-1",
            taskId: "sess-1",
            runId: "run-1",
            workspaceIdentity: "/workspace",
            workspaceLabel: "workspace",
            bundleDigest: "a".repeat(64),
            createdAt: 300,
            deadlineAt: 600_300,
            sourceFiles: [],
            summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
            items: [],
            warningCode: "workspace_hooks_execute_code",
          },
        },
        {
          interactionId: "plan-1",
          kind: "userInput",
          anchorRowId: 5,
          createdAt: 301,
          payload: {
            kind: "userInput",
            prompt: "请确认计划",
            freeText: true,
            toolName: "ExitPlanMode",
            toolCallId: "tool-plan",
            traceId: "trace-plan",
            schema: { toolName: "ExitPlanMode" },
            questions: [
              {
                question: "是否执行该计划？",
                header: "计划",
                options: [
                  { value: "approve", label: "执行", description: "执行当前计划" },
                  { value: "feedback", label: "反馈", description: "返回修改意见" },
                ],
              },
            ],
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toContain("是否执行该计划？");
    expect(html).toContain("执行当前计划");
  });

  it("renders structured userInput interactions with ElicitationDialog", () => {
    const snapshot = {
      sessionId: "sess-1",
      pendingInteractions: [
        {
          interactionId: "ask-1",
          kind: "userInput",
          anchorRowId: 5,
          createdAt: 300,
          payload: {
            kind: "userInput",
            prompt: "请选择",
            freeText: true,
            toolName: "AskUserQuestion",
            toolCallId: "tool-ask",
            traceId: "trace-ask",
            schema: { toolName: "AskUserQuestion" },
            questions: [
              {
                question: "你想怎么做？",
                header: "方案",
                options: [
                  { value: "fast", label: "快速", description: "先做最小修复" },
                  { value: "safe", label: "稳妥", description: "补齐测试和文档" },
                ],
              },
            ],
          },
        },
      ],
    } as ConversationSnapshot;

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-1",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(html).toContain("你想怎么做？");
    expect(html).toContain("快速");
    expect(html).toContain("先做最小修复");
    expect(html).not.toContain(`data-testid="${TID_V4_USER_INPUT_DIALOG}"`);
  });
});
