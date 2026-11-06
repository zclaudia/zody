import type { CommandAck, CommandEnvelope } from "@zody/shared/zody-protocol-v4";
import type { Hook } from "@zody/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trustWorkspaceHookWithReview } from "@/settings/workspaceHookReviewCommands.js";
import {
  useWorkspaceHookReviewStore,
  type WorkspaceHookReviewBinding,
} from "@/store/workspaceHookReviewStore.js";

const BUNDLE = "b".repeat(64);

function workspaceHook(): Hook {
  return {
    id: "workspace-hook-row",
    event: "SessionStart",
    type: "command",
    command: "echo project",
    enabled: false,
    workspaceHook: {
      reviewItemId: "item-0",
      workspaceIdentity: "workspace:repo",
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

function reviewBinding(
  sendCommand: (envelope: CommandEnvelope) => Promise<CommandAck>,
  overrides: Partial<WorkspaceHookReviewBinding["request"]> = {},
): WorkspaceHookReviewBinding {
  return {
    workspacePath: "/repo",
    sendCommand,
    request: {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId: "interaction-1",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      workspaceIdentity: "workspace:repo",
      workspaceLabel: "repo",
      bundleDigest: BUNDLE,
      createdAt: 1,
      deadlineAt: Date.now() + 60_000,
      sourceFiles: [],
      summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
      items: [
        {
          reviewItemId: "item-0",
          event: "SessionStart",
          type: "command",
          displayName: "SessionStart",
          displayCommand: "echo project",
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
      ...overrides,
    },
  };
}

function accepted(envelope: CommandEnvelope): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  };
}

function failed(envelope: CommandEnvelope, reasonCode: string): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "failed",
    reasonCode,
    revisionAtDecision: 1,
  };
}

beforeEach(() => {
  useWorkspaceHookReviewStore.setState({ bindings: {}, commandBindings: {} });
});

describe("workspace Hook Settings inline trust", () => {
  it("没有活跃 review 时先 request，再等待同 bundle/item 的 request 后 respond", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      if (envelope.type === "requestWorkspaceHookReview") {
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert("session-1", reviewBinding(sendCommand));
        });
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["requestWorkspaceHookReview", "respondWorkspaceHookReview"]);
    expect(sendCommand.mock.calls[0]?.[0].payload).toEqual({
      sessionId: "session-1",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
    });
    expect(sendCommand.mock.calls[1]?.[0].payload).toEqual(
      expect.objectContaining({
        interactionId: "interaction-1",
        decision: { action: "trust_selected", reviewItemIds: ["item-0"] },
      }),
    );
  });

  it("已有精确 review 时直接 respond，不重复 request", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().upsert("session-1", reviewBinding(sendCommand));

    const grantWithoutSession = vi.fn();
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["respondWorkspaceHookReview"]);
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("等待期间只有错误 bundle 的 review 时有界失败，绝不跨 bundle respond", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      if (envelope.type === "requestWorkspaceHookReview") {
        const stale = reviewBinding(sendCommand);
        stale.request = { ...stale.request, bundleDigest: "c".repeat(64) };
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert("session-1", stale);
        });
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        reviewWaitTimeoutMs: 10,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_interaction_timeout",
    });
    expect(commandTypes).toEqual(["requestWorkspaceHookReview"]);
  });

  it.each([
    "workspace_hooks_require_trust_capable_host",
    "workspace_hooks_snapshot_mismatch",
    "workspace_hooks_bundle_changed",
  ])("当前 session 无法审核 Settings bundle（%s）时转入 workspace grant", async (reasonCode) => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      return failed(envelope, reasonCode);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["requestWorkspaceHookReview"]);
    expect(grantWithoutSession).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
    });
  });

  it("当前 session 的其他拒绝不绕过 Runtime authority", async () => {
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) =>
      failed(envelope, "workspace_hooks_blocked_by_policy"),
    );
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("当前 session 无法审核且没有 workspace grant authority 时保留原拒绝", async () => {
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) =>
      failed(envelope, "workspace_hooks_require_trust_capable_host"),
    );
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_require_trust_capable_host",
    });
  });

  it("没有 task/session 时转入 workspace grant，并携带精确 bundle/declaration digest", async () => {
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(grantWithoutSession).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
    });
  });

  it("既无 session binding 又无 workspace grant authority 时仍 fail closed", async () => {
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_require_trust_capable_host",
    });
  });

  it("同 identity 双 remote 时只向选中 remote 的 task 发送 request/respond", async () => {
    const oldSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    const selectedSend = vi.fn(async (envelope: CommandEnvelope) => {
      if (envelope.type === "requestWorkspaceHookReview") {
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert(
            "task-selected",
            reviewBinding(selectedSend, {
              sessionId: "task-selected",
              remoteSessionId: "remote-selected",
            }),
          );
        });
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("task-old", {
      sessionId: "task-old",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-old",
      sendCommand: oldSend,
    });
    useWorkspaceHookReviewStore.getState().connect("task-selected", {
      sessionId: "task-selected",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-selected",
      sendCommand: selectedSend,
    });
    // A 的旧 review 不能因为同 identity/path 被选中。
    useWorkspaceHookReviewStore.getState().upsert("task-old", {
      ...reviewBinding(oldSend, { sessionId: "task-old", remoteSessionId: "remote-old" }),
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(oldSend).not.toHaveBeenCalled();
    expect(selectedSend.mock.calls.map(([envelope]) => envelope.type)).toEqual([
      "requestWorkspaceHookReview",
      "respondWorkspaceHookReview",
    ]);
    expect(selectedSend.mock.calls[0]?.[0].payload).toEqual(
      expect.objectContaining({ sessionId: "task-selected", remoteSessionId: "remote-selected" }),
    );
    expect(selectedSend.mock.calls[1]?.[0].payload).toMatchObject({
      sessionId: "task-selected",
      remoteSessionId: "remote-selected",
    });
  });

  it("选中 remote 没有 task binding 时不借同 identity 的其他 remote", async () => {
    const oldSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    useWorkspaceHookReviewStore.getState().connect("task-old", {
      sessionId: "task-old",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-old",
      sendCommand: oldSend,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_require_trust_capable_host",
    });
    expect(oldSend).not.toHaveBeenCalled();
  });

  it("选中 remote 无 task 时仍可走该 remote service 绑定的既有 workspace pretrust", async () => {
    const oldSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    useWorkspaceHookReviewStore.getState().connect("task-old", {
      sessionId: "task-old",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-old",
      sendCommand: oldSend,
    });
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(oldSend).not.toHaveBeenCalled();
    expect(grantWithoutSession).toHaveBeenCalledTimes(1);
  });

  it("同 remote 多 task 且无显式 taskSessionId 时歧义拒绝，不发命令也不 grant", async () => {
    const firstSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    const secondSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    for (const [sessionId, sendCommand] of [
      ["task-a", firstSend],
      ["task-b", secondSend],
    ] as const) {
      useWorkspaceHookReviewStore.getState().connect(sessionId, {
        sessionId,
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        sendCommand,
      });
    }
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        grantWithoutSession,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend).not.toHaveBeenCalled();
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("同 remote 多 task 时显式 taskSessionId 只向精确 task 发送", async () => {
    const firstSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    const secondSend = vi.fn(async (envelope: CommandEnvelope) => {
      if (envelope.type === "requestWorkspaceHookReview") {
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert(
            "task-b",
            reviewBinding(secondSend, {
              sessionId: "task-b",
              remoteSessionId: "remote-selected",
            }),
          );
        });
      }
      return accepted(envelope);
    });
    for (const [sessionId, sendCommand] of [
      ["task-a", firstSend],
      ["task-b", secondSend],
    ] as const) {
      useWorkspaceHookReviewStore.getState().connect(sessionId, {
        sessionId,
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        sendCommand,
      });
    }

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        taskSessionId: "task-b",
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(firstSend).not.toHaveBeenCalled();
    expect(secondSend.mock.calls.map(([envelope]) => envelope.type)).toEqual([
      "requestWorkspaceHookReview",
      "respondWorkspaceHookReview",
    ]);
  });

  it("等待期间连接换代时停止旧 flow，不借新通道 respond 也不 grant", async () => {
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));
    const nextSend = vi.fn(async (envelope: CommandEnvelope) => accepted(envelope));
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      if (envelope.type === "requestWorkspaceHookReview") {
        setTimeout(() => {
          useWorkspaceHookReviewStore.getState().disconnect("task-selected", sendCommand);
          useWorkspaceHookReviewStore.getState().connect("task-selected", {
            sessionId: "task-selected",
            workspacePath: "/repo",
            workspaceIdentity: "workspace:repo",
            remoteSessionId: "remote-selected",
            sendCommand: nextSend,
          });
        }, 0);
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("task-selected", {
      sessionId: "task-selected",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-selected",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        grantWithoutSession,
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(nextSend).not.toHaveBeenCalled();
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("已取得 review 后 respond 失败不转 grant", async () => {
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) =>
      failed(envelope, "workspace_hooks_bundle_changed"),
    );
    useWorkspaceHookReviewStore.getState().connect("task-selected", {
      sessionId: "task-selected",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-selected",
      sendCommand,
    });
    useWorkspaceHookReviewStore.getState().upsert(
      "task-selected",
      reviewBinding(sendCommand, {
        sessionId: "task-selected",
        remoteSessionId: "remote-selected",
      }),
    );
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        grantWithoutSession,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_bundle_changed",
    });
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("request 返回失败但同通道 review 已到达时优先 respond，不转 grant", async () => {
    const commandTypes: string[] = [];
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      if (envelope.type === "requestWorkspaceHookReview") {
        useWorkspaceHookReviewStore.getState().upsert(
          "task-selected",
          reviewBinding(sendCommand, {
            sessionId: "task-selected",
            remoteSessionId: "remote-selected",
          }),
        );
        return failed(envelope, "workspace_hooks_snapshot_mismatch");
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("task-selected", {
      sessionId: "task-selected",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      remoteSessionId: "remote-selected",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        remoteSessionId: "remote-selected",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(commandTypes).toEqual(["requestWorkspaceHookReview", "respondWorkspaceHookReview"]);
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });
});
