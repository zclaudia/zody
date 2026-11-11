import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRootTraceContext, type TurnInputIntentMetadata } from "@zody/contracts";
import type { CommandEnvelope, CommandResult, QueueItem } from "@zody/shared/zody-protocol-v4";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zody-protocol-v4/commands/types.js";
import { sessionFlowHandlers } from "../src/zody-protocol-v4/commands/handlers/session-flow.js";
import { sessionMgmtHandlers } from "../src/zody-protocol-v4/commands/handlers/session-mgmt.js";
import { queueHandlers } from "../src/zody-protocol-v4/commands/handlers/queue.js";
import { CommandInbox } from "../src/zody-protocol-v4/command-inbox.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const MODEL_SELECTION = {
  providerId: "zai",
  modelId: "glm-4.6",
  options: { reasoningLevel: "high" },
} as const;
const LAUNCH_IDENTITY = {
  hostInstanceId: "host-real",
  runtimeInstanceId: "agent-real",
} as const;

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function modelExecutor(gates: Deferred[] = [], onGenerate?: () => void) {
  return {
    async generateText() {
      onGenerate?.();
      const gate = gates.shift();
      if (gate) await gate.promise;
      return {
        finishReason: "stop",
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never;
}

function intent(
  sourceCommandId: string,
  inputOrigin: "desktop" | "mobile" | undefined,
  text = sourceCommandId,
): TurnInputIntentMetadata {
  return {
    sourceCommandId,
    queueItemId: `queue_${sourceCommandId}`,
    clientId: "desktop",
    kind: "sendText",
    text,
    ...(inputOrigin ? { inputOrigin } : {}),
    admissionSeq: 1,
    admittedAt: 1,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
  };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

describe("Host startup identity to live CommandInbox submission", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function createApp(
    options: {
      sessionId?: string;
      identity?: typeof LAUNCH_IDENTITY | undefined;
      gates?: Deferred[];
      onModelGenerate?: () => void;
    } = {},
  ) {
    const workspacePath = mkdtempSync(join(tmpdir(), "cua-host-live-"));
    createdDirs.push(workspacePath);
    const app = await createRegistryBackedTestApp({
      cuaLaunchIdentity: options.identity
        ? { ...options.identity, workspaceKey: workspacePath }
        : undefined,
      env: {
        HOME: workspacePath,
        ZODY_SESSION_DB_PATH: join(workspacePath, "db.sqlite"),
        ZODY_STORAGE_DIR: workspacePath,
      },
      modelExecutor: modelExecutor(options.gates, options.onModelGenerate),
      runtimeConfig: {
        mcp: { enabled: false },
        modelSelection: MODEL_SELECTION,
        workingDirectory: workspacePath,
      },
      ...(options.sessionId ? { sessionId: options.sessionId as never } : {}),
      skipUserConfig: true,
    });
    const record: V4SessionRecordView = {
      app,
      persistence: "immediate",
      traceContext: createRootTraceContext({ sessionId: app.sessionId }),
      workspace: { workspacePath },
    };
    return { app, record, workspacePath };
  }

  function makeHost(
    records: Map<string, V4SessionRecordView>,
    createRecord?: () => Promise<{ sessionId: string }>,
    getQueueItem?: (sessionId: string, queueItemId: string) => QueueItem | null,
  ) {
    const host = {
      getRecord: (sessionId: string) => records.get(sessionId),
      logger: { info: vi.fn(), warn: vi.fn() },
      getInputRoutingMode: () => "startNow",
      ensureModelReady: vi.fn(async () => undefined),
      afterLegacyStateMutation: vi.fn(async () => undefined),
      admitInputCommand: vi.fn(async () => null),
      cancelInputCommand: vi.fn(async () => undefined),
      createSessionRecord: createRecord,
      getQueueItem,
      getRevision: () => 0,
    } as unknown as V4CommandCoreHost;
    return host;
  }

  async function execute(
    inbox: CommandInbox,
    host: V4CommandCoreHost,
    envelope: CommandEnvelope,
  ): Promise<{ kind: "ack" } | { kind: "execute"; result: CommandResult | undefined }> {
    const outcome = await inbox.handle(envelope);
    if (outcome.kind === "ack") return { kind: "ack" };
    const admitted = {
      ...outcome.envelope,
      __v4Admission: {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      },
    } as CommandEnvelope;
    try {
      const result =
        admitted.type === "sendText"
          ? await sessionFlowHandlers.sendText(host, admitted)
          : admitted.type === "createSession"
            ? await sessionMgmtHandlers.createSession(host, admitted)
            : admitted.type === "sendQueuedNow"
              ? await queueHandlers.sendQueuedNow(host, admitted)
              : (() => {
                  throw new Error(`unexpected command ${admitted.type}`);
                })();
      outcome.settle({ status: "accepted", ...(result ? { result } : {}) });
      return { kind: "execute", result };
    } catch (error) {
      outcome.settle({
        status: "failed",
        reasonCode: "fault.command.executionFailed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  function sendText(
    commandId: string,
    sessionId: string,
    inputOrigin: "desktop" | "mobile" | undefined,
    extra: Record<string, unknown> = {},
  ): CommandEnvelope {
    return {
      clientId: "desktop",
      commandId,
      issuedAt: 1,
      payload: { text: commandId, ...(inputOrigin ? { inputOrigin } : {}), ...extra },
      sessionId,
      type: "sendText",
    } as CommandEnvelope;
  }

  it("creates a new app incarnation per app and old close cannot affect the new app", async () => {
    const first = await createApp({ identity: LAUNCH_IDENTITY, sessionId: "session-a" });
    const firstRegistrar = first.app.runtime.getCuaSubmissionRegistrar();
    if (!firstRegistrar) throw new Error("missing registrar");
    const firstTicket = firstRegistrar.register({
      inputKind: "new-submission",
      origin: "desktop",
      sourceCommandId: "source-a",
      queueItemId: "queue_source-a",
    });
    if (!firstTicket.accepted) throw new Error(firstTicket.reason);
    const firstRun = await first.app.runtime.admitPrompt("a", undefined, {
      inputId: "source-a",
      intent: intent("source-a", "desktop"),
    });
    if (firstRun.kind === "started") await firstRun.completion;
    const firstProjection = first.app.runtime.getCuaSubmissionProjection();
    if (firstProjection.status !== "candidate") throw new Error("first app had no candidate");

    const second = await createApp({ identity: LAUNCH_IDENTITY, sessionId: "session-b" });
    const secondRegistrar = second.app.runtime.getCuaSubmissionRegistrar();
    if (!secondRegistrar) throw new Error("missing registrar");
    const secondTicket = secondRegistrar.register({
      inputKind: "new-submission",
      origin: "desktop",
      sourceCommandId: "source-b",
      queueItemId: "queue_source-b",
    });
    if (!secondTicket.accepted) throw new Error(secondTicket.reason);
    const secondRun = await second.app.runtime.admitPrompt("b", undefined, {
      inputId: "source-b",
      intent: intent("source-b", "desktop"),
    });
    if (secondRun.kind === "started") await secondRun.completion;
    const secondProjection = second.app.runtime.getCuaSubmissionProjection();
    if (secondProjection.status !== "candidate") throw new Error("second app had no candidate");
    expect(secondProjection.ref.appIncarnation).not.toBe(firstProjection.ref.appIncarnation);

    await first.app.close?.();
    expect(second.app.runtime.getCuaSubmissionProjection()).toMatchObject({
      status: "candidate",
      ref: { appIncarnation: secondProjection.ref.appIncarnation },
    });
    await second.app.close?.();
  });

  it("registers one live candidate for a new execute and replays it without re-admission", async () => {
    const { app, record } = await createApp({ identity: LAUNCH_IDENTITY, sessionId: "session-1" });
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    const envelope = sendText("source-1", String(app.sessionId), "desktop");
    try {
      expect(await execute(inbox, host, envelope)).toMatchObject({ kind: "execute" });
      const candidate = app.runtime.getCuaSubmissionProjection();
      if (candidate.status !== "candidate") throw new Error("no live candidate");
      expect(candidate.ref.hostInstanceId).toBe(LAUNCH_IDENTITY.hostInstanceId);
      expect(candidate.ref.runtimeInstanceId).toBe(LAUNCH_IDENTITY.runtimeInstanceId);

      // 同一 commandId 重送命中 CommandInbox 幂等表，不进入 execute/handler。
      expect(await execute(inbox, host, envelope)).toEqual({ kind: "ack" });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: candidate.ref.submissionLineageId },
      });

      // 历史 intent 只有 desktop 标签，没有 live ticket，不能建立候选。
      const replayed = await createApp({ identity: LAUNCH_IDENTITY, sessionId: "session-replay" });
      const run = await replayed.app.runtime.admitPrompt("history", undefined, {
        inputId: "history-source",
        intent: intent("history-source", "desktop"),
      });
      if (run.kind === "started") await run.completion;
      expect(replayed.app.runtime.getCuaSubmissionProjection()).toEqual({
        mobileDelivery: "unknown",
        nativeFence: "unknown",
        status: "unknown",
      });
      await replayed.app.close?.();
    } finally {
      await app.close?.();
    }
  });

  it("keeps a queued desktop ticket until its one promotion and does not revive on replay", async () => {
    const gateA = deferred();
    const gateB = deferred();
    const firstModelStarted = deferred();
    const { app, record } = await createApp({
      identity: LAUNCH_IDENTITY,
      sessionId: "session-queue",
      gates: [gateA, gateB],
      onModelGenerate: firstModelStarted.resolve,
    });
    const records = new Map([[String(app.sessionId), record]]);
    const queueItem: QueueItem = {
      admittedAt: 1,
      attachments: [],
      clientId: "desktop",
      delivery: { admitted: "queue", requested: "queue" },
      dispatch: { state: "queued" },
      inputOrigin: "desktop",
      kind: "sendText",
      order: { admissionSeq: 1, queuePosition: 0 },
      queueItemId: "queue_queue-b",
      sourceCommandId: "queue-b",
      steer: { state: "notRequested" },
      text: "queue-b",
    };
    const host = makeHost(records, undefined, (sessionId, queueItemId) =>
      sessionId === String(app.sessionId) && queueItemId === queueItem.queueItemId
        ? queueItem
        : null,
    );
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    const first = sendText("queue-a", String(app.sessionId), "desktop");
    const second = sendText("queue-b", String(app.sessionId), "desktop", {
      requestedDelivery: "queue",
    });
    try {
      expect((await execute(inbox, host, first)).result).toMatchObject({
        delivery: "startNow",
        type: "inputAccepted",
      });
      await firstModelStarted.promise;
      expect(app.runtime.getActiveTurnInfo()).toBeDefined();
      const before = app.runtime.getCuaSubmissionProjection();
      if (before.status !== "candidate") throw new Error("first candidate missing");

      expect((await execute(inbox, host, second)).result).toMatchObject({
        delivery: "queue",
        type: "inputAccepted",
      });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: before.ref.submissionLineageId },
      });

      gateA.resolve();
      await waitFor(
        () => app.runtime.getActiveTurnInfo() === undefined,
        "first turn did not finish",
      );
      await execute(inbox, host, {
        baseRevision: 0,
        clientId: "desktop",
        commandId: "promote-queue-b",
        issuedAt: 1,
        payload: { queueItemId: queueItem.queueItemId },
        sessionId: String(app.sessionId),
        type: "sendQueuedNow",
      } as CommandEnvelope);
      await waitFor(() => {
        const current = app.runtime.getCuaSubmissionProjection();
        return (
          current.status === "candidate" &&
          current.ref.submissionLineageId !== before.ref.submissionLineageId
        );
      }, "queued desktop ticket was not promoted into a new candidate");
      const promoted = app.runtime.getCuaSubmissionProjection();
      if (promoted.status !== "candidate") throw new Error("promoted candidate missing");

      // 重送已提升的队列来源不能创建第二条 lineage。
      expect(await execute(inbox, host, second)).toEqual({ kind: "ack" });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: promoted.ref.submissionLineageId },
      });
      gateB.resolve();
      await waitFor(
        () => app.runtime.getActiveTurnInfo() === undefined,
        "queued turn did not finish",
      );
    } finally {
      gateA.resolve();
      gateB.resolve();
      await app.close?.();
    }
  });

  it("cancels a failed execute ticket and revokes on mobile/unknown input", async () => {
    const { app, record } = await createApp({
      identity: LAUNCH_IDENTITY,
      sessionId: "session-fail",
    });
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      const sendInputSpy = vi
        .spyOn(app, "sendInput")
        .mockRejectedValueOnce(new Error("post-register start failed"));
      await expect(
        execute(inbox, host, sendText("failed-source", String(app.sessionId), "desktop")),
      ).rejects.toThrow("post-register start failed");
      sendInputSpy.mockRestore();
      const direct = await app.runtime.admitPrompt("no ticket", undefined, {
        inputId: "failed-source",
        intent: intent("failed-source", "desktop"),
      });
      if (direct.kind === "started") await direct.completion;
      expect(app.runtime.getCuaSubmissionProjection().status).toBe("unknown");

      await execute(inbox, host, sendText("desktop-ok", String(app.sessionId), "desktop"));
      expect(app.runtime.getCuaSubmissionProjection().status).toBe("candidate");

      await execute(inbox, host, sendText("mobile-input", String(app.sessionId), "mobile"));
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "mobile-steer",
        nativeFence: "unknown",
      });
    } finally {
      await app.close?.();
    }
  });

  it("keeps ordinary chat working when startup identity is absent", async () => {
    const { app, record } = await createApp({ sessionId: "session-no-identity" });
    expect(app.runtime.getCuaSubmissionRegistrar()).toBeUndefined();
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      expect(
        await execute(inbox, host, sendText("plain-chat", String(app.sessionId), "desktop")),
      ).toMatchObject({ kind: "execute" });
      expect(app.runtime.getCuaSubmissionProjection().status).toBe("unknown");
    } finally {
      await app.close?.();
    }
  });

  it("registers createSession.firstInput after record creation and skips mobile first input", async () => {
    const records = new Map<string, V4SessionRecordView>();
    let nextSession = 0;
    const host = makeHost(records, async () => {
      nextSession += 1;
      const sessionId = `created-${nextSession}`;
      const created = await createApp({ identity: LAUNCH_IDENTITY, sessionId });
      records.set(sessionId, created.record);
      return { sessionId };
    });
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      await execute(inbox, host, {
        clientId: "desktop",
        commandId: "create-desktop",
        issuedAt: 1,
        payload: {
          firstInput: { inputOrigin: "desktop", text: "open app" },
          workspaceId: process.cwd(),
        },
        sessionId: null,
        type: "createSession",
      } as CommandEnvelope);
      const desktopRecord = records.get("created-1");
      if (!desktopRecord) throw new Error("desktop record missing");
      expect(desktopRecord.app.runtime.getCuaSubmissionProjection().status).toBe("candidate");

      await execute(inbox, host, {
        clientId: "mobile",
        commandId: "create-mobile",
        issuedAt: 1,
        payload: {
          firstInput: { inputOrigin: "mobile", text: "phone input" },
          workspaceId: process.cwd(),
        },
        sessionId: null,
        type: "createSession",
      } as CommandEnvelope);
      const mobileRecord = records.get("created-2");
      if (!mobileRecord) throw new Error("mobile record missing");
      expect(mobileRecord.app.runtime.getCuaSubmissionProjection().status).toBe("unknown");
    } finally {
      await Promise.all([...records.values()].map((record) => record.app.close?.()));
    }
  });

  it("does not register a mobile ticket when the persistent grant is inactive", async () => {
    const { app, record } = await createApp({ identity: LAUNCH_IDENTITY, sessionId: "session-mg" });
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      // 未授权：mobile 输入不登记 ticket，先有 desktop candidate 时维持 mobile-steer 撤销。
      const grantProbe = vi
        .spyOn(app.runtime, "isCuaLiveSubmissionGrantActive")
        .mockResolvedValue(false);
      expect(
        (await execute(inbox, host, sendText("desktop-first", String(app.sessionId), "desktop")))
          .result,
      ).toMatchObject({ type: "inputAccepted" });
      expect(app.runtime.getCuaSubmissionProjection().status).toBe("candidate");
      // 等 desktop turn 结束即可；撤销断言与 mobile 输入走 steer 还是 queue 无关
      // （observeSteer/observeAdmission 对未授权 mobile 都锁存 mobile-steer 撤销）。
      await waitFor(
        () => app.runtime.getActiveTurnInfo() === undefined,
        "desktop turn did not finish",
      );
      expect(
        (await execute(inbox, host, sendText("mobile-denied", String(app.sessionId), "mobile")))
          .result,
      ).toMatchObject({ type: "inputAccepted" });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "mobile-steer",
      });
      expect(grantProbe).toHaveBeenCalledTimes(1);
      grantProbe.mockRestore();
    } finally {
      await app.close?.();
    }
  });

  it("registers a granted mobile live ticket into a candidate submission", async () => {
    const { app, record } = await createApp({
      identity: LAUNCH_IDENTITY,
      sessionId: "session-mg-granted",
    });
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      // 已授权（项目 allow_always / full access）：mobile 新提交登记 origin=mobile 的
      // live ticket，独立 turn admission 后建立 candidate（spec 2026-11-10 mobile-origin
      // 授权轮次）。idle 起步直发，保证走新 turn admission 而非 steer/queue 路径。
      const grantProbe = vi
        .spyOn(app.runtime, "isCuaLiveSubmissionGrantActive")
        .mockResolvedValue(true);
      expect(
        (await execute(inbox, host, sendText("mobile-granted", String(app.sessionId), "mobile")))
          .result,
      ).toMatchObject({ type: "inputAccepted" });
      expect(app.runtime.getCuaSubmissionProjection().status).toBe("candidate");
      expect(grantProbe).toHaveBeenCalledTimes(1);
      grantProbe.mockRestore();
    } finally {
      await app.close?.();
    }
  });

  it("registers a granted mobile createSession.firstInput after record creation", async () => {
    const records = new Map<string, V4SessionRecordView>();
    let nextSession = 0;
    const host = makeHost(records, async () => {
      nextSession += 1;
      const sessionId = `created-mobile-${nextSession}`;
      const created = await createApp({ identity: LAUNCH_IDENTITY, sessionId });
      vi.spyOn(created.app.runtime, "isCuaLiveSubmissionGrantActive").mockResolvedValue(true);
      records.set(sessionId, created.record);
      return { sessionId };
    });
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    try {
      await execute(inbox, host, {
        clientId: "mobile",
        commandId: "create-mobile-granted",
        issuedAt: 1,
        payload: {
          firstInput: { inputOrigin: "mobile", text: "phone input granted" },
          workspaceId: process.cwd(),
        },
        sessionId: null,
        type: "createSession",
      } as CommandEnvelope);
      const mobileRecord = records.get("created-mobile-1");
      if (!mobileRecord) throw new Error("mobile record missing");
      expect(mobileRecord.app.runtime.getCuaSubmissionProjection().status).toBe("candidate");
    } finally {
      await Promise.all([...records.values()].map((record) => record.app.close?.()));
    }
  });
});
