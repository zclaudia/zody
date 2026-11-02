import { randomUUID } from "node:crypto";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { JsInputJsonSchema } from "@zody/contracts/tools/node-repl";
import type { ComputerUseRuntime } from "@zody/zody-cua";
import { z } from "zod";
import {
  captureNodeReplBrowserBrokerFromEnvironment,
  type NodeReplBrowserBrokerConnection,
} from "./browser-bridge.js";
import {
  createNodeReplCuaBroker,
  resolveTrustedCuaContext,
  type NodeReplCuaBroker,
} from "./cua-broker.js";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { captureComputerUseRuntimeFromEnvironment } from "./cua-runtime.js";
import type { NodeReplExecuteInput, NodeReplExecutor } from "./node-repl-session-executor.js";
import { buildRequestMeta, requestSessionKey } from "./request-context.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";
import { createWorkerNodeReplExecutor } from "./worker-executor.js";

const MAX_SYNC_TIMEOUT_MS = 120_000;

const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    title: z.string().min(1).max(120).optional(),
  })
  .strict();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export interface NodeReplMcpRuntime {
  dispose(): Promise<void>;
  server: Server;
}

export interface NodeReplMcpRuntimeOptions {
  executeJs?: NodeReplExecutor;
  cuaRuntime?: ComputerUseRuntime;
  /**
   * 显式传入共享 producer 时默认 borrowed；只有本 runtime 自己从环境创建时才默认 owned。
   * 避免多个 MCP connection 各自 dispose 同一个 Helper 连接。
   */
  cuaRuntimeOwnership?: "owned" | "borrowed";
  browserBroker?: NodeReplBrowserBrokerConnection;
  /**
   * 旧 Worker executor 的入口 URL。必须传 bundle 的 server 入口：拆分模块后
   * worker-executor 自身不含 worker 启动分支，错误的 URL 只会得到一个空转 Worker。
   */
  workerUrl?: URL;
}

export function createNodeReplMcpRuntime(
  input: NodeReplMcpRuntimeOptions = {},
): NodeReplMcpRuntime {
  if (!input.executeJs && !input.workerUrl) {
    throw new Error(
      "node_repl runtime requires executeJs or the bundled server worker URL; refusing to guess a worker entry",
    );
  }
  const executeJs = input.executeJs ?? createWorkerNodeReplExecutor(input.workerUrl!);
  const browserBroker = input.browserBroker ?? captureNodeReplBrowserBrokerFromEnvironment();
  const ownsCuaRuntime =
    input.cuaRuntimeOwnership === "owned" ||
    (input.cuaRuntimeOwnership === undefined && input.cuaRuntime === undefined);
  // borrowed 是“调用方持有 producer，本 runtime 绝不接管”的显式声明：即使 producer 缺席，
  // 也不能再从环境补建一个没人 dispose 的 runtime。
  const cuaRuntime =
    input.cuaRuntime ??
    (input.cuaRuntimeOwnership === "borrowed"
      ? undefined
      : captureComputerUseRuntimeFromEnvironment());
  const cuaBroker = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, platform: process.platform })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  const activeInvocations = new Set<Promise<unknown>>();
  const disposeController = new AbortController();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const disposedError = () => new Error("node_repl runtime is disposed");
  const raceDispose = async <T>(promise: Promise<T>): Promise<T> => {
    if (disposeController.signal.aborted) throw disposedError();
    return await new Promise<T>((resolve, reject) => {
      const onDispose = () => reject(disposedError());
      disposeController.signal.addEventListener("abort", onDispose, { once: true });
      promise.then(
        (value) => {
          disposeController.signal.removeEventListener("abort", onDispose);
          resolve(value);
        },
        (error) => {
          disposeController.signal.removeEventListener("abort", onDispose);
          reject(error);
        },
      );
    });
  };

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    try {
      await raceDispose(previous);
      if (disposed) throw disposedError();
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw disposedError();
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name !== "js") invalidParams(`Tool ${name} not found`);

    const args = parseToolInput(jsInputSchema, request.params.arguments, name);
    return await serialized(sessionKey, async () => {
      if (!args.code) {
        return {
          content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
          isError: true,
        };
      }
      const callController = new AbortController();
      activeCalls.add(callController);
      const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
      const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
      const signal = AbortSignal.any([
        extra.mcpReq.signal,
        callController.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const invocationId = randomUUID();
      const invocation = runInvocation({
        browserBroker,
        callMeta,
        cuaBroker,
        executeJs,
        invocationId,
        signal,
        syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
        code: args.code,
      });
      activeInvocations.add(invocation);
      try {
        return await invocation;
      } finally {
        activeInvocations.delete(invocation);
        activeCalls.delete(callController);
      }
    });
  });

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposeController.abort(disposedError());
    for (const controller of activeCalls) controller.abort(disposedError());
    activeCalls.clear();
    // 先同步启动 broker 关闭（内部先撤 admission），不要等 executeJs 返回后才开始 drain。
    const brokerClose = cuaBroker?.close();
    disposePromise = (async () => {
      queues.clear();
      const work: Promise<unknown>[] = [...activeInvocations];
      if (brokerClose) work.push(brokerClose);
      if (work.length > 0) await Promise.allSettled(work);
      try {
        await brokerClose;
      } finally {
        if (ownsCuaRuntime) await cuaRuntime?.dispose();
      }
    })();
    return disposePromise;
  }

  return { server, dispose };
}

async function runInvocation(input: {
  browserBroker?: NodeReplBrowserBrokerConnection;
  callMeta: Record<string, unknown>;
  code: string;
  cuaBroker?: NodeReplCuaBroker;
  executeJs: NodeReplExecutor;
  invocationId: string;
  signal: AbortSignal;
  syncTimeoutMs: number;
}) {
  let capability: NodeReplCuaBrokerConnection | undefined;
  const revoke = async () => {
    if (input.cuaBroker) await input.cuaBroker.revoke(input.invocationId);
  };
  // abort 必须立即撤销本次 capability admission；不能等 executeJs/子进程 finally，
  // 否则后代继续持有 fd、旧 token 仍可能通过 broker 校验。
  const onAbort = () => {
    void revoke().catch(() => undefined);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const context = resolveTrustedCuaContext(input.callMeta);
    if (input.cuaBroker && context && !input.signal.aborted) {
      capability = await input.cuaBroker.mint({
        invocationId: input.invocationId,
        context,
      });
      // abort 可能发生在 mint await 期间；mint 完成后必须再撤销一次，避免留下新映射。
      if (input.signal.aborted) {
        await revoke();
        capability = undefined;
      }
    }
  } catch {
    // CUA broker 不可用不能阻断通用 JavaScript；bridge 会在缺少 capability 时明确 unavailable。
    capability = undefined;
  }

  try {
    if (input.signal.aborted) throw input.signal.reason;
    const executeInput: NodeReplExecuteInput = {
      code: input.code,
      requestMeta: input.callMeta,
      signal: input.signal,
      syncTimeoutMs: input.syncTimeoutMs,
      cuaBroker: capability,
      browserBroker: input.browserBroker,
    };
    const result = await input.executeJs(executeInput);
    if (input.signal.aborted) throw input.signal.reason;
    return toMcpRunResult(result);
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (capability) await revoke();
  }
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}
