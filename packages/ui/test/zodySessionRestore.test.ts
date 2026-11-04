import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  ZODY_PROTOCOL_NAME,
  ZODY_PROTOCOL_VERSION,
  type ZodyMessageWithParts,
  type ZodySessionStateSnapshot,
  type ZodyTaskSnapshot,
} from "@zody/shared";
import { zodySessionSnapshotToZodyTaskSnapshot } from "../src/lib/zodySessionProjection.js";
import {
  readDesktopContinuousSessionRestoreSnapshot,
  readWebRemoteReplayableSessionConfigOptions,
} from "../src/lib/zodySessionRestore.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceIdentity: "ssh://dev/workspace/app",
  workspaceKey: "ssh://dev/workspace/app",
};

const model = { providerId: "glm", modelId: "glm-4.6" };

function createSnapshot(params: {
  title?: string;
  messages?: ZodyMessageWithParts[];
} = {}): ZodySessionStateSnapshot {
  return {
    protocol: {
      name: ZODY_PROTOCOL_NAME,
      version: ZODY_PROTOCOL_VERSION,
    },
    session: {
      sessionId: "sess_1",
      workspace,
      sessionKind: "interactive",
      title: params.title ?? "Existing session",
      mode: "build",
      status: "idle",
      model,
      createdAt: 1,
      updatedAt: 2,
    },
    settings: {
      model: {
        current: model,
        available: [{ ref: model, label: "GLM 4.6" }],
      },
      thoughtLevel: {
        enabled: false,
        available: [],
      },
      mode: {
        current: "build",
      },
    },
    projection: {
      sessionId: "sess_1",
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: 0,
      stateRevision: 1,
      deliveryKind: "desktop-continuous",
      pendingRequestIds: [],
    },
    messages: params.messages ?? [],
  };
}

function createLegacyTaskSnapshot(): ZodyTaskSnapshot {
  return {
    meta: {
      taskId: "sess_1",
      traceId: "trace-legacy",
      title: "Legacy task",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      createdAt: 1,
      updatedAt: 2,
      mode: "build",
      provider: "glm",
      status: "completed",
    },
    messages: [
      {
        role: "user",
        content: "old prompt",
        timestamp: 1,
      },
    ],
  };
}

describe("readDesktopContinuousSessionRestoreSnapshot", () => {
  it("rederives notification from reopened opaque history without rewriting old bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zody-meta-history-"));
    const dbPath = join(dir, "history.sqlite");
    const oldMeta = {
      zcode: {
        backgroundAgent: { outputFile: "/synthetic/old" },
        taskNotification: { result: "opaque old" },
      },
    };
    const messages = [
      {
        info: {
          messageId: "assistant",
          sessionId: "sess_1",
          role: "assistant",
          time: { created: 1 },
          agent: "zcode-agent",
          model,
        },
        parts: [
          {
            partId: "tool",
            sessionId: "sess_1",
            messageId: "assistant",
            type: "tool",
            callId: "toolu_1",
            tool: "Agent",
            state: {
              status: "completed",
              input: { run_in_background: true },
              output: "",
              title: "Agent",
              metadata: { _meta: oldMeta },
              startedAt: 1,
              completedAt: 2,
            },
          },
        ],
      },
      {
        info: {
          messageId: "notification",
          sessionId: "sess_1",
          role: "user",
          time: { created: 3 },
          agent: "zcode-agent",
          model,
          visibility: "model-only",
        },
        parts: [
          {
            partId: "text",
            sessionId: "sess_1",
            messageId: "notification",
            type: "text",
            text: "<task-notification><task-id>agent_1</task-id><tool-use-id>toolu_1</tool-use-id><status>completed</status><result>from body</result></task-notification>",
          },
        ],
      },
    ] as unknown as ZodyMessageWithParts[];
    const repeated = structuredClone(messages[1]!);
    repeated.info.messageId = "notification-duplicate";
    repeated.parts[0]!.messageId = "notification-duplicate";
    repeated.parts[0]!.partId = "text-duplicate";
    messages.push(repeated);
    const bytes = JSON.stringify(messages);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    try {
      let db = new DatabaseSync(dbPath);
      db.exec("create table history (raw text not null)");
      db.prepare("insert into history values (?)").run(bytes);
      db.close();
      db = new DatabaseSync(dbPath);
      const row = db.prepare("select raw from history").get() as { raw: string };
      db.close();
      expect(digest(row.raw)).toBe(digest(bytes));
      const saved = createSnapshot({ messages: JSON.parse(row.raw) });
      const zodySessionService = {
        resumeSession: vi.fn(async () => saved),
        readSession: vi.fn(async () => saved),
      };
      const restored = await readDesktopContinuousSessionRestoreSnapshot({
        zodySessionService,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
      });
      expect(restored.snapshot.messages[0]?.tools?.[0]?.raw).toMatchObject({
        _meta: { zcode: oldMeta.zcode, zody: { taskNotification: { result: "from body" } } },
      });
      const again = await readDesktopContinuousSessionRestoreSnapshot({
        zodySessionService,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
      });
      expect(again.snapshot.messages).toEqual(restored.snapshot.messages);
      for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
        const projection = zodySessionSnapshotToZodyTaskSnapshot({
          ...saved,
          runtime: { ...saved.runtime, deliveryKind },
        });
        expect(projection.messages.flatMap((message) => message.tools ?? [])).toHaveLength(1);
        expect(projection.messages[0]?.tools?.[0]?.raw).toMatchObject({
          _meta: { zody: { taskNotification: { result: "from body" } } },
        });
      }
      expect(digest(row.raw)).toBe(digest(bytes));
      const withoutBody = createSnapshot({ messages: [messages[0]!] });
      const oldOnly = await readDesktopContinuousSessionRestoreSnapshot({
        zodySessionService: {
          resumeSession: vi.fn(async () => withoutBody),
          readSession: vi.fn(async () => withoutBody),
        },
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
      });
      const oldRaw = oldOnly.snapshot.messages[0]?.tools?.[0]?.raw as {
        _meta: { zcode: unknown; zody?: unknown };
      };
      expect(oldRaw._meta.zcode).toEqual(oldMeta.zcode);
      expect(oldRaw._meta.zody).toBeUndefined();
      db = new DatabaseSync(dbPath);
      expect((db.prepare("select raw from history").get() as { raw: string }).raw).toBe(bytes);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes historical desktop session before reading the limited snapshot", async () => {
    const calls: string[] = [];
    let active = false;
    const zodySessionService = {
      resumeSession: vi.fn(async () => {
        calls.push("resume");
        active = true;
        return createSnapshot({ title: "Resumed session" });
      }),
      readSession: vi.fn(async () => {
        calls.push("read");
        if (!active) {
          throw new Error("Session is not active: sess_1");
        }
        return createSnapshot({ title: "Read session" });
      }),
    };

    const restoreParams: Parameters<typeof readDesktopContinuousSessionRestoreSnapshot>[0] = {
      zodySessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
      model: { providerId: "custom-openai", modelId: "deepseek-v4-flash" },
      thoughtLevel: "high",
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot(restoreParams);

    expect(calls).toEqual(["resume", "read"]);
    expect(zodySessionService.resumeSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: { providerId: "custom-openai", modelId: "deepseek-v4-flash" },
      thoughtLevel: "high",
    });
    expect(zodySessionService.readSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      deliveryKind: "desktop-continuous",
      messageLimit: 30,
    });
    expect(result.resumedSessionSnapshot?.session.title).toBe("Resumed session");
    expect(result.snapshot.meta.title).toBe("Read session");
  });

  it("leaves legacy direct-return old metadata opaque without reprojection", async () => {
    const legacy = createLegacyTaskSnapshot();
    const oldRaw = {
      _meta: {
        zcode: {
          backgroundAgent: { outputFile: "/synthetic/old" },
          taskNotification: { result: "old" },
        },
      },
    };
    legacy.messages[0]!.tools = [{ id: "toolu_1", name: "Agent", raw: oldRaw } as never];
    const original = JSON.stringify(legacy);
    const result = await readDesktopContinuousSessionRestoreSnapshot({
      zodySessionService: {
        resumeSession: vi.fn(async () => {
          throw new Error("Session not found: sess_1");
        }),
        readSession: vi.fn(async () => createSnapshot()),
      },
      zodyTaskService: { getTaskSnapshot: vi.fn(async () => legacy) },
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
    });
    expect(result.usedLegacySnapshot).toBe(true);
    expect(JSON.stringify(result.snapshot)).toBe(original);
    expect(result.snapshot.messages[0]?.tools?.[0]?.raw).toEqual(oldRaw);
  });

  it("falls back to legacy task snapshot when the protocol session is missing", async () => {
    const legacySnapshot = createLegacyTaskSnapshot();
    const zodySessionService = {
      resumeSession: vi.fn(async () => {
        throw new Error("Session not found: sess_1");
      }),
      readSession: vi.fn(async () => createSnapshot()),
    };
    const zodyTaskService = {
      getTaskSnapshot: vi.fn(async () => legacySnapshot),
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot({
      zodySessionService,
      zodyTaskService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
    });

    expect(result.usedLegacySnapshot).toBe(true);
    expect(result.resumedSessionSnapshot).toBeUndefined();
    expect(result.snapshot.meta.title).toBe("Legacy task");
    expect(zodySessionService.readSession).not.toHaveBeenCalled();
    expect(zodyTaskService.getTaskSnapshot).toHaveBeenCalledWith({
      taskId: "sess_1",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      messageLimit: 30,
      clientMode: "desktop-continuous",
    });
  });

  it("does not treat the old live model code as the current restore special case", async () => {
    const oldError = Object.assign(new Error("old code from live peer"), {
      code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
    });
    const zodySessionService = {
      resumeSession: vi.fn(async () => {
        throw oldError;
      }),
      readSession: vi.fn(async () => createSnapshot()),
    };
    const zodyTaskService = { getTaskSnapshot: vi.fn(async () => createLegacyTaskSnapshot()) };
    await expect(
      readDesktopContinuousSessionRestoreSnapshot({
        zodySessionService,
        zodyTaskService,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
        model: { providerId: "removed-provider", modelId: "removed-model" },
      }),
    ).rejects.toBe(oldError);
    expect(zodyTaskService.getTaskSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to task snapshot when the historical runtime model is unavailable", async () => {
    const legacySnapshot = createLegacyTaskSnapshot();
    const unavailableModelError = Object.assign(
      new Error("历史任务使用的模型已不可用，请选择当前可用模型后继续。"),
      { code: "ZODY_RUNTIME_MODEL_UNAVAILABLE" },
    );
    const zodySessionService = {
      resumeSession: vi.fn(async () => {
        throw unavailableModelError;
      }),
      readSession: vi.fn(async () => createSnapshot()),
    };
    const zodyTaskService = {
      getTaskSnapshot: vi.fn(async () => legacySnapshot),
    };

    const result = await readDesktopContinuousSessionRestoreSnapshot({
      zodySessionService,
      zodyTaskService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      messageLimit: 30,
      model: { providerId: "removed-provider", modelId: "removed-model" },
    });

    expect(result.usedLegacySnapshot).toBe(true);
    expect(result.resumedSessionSnapshot).toBeUndefined();
    expect(result.restoreWarning).toMatchObject({
      code: "ZODY_RUNTIME_MODEL_UNAVAILABLE",
      message: "历史任务使用的模型已不可用，请选择当前可用模型后继续。",
      taskId: "sess_1",
    });
    expect(result.snapshot.meta.title).toBe("Legacy task");
    expect(zodySessionService.readSession).not.toHaveBeenCalled();
    expect(zodyTaskService.getTaskSnapshot).toHaveBeenCalledWith({
      taskId: "sess_1",
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      messageLimit: 30,
      clientMode: "desktop-continuous",
    });
  });
});

describe("readWebRemoteReplayableSessionConfigOptions", () => {
  it("resumes with the historical model before reading active mobile task toolbar settings", async () => {
    const calls: string[] = [];
    const historicalModel = {
      providerId: "china-llm-zcode-dev:demo",
      modelId: "deepseek-v4-flash",
    };
    const zodySessionService = {
      resumeSession: vi.fn(async () => {
        calls.push("resume");
        return createSnapshot({ title: "Mobile resumed session" });
      }),
      readSession: vi.fn(async () => {
        calls.push("read");
        return createSnapshot({
          title: "Mobile session",
        });
      }),
    };

    const restoreParams: Parameters<typeof readWebRemoteReplayableSessionConfigOptions>[0] = {
      zodySessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: historicalModel,
      thoughtLevel: "high",
    };

    const configOptions = await readWebRemoteReplayableSessionConfigOptions(restoreParams);

    expect(calls).toEqual(["resume", "read"]);
    expect(zodySessionService.resumeSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      model: historicalModel,
      thoughtLevel: "high",
    });
    expect(zodySessionService.readSession).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
      deliveryKind: "web-remote-replayable",
      messageLimit: 1,
    });
    expect(configOptions?.map((option) => option.category)).toEqual([
      "model",
      "mode",
    ]);
  });

  it("includes thought level from replayable session settings when enabled", async () => {
    const snapshot = createSnapshot();
    const zodySessionService = {
      readSession: vi.fn(async () => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          thoughtLevel: {
            enabled: true,
            current: "high",
            available: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        },
      })),
      resumeSession: vi.fn(),
    };

    const configOptions = await readWebRemoteReplayableSessionConfigOptions({
      zodySessionService,
      workspacePath: workspace.workspacePath,
      workspaceIdentity: workspace.workspaceIdentity,
      sessionId: "sess_1",
    });

    expect(configOptions?.map((option) => option.category)).toEqual([
      "model",
      "mode",
      "thought_level",
    ]);
    expect(
      configOptions?.find((option) => option.category === "thought_level")
        ?.currentValue,
    ).toBe("high");
  });

  it("returns null for legacy tasks without an active protocol session", async () => {
    const zodySessionService = {
      readSession: vi.fn(async () => {
        throw new Error("Session not found: sess_1");
      }),
      resumeSession: vi.fn(),
    };

    await expect(
      readWebRemoteReplayableSessionConfigOptions({
        zodySessionService,
        workspacePath: workspace.workspacePath,
        workspaceIdentity: workspace.workspaceIdentity,
        sessionId: "sess_1",
      }),
    ).resolves.toBeNull();
  });
});
