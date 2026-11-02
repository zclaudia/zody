/**
 * 原生组合候选的受控 fixture 入口（测试构建源，不是生产导出）。
 *
 * 目的：在固定签名 Node 资源内驱动真实 `create-app → CommandInbox → runtime
 * scope → adapters native authority session`，让 R11 原生 supervisor 通过 FD3
 * 完成 bootstrap/check/revoke。身份（ref/trace/run/turn）全部来自真实 runtime
 * scope；这里只生成本次 launcher 唯一的 producer incarnation。Host/workspace 身份是
 * fixture 显式传入的 synthetic 值；ref/app/run/turn 只来自真实 runtime scope。entry
 * 不创建 authority、不 admitLive、不补造 ref/run/turn。
 *
 * Host 身份与模型均为显式 synthetic fixture，不声称安装版 UI 或完整产品启动。
 * `createRegistryBackedTestApp` 只是对真实 `createZCodeApp` 的纯 wrapper（无 vitest），
 * 复用它是为了让模型/provider 依赖不读真实配置。该文件只作为 esbuild 源入口；
 * 不得被 vitest 或产品公开出口引用。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootTraceContext } from "@zcode/contracts";
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../../src/zcode-protocol-v4/commands/types.js";
import { sessionFlowHandlers } from "../../src/zcode-protocol-v4/commands/handlers/session-flow.js";
import { CommandInbox } from "../../src/zcode-protocol-v4/command-inbox.js";
import { createRegistryBackedTestApp } from "../helpers/registry-backed-test-app.js";

// 与 R11 authority-entry 相同：supervisor 把私有 NDJSON 通道接到 FD3。
const AUTHORITY_FD = 3;
const SYNTHETIC_HOST_INSTANCE_ID = "synthetic-host-cua-product-wiring";
const SYNTHETIC_RUNTIME_INSTANCE_ID = "synthetic-runtime-cua-product-wiring";
const MODEL_SELECTION = {
  providerId: "zai",
  modelId: "glm-4.6",
  options: { reasoningLevel: "high" },
} as const;

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function audit(event: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        source: "cua-native-owner-entry",
        synthetic: true,
        event,
        at: new Date().toISOString(),
        ...fields,
      })}\n`,
    );
  } catch {
    // 审计失败不能改变控制路径；stderr 仅用于开发证据。
  }
}

function heldModel(gate: Deferred, started: Deferred) {
  return {
    async generateText() {
      started.resolve();
      await gate.promise;
      return {
        finishReason: "stop",
        text: "held",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never;
}

function sendText(commandId: string, sessionId: string) {
  return {
    clientId: "synthetic-desktop",
    commandId,
    issuedAt: 1,
    payload: { text: commandId, inputOrigin: "desktop" },
    sessionId,
    type: "sendText",
  } as CommandEnvelope;
}

function makeHost(records: Map<string, V4SessionRecordView>): V4CommandCoreHost {
  return {
    getRecord: (sessionId: string) => records.get(sessionId),
    logger: { info: () => undefined, warn: () => undefined },
    getInputRoutingMode: () => "startNow",
    ensureModelReady: async () => undefined,
    afterLegacyStateMutation: async () => undefined,
    admitInputCommand: async () => null,
    cancelInputCommand: async () => undefined,
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWake) => setTimeout(resolveWake, 10));
  }
  throw new Error("timed out waiting for live runtime turn");
}

async function main(): Promise<void> {
  // darwin arm64 候选边界：entry 只在固定签名 Node 的 darwin arm64 资源内运行。
  // 这同时固定了 win32-only koffi 动态 import 被平台裁剪、不会在本候选执行的边界。
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    audit("platform-refused", { platform: process.platform, arch: process.arch });
    throw new Error(
      `cua-native-owner-entry supports darwin arm64 only, got ${process.platform} ${process.arch}`,
    );
  }
  const producerIncarnation = `producer-${randomUUID()}`;
  const workspacePath = await mkdtemp(join(tmpdir(), "zody-cua-native-owner-"));
  const env = {
    HOME: workspacePath,
    ZCODE_SESSION_DB_PATH: join(workspacePath, "db.sqlite"),
    ZCODE_STORAGE_DIR: workspacePath,
  };

  const gate = deferred();
  const modelStarted = deferred();
  const stream = new Socket({ fd: AUTHORITY_FD, readable: true, writable: true });
  stream.on("error", (error) => {
    audit("stream-error", { message: String(error?.message ?? error) });
  });

  let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
  try {
    app = await createRegistryBackedTestApp({
      cuaLaunchIdentity: {
        hostInstanceId: SYNTHETIC_HOST_INSTANCE_ID,
        runtimeInstanceId: SYNTHETIC_RUNTIME_INSTANCE_ID,
        workspaceKey: workspacePath,
      },
      env,
      modelExecutor: heldModel(gate, modelStarted),
      runtimeConfig: {
        mcp: { enabled: false },
        modelSelection: MODEL_SELECTION,
        workingDirectory: workspacePath,
        titleGeneration: { enabled: false },
      },
      skipUserConfig: true,
    });
    audit("app-created", {
      sessionId: String(app.sessionId),
      model: MODEL_SELECTION,
      hostInstanceId: SYNTHETIC_HOST_INSTANCE_ID,
    });

    const record: V4SessionRecordView = {
      app,
      persistence: "immediate",
      traceContext: createRootTraceContext({ sessionId: app.sessionId }),
      workspace: { workspacePath },
    };
    const host = makeHost(new Map([[String(app.sessionId), record]]));
    const inbox = new CommandInbox({ getLogEpoch: () => "epoch-1", getRevision: () => 0 });

    await execute(inbox, host, sendText("synthetic-live-source", String(app.sessionId)));
    await modelStarted.promise;
    await waitFor(() => app!.runtime.getActiveTurnInfo() !== undefined, 10_000);
    await new Promise((resolveWake) => setImmediate(resolveWake));

    const session = app.createCuaNativeAuthoritySession?.({ stream, producerIncarnation });
    if (!session) {
      audit("scope-refused", { producerIncarnation });
      throw new Error("createCuaNativeAuthoritySession refused the synthetic live turn");
    }
    audit("scope-bound", {
      producerIncarnation,
      traceId: session.scope.traceId,
      runId: session.scope.runId,
      turnId: session.scope.turnId,
      ref: session.scope.ref,
    });

    const closed = await session.waitForClose();
    audit("closed", {
      reason: closed.reason,
      ownerRevoked: closed.ownerRevoked,
      authorityRevoke: closed.authorityRevoke,
      transportClosed: closed.transportClosed,
      nativeFence: closed.nativeFence,
      stopComplete: closed.stopComplete,
    });
  } finally {
    gate.resolve();
    stream.destroy();
    await app?.close?.();
    await rm(workspacePath, { recursive: true, force: true });
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    audit("fatal", {
      message: String(error?.message ?? error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  },
);
