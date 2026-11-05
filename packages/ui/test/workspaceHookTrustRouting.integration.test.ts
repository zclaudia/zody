// @vitest-environment jsdom

import type { Hook } from "@zody/shared";
import { TID_V4_WORKSPACE_HOOK_PENDING_REVIEW } from "@zody/shared";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zody/shared/zody-protocol-v4";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodyIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { trustWorkspaceHookWithReview } from "@/settings/workspaceHookReviewCommands.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";
import { INITIAL_PANE_LAYOUT, openSessionInNewPane } from "@/v4/paneLayoutTree.js";
import { WorkspaceHookPendingBanner } from "@/v4/WorkspaceHookPendingBanner.js";

const navigationMock = vi.hoisted(() => ({
  setIntent: vi.fn(),
  openSettingsTab: vi.fn(),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: navigationMock.setIntent,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: (selector: (state: { openSettingsTab: () => void }) => unknown) =>
    selector({ openSettingsTab: navigationMock.openSettingsTab }),
}));

const BUNDLE = "b".repeat(64);
const WORKSPACE_IDENTITY = "remote:synthetic:repo";
const WORKSPACE_PATH = "/synthetic/repo";

function workspaceHook(): Hook {
  return {
    id: "synthetic-hook",
    event: "SessionStart",
    type: "command",
    command: "synthetic",
    enabled: false,
    workspaceHook: {
      reviewItemId: "synthetic-item",
      workspaceIdentity: WORKSPACE_IDENTITY,
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
      sourceFileIndex: 0,
      sourceRootEnabled: true,
      declarationEnabled: false,
      runtimeHooksEnabled: true,
      configuredEnabled: false,
      sourcePath: ".zcode/config.json",
      trustState: "pending_trust",
    },
  };
}

function reviewPayload(
  sessionId: string,
  remoteSessionId: string,
): WorkspaceHookReviewRequestPayload {
  return {
    kind: "workspaceHookReview",
    reviewFlowId: `flow-${remoteSessionId}`,
    generation: 1,
    interactionId: `interaction-${remoteSessionId}`,
    sessionId,
    taskId: sessionId,
    runId: `run-${remoteSessionId}`,
    workspaceIdentity: WORKSPACE_IDENTITY,
    workspaceLabel: "repo",
    remoteSessionId,
    bundleDigest: BUNDLE,
    createdAt: 1,
    deadlineAt: Date.now() + 60_000,
    sourceFiles: [],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "synthetic-item",
        event: "SessionStart",
        type: "command",
        displayName: "SessionStart",
        displayCommand: "synthetic",
        sourcePath: ".zcode/config.json",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        executionMode: "foreground",
        configuredEnabled: false,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  };
}

function accepted(envelope: CommandEnvelope): CommandAck {
  return { commandId: envelope.commandId, status: "accepted", revisionAtDecision: 1 };
}

beforeEach(() => {
  useWorkspaceHookReviewStore.setState({ bindings: {}, commandBindings: {} });
  globalThis.localStorage?.clear();
  navigationMock.setIntent.mockClear();
  navigationMock.openSettingsTab.mockClear();
});

afterEach(() => cleanup());

describe("workspace Hook Trust remote routing integration", () => {
  it("真实 pane layout + resolver + registry 选择 B 时只向 B 的 task 发送", async () => {
    const calls = { old: [] as CommandEnvelope[], selected: [] as CommandEnvelope[] };
    const oldSend = vi.fn(async (envelope: CommandEnvelope) => {
      calls.old.push(envelope);
      return accepted(envelope);
    });
    const selectedSend = vi.fn(async (envelope: CommandEnvelope) => {
      calls.selected.push(envelope);
      if (envelope.type === "requestWorkspaceHookReview") {
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert("task-selected", {
            request: reviewPayload("task-selected", "remote-selected"),
            workspacePath: WORKSPACE_PATH,
            sendCommand: selectedSend,
          });
        });
      }
      return accepted(envelope);
    });
    for (const [sessionId, remoteSessionId, sendCommand] of [
      ["task-old", "remote-old", oldSend],
      ["task-selected", "remote-selected", selectedSend],
    ] as const) {
      useWorkspaceHookReviewStore.getState().connect(sessionId, {
        sessionId,
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: WORKSPACE_IDENTITY,
        remoteSessionId,
        sendCommand,
      });
    }

    const scopeOld = {
      workspacePath: WORKSPACE_PATH,
      workspaceIdentity: WORKSPACE_IDENTITY,
      remoteSessionId: "remote-old",
    };
    const scopeSelected = { ...scopeOld, remoteSessionId: "remote-selected" };
    const remoteState = {
      sessionsById: { "remote-old": { services: {} }, "remote-selected": { services: {} } },
      sessionIdByWorkspaceIdentity: { [WORKSPACE_IDENTITY]: "remote-selected" },
      sessionIdByWorkspacePath: {},
    };
    expect(resolveWorkspaceRemoteSessionId(scopeOld, remoteState)).toBe("remote-old");
    expect(resolveWorkspaceRemoteSessionId(scopeSelected, remoteState)).toBe("remote-selected");

    const paneOld = openSessionInNewPane(INITIAL_PANE_LAYOUT, scopeOld, "task-old");
    const paneSelected = openSessionInNewPane(paneOld, scopeSelected, "task-selected");
    expect(
      Object.values(paneSelected.panes)
        .filter((pane) => pane.sessionId)
        .map((pane) => ({
          sessionId: pane.sessionId,
          remote: pane.workspaceScope.remoteSessionId,
        })),
    ).toEqual([
      { sessionId: "task-old", remote: "remote-old" },
      { sessionId: "task-selected", remote: "remote-selected" },
    ]);

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: WORKSPACE_IDENTITY,
        remoteSessionId: "remote-selected",
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(calls.old).toHaveLength(0);
    expect(calls.selected.map((envelope) => envelope.type)).toEqual([
      "requestWorkspaceHookReview",
      "respondWorkspaceHookReview",
    ]);
    expect(calls.selected[0]?.payload).toEqual(
      expect.objectContaining({ sessionId: "task-selected", remoteSessionId: "remote-selected" }),
    );
    expect(calls.selected[1]?.payload).toMatchObject({
      sessionId: "task-selected",
      remoteSessionId: "remote-selected",
    });
  });

  it("真实 PendingBanner 通过 real registry 选择精确 task + remote channel", async () => {
    const oldSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    const selectedSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    for (const [sessionId, remoteSessionId, sendCommand] of [
      ["task-old", "remote-old", oldSend],
      ["task-selected", "remote-selected", selectedSend],
    ] as const) {
      useWorkspaceHookReviewStore.getState().connect(sessionId, {
        sessionId,
        workspacePath: WORKSPACE_PATH,
        workspaceIdentity: WORKSPACE_IDENTITY,
        remoteSessionId,
        sendCommand,
      });
    }

    render(
      createElement(
        ZodyIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceHookPendingBanner, {
          sessionId: "task-selected",
          workspacePath: WORKSPACE_PATH,
          workspaceIdentity: WORKSPACE_IDENTITY,
          remoteSessionId: "remote-selected",
          admission: {
            pendingCount: 1,
            bundleDigest: BUNDLE,
            workspaceIdentity: WORKSPACE_IDENTITY,
          },
        }),
      ),
    );

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_HOOK_PENDING_REVIEW));

    await waitFor(() => expect(selectedSend).toHaveBeenCalledTimes(1));
    expect(oldSend).not.toHaveBeenCalled();
    expect(selectedSend.mock.calls[0]?.[0].payload).toEqual({
      sessionId: "task-selected",
      remoteSessionId: "remote-selected",
      workspaceIdentity: WORKSPACE_IDENTITY,
      bundleDigest: BUNDLE,
    });
    expect(navigationMock.openSettingsTab).toHaveBeenCalled();
  });
});
