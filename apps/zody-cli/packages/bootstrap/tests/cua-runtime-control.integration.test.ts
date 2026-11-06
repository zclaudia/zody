import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Duplex, PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  type LogContext,
  type Logger,
  type LoggerFactory,
} from "@zody/contracts";
import type { CommandEnvelope, CommandResult } from "@zody/shared/zody-protocol-v4";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zody-protocol-v4/commands/types.js";
import { sessionFlowHandlers } from "../src/zody-protocol-v4/commands/handlers/session-flow.js";
import { CommandInbox } from "../src/zody-protocol-v4/command-inbox.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const MODEL_SELECTION = {
  providerId: "zai",
  modelId: "glm-4.6",
  options: { reasoningLevel: "high" },
} as const;
const LAUNCH_IDENTITY = {
  hostInstanceId: "host-bootstrap-composition",
  runtimeInstanceId: "agent-bootstrap-composition",
} as const;
const childPath = resolve(
  import.meta.dirname,
  "../../adapters/tests/fixtures/cua-submission-control-child.mjs",
);

type Deferred = { promise: Promise<void>; resolve: () => void };

interface RecordedLog {
  context: Record<string, unknown>;
  level: "debug" | "error" | "info" | "warn";
  message: string;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRecordingLoggerFactory(logs: RecordedLog[]): LoggerFactory {
  const loggerFor = (baseContext: LogContext = {}): Logger => {
    const record = (
      level: RecordedLog["level"],
      message: string,
      context?: LogContext,
    ): void => {
      logs.push({ level, message, context: { ...baseContext, ...context } });
    };
    return {
      child: (context) => loggerFor({ ...baseContext, ...context }),
      debug: (message, context) => record("debug", message, context),
      error: (message, _error, context) => record("error", message, context),
      info: (message, context) => record("info", message, context),
      warn: (message, context) => record("warn", message, context),
    };
  };
  return {
    createLogger: () => loggerFor(),
    setLevel: () => undefined,
    withContext: (context) => loggerFor(context),
  };
}

function modelExecutor(gates: Deferred[], onGenerate?: () => void) {
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

function sendText(commandId: string, sessionId: string, inputOrigin: "desktop" | "mobile") {
  return {
    clientId: "desktop",
    commandId,
    issuedAt: 1,
    payload: { text: commandId, inputOrigin },
    sessionId,
    type: "sendText",
  } as CommandEnvelope;
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWake) => setTimeout(resolveWake, 10));
  }
  throw new Error(message);
}

async function readEvents(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function waitForEvent(path: string, event: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if ((await readEvents(path)).some((item) => item.event === event)) return;
    await new Promise((resolveWake) => setTimeout(resolveWake, 10));
  }
  throw new Error(`control child event did not appear: ${event}`);
}

class FrameClient {
  readonly #writable: Writable;
  readonly #waiters = new Map<string, (frame: Record<string, unknown>) => void>();
  #buffer = "";

  constructor(readable: Readable, writable: Writable) {
    this.#writable = writable;
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        const requestId = typeof frame.requestId === "string" ? frame.requestId : undefined;
        if (requestId) {
          this.#waiters.get(requestId)?.(frame);
          this.#waiters.delete(requestId);
        }
      }
    });
  }

  request(frame: Record<string, unknown> & { requestId: string }): Promise<Record<string, unknown>> {
    const response = new Promise<Record<string, unknown>>((resolveResponse) => {
      this.#waiters.set(frame.requestId, resolveResponse);
    });
    this.#writable.write(`${JSON.stringify(frame)}\n`);
    return response;
  }
}

function createNativeDuplexPair(): {
  server: Duplex;
  client: FrameClient;
} {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  // 服务端读 inbound、写 outbound；测试端相反，模拟 launcher 已建立的私有双工。
  return { server: Duplex.from({ readable: inbound, writable: outbound }), client: new FrameClient(outbound, inbound) };
}

describe("createZodyApp CUA control composition", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function createApp(
    gates: Deferred[],
    onGenerate?: () => void,
    composition: { cuaNativeCapture?: boolean; loggerFactory?: LoggerFactory } = {},
  ) {
    const workspacePath = mkdtempSync(join(tmpdir(), "cua-runtime-control-"));
    createdDirs.push(workspacePath);
    const app = await createRegistryBackedTestApp({
      cuaLaunchIdentity: { ...LAUNCH_IDENTITY, workspaceKey: workspacePath },
      ...(composition.cuaNativeCapture
        ? {
            cuaNativeCapture: {
              connect: async () => {
                throw new Error("native capture must not run during stop observability test");
              },
              producerIncarnation: "producer-stop-observability",
              captureRoot: workspacePath,
            },
          }
        : {}),
      env: {
        HOME: workspacePath,
        ZODY_SESSION_DB_PATH: join(workspacePath, "db.sqlite"),
        ZODY_STORAGE_DIR: workspacePath,
      },
      ...(composition.loggerFactory ? { loggerFactory: composition.loggerFactory } : {}),
      modelExecutor: modelExecutor(gates, onGenerate),
      runtimeConfig: {
        mcp: { enabled: false },
        modelSelection: MODEL_SELECTION,
        workingDirectory: workspacePath,
      },
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

  function makeHost(records: Map<string, V4SessionRecordView>): V4CommandCoreHost {
    return {
      getRecord: (sessionId: string) => records.get(sessionId),
      logger: { info: vi.fn(), warn: vi.fn() },
      getInputRoutingMode: () => "startNow",
      ensureModelReady: vi.fn(async () => undefined),
      afterLegacyStateMutation: vi.fn(async () => undefined),
      admitInputCommand: vi.fn(async () => null),
      cancelInputCommand: vi.fn(async () => undefined),
    } as unknown as V4CommandCoreHost;
  }

  async function execute(
    inbox: CommandInbox,
    host: V4CommandCoreHost,
    envelope: CommandEnvelope,
  ): Promise<CommandResult | undefined> {
    const outcome = await inbox.handle(envelope);
    if (outcome.kind === "ack") return undefined;
    const admitted = {
      ...outcome.envelope,
      __v4Admission: {
        admissionSeq: outcome.admissionSeq,
        admittedAt: outcome.admittedAt,
        queueItemId: outcome.queueItemId,
      },
    } as CommandEnvelope;
    const result = await sessionFlowHandlers.sendText(host, admitted);
    outcome.settle({ status: "accepted", ...(result ? { result } : {}) });
    return result;
  }

  it("takes the live CommandInbox turn through createCuaControlSession and a real child", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstModelStarted = deferred();
    const logs: RecordedLog[] = [];
    const { app, record, workspacePath } = await createApp(
      [firstGate, secondGate],
      firstModelStarted.resolve,
      {
        cuaNativeCapture: true,
        loggerFactory: createRecordingLoggerFactory(logs),
      },
    );
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    const launch = {
      command: process.execPath,
      args: [childPath, "normal", join(workspacePath, "first.log")],
    };

    try {
      // 没有真实活动 turn 时，可信入口拒绝而不是创建假 scope/假 child。
      expect(app.createCuaControlSession({ launch })).toBeUndefined();

      await execute(inbox, host, sendText("live-source-1", String(app.sessionId), "desktop"));
      await firstModelStarted.promise;
      await waitFor(() => app.runtime.getActiveTurnInfo() !== undefined, "turn did not start");
      await new Promise((resolveWake) => setImmediate(resolveWake));

      const first = app.createCuaControlSession({ launch });
      if (!first) throw new Error("createCuaControlSession refused a live turn");
      await first.start();
      await waitForEvent(join(workspacePath, "first.log"), "ready");

      const candidate = app.runtime.getCuaSubmissionProjection();
      if (candidate.status !== "candidate") throw new Error("live candidate missing");

      // 正常 turn 结束只结束 binding/关闭 consumer，不撤销仍有效的 lineage。
      firstGate.resolve();
      await waitFor(
        () => app.runtime.getActiveTurnInfo() === undefined,
        "first turn did not finish",
      );
      await waitFor(
        () => first.diagnostics().control === "closed",
        "normal turn end did not close the consumer",
      );
      await first.cleanup();
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "candidate",
        ref: { submissionLineageId: candidate.ref.submissionLineageId },
      });
      expect(
        (await readEvents(join(workspacePath, "first.log"))).some(
          (event) => event.event === "request",
        ),
      ).toBe(false);

      await execute(inbox, host, sendText("live-source-2", String(app.sessionId), "desktop"));
      await waitFor(() => app.runtime.getActiveTurnInfo() !== undefined, "second turn did not start");
      await new Promise((resolveWake) => setImmediate(resolveWake));

      const second = app.createCuaControlSession({
        launch: {
          command: process.execPath,
          args: [childPath, "normal", join(workspacePath, "second.log")],
        },
      });
      if (!second) throw new Error("createCuaControlSession refused the second live turn");
      await second.start();
      expect(
        logs.some((entry) => entry.context.event === "cua.submission.owner_revoked"),
      ).toBe(false);
      const beforeStop = app.runtime.getCuaSubmissionProjection();
      if (beforeStop.status !== "candidate") throw new Error("stop candidate missing");
      const stopped = await second.stop();
      expect(stopped).toMatchObject({
        authorityRevoked: true,
        controlForwarded: true,
        nativeFence: "unknown",
        machineLease: "unavailable",
        stopComplete: false,
      });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "user-stop",
      });
      const revoked = app.runtime.getCuaSubmissionProjection();
      if (revoked.status !== "revoked") throw new Error("stop did not revoke the candidate");
      const revocationLog = logs.find(
        (entry) => entry.context.event === "cua.submission.owner_revoked",
      );
      expect(revocationLog).toMatchObject({
        level: "info",
        message: "CUA submission owner revoked",
        context: {
          event: "cua.submission.owner_revoked",
          projectionStatus: "revoked",
          reason: "user-stop",
          revision: revoked.ref.authorizationRevision,
          lineageId: beforeStop.ref.submissionLineageId,
        },
      });
      const revocationLogText = JSON.stringify(revocationLog?.context);
      expect(revocationLogText).not.toContain(workspacePath);
      expect(revocationLogText).not.toContain("live-source-2");
      await second.cleanup();
      secondGate.resolve();
      await waitFor(
        () => app.runtime.getActiveTurnInfo() === undefined,
        "second turn did not finish",
      );
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await app.close?.();
    }
  });

  it("exposes the live runtime scope through bootstrap/check/revoke over a trusted Duplex", async () => {
    const gate = deferred();
    const modelStarted = deferred();
    const { app, record } = await createApp([gate], modelStarted.resolve);
    const records = new Map([[String(app.sessionId), record]]);
    const host = makeHost(records);
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });
    const { server, client } = createNativeDuplexPair();

    try {
      expect(
        app.createCuaNativeAuthoritySession({
          stream: server,
          producerIncarnation: "native-producer",
        }),
      ).toBeUndefined();

      await execute(inbox, host, sendText("native-source", String(app.sessionId), "desktop"));
      await modelStarted.promise;
      await waitFor(() => app.runtime.getActiveTurnInfo() !== undefined, "native turn did not start");
      const candidate = app.runtime.getCuaSubmissionProjection();
      if (candidate.status !== "candidate") throw new Error("live candidate missing");

      const session = app.createCuaNativeAuthoritySession({
        stream: server,
        producerIncarnation: "native-producer",
      });
      if (!session) throw new Error("createCuaNativeAuthoritySession refused a live turn");
      expect(session.scope.ref).toEqual(candidate.ref);

      const bootstrap = await client.request({
        requestId: "native-bootstrap",
        method: "bootstrap",
        payload: {},
      });
      expect(bootstrap.result).toMatchObject({
        ok: true,
        producerIncarnation: "native-producer",
        ref: session.scope.ref,
      });

      const check = await client.request({
        requestId: "native-check",
        method: "check",
        payload: {
          ref: session.scope.ref,
          traceId: session.scope.traceId,
          producerIncarnation: "native-producer",
          runId: session.scope.runId,
          turnId: session.scope.turnId,
        },
      });
      expect(check.result).toMatchObject({ ok: true });

      const revoke = await client.request({
        requestId: "native-revoke",
        method: "revoke",
        payload: { ref: session.scope.ref, traceId: session.scope.traceId },
      });
      expect(revoke.result).toMatchObject({
        ok: true,
        revocation: { status: "revoked" },
      });

      await expect(session.waitForClose()).resolves.toMatchObject({
        ownerRevoked: true,
        authorityRevoke: "revoked",
        nativeFence: "unknown",
        machineLease: "unavailable",
        stopComplete: false,
      });
      expect(session.diagnostics).toMatchObject({
        executable: false,
        candidateIsGrant: false,
        nativeHelper: "unavailable",
        nativeFence: "unknown",
        stopComplete: false,
      });
      expect(app.runtime.getCuaSubmissionProjection()).toMatchObject({
        status: "revoked",
        revocationReason: "user-stop",
      });
    } finally {
      gate.resolve();
      await app.close?.();
    }
  });
});
