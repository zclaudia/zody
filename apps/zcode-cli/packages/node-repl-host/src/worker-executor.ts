import { Worker } from "node:worker_threads";
import type { NodeReplRequestMeta, NodeReplRunResult } from "@zcode/core/repl";
import type { NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import type { NodeReplExecuteInput, NodeReplExecutor } from "./node-repl-session-executor.js";

export const WORKER_KIND = "zcode-node-repl-call";

export interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
  browserBroker?: NodeReplBrowserBrokerConnection;
}

/**
 * 旧默认执行路径：每次调用一个 Worker。它仍是同进程隔离，不能作为生产安全边界。
 *
 * 拆分模块后不能再用本文件的 `import.meta.url` 启动 Worker：那会加载
 * worker-executor.js 本身（没有 worker 分支）。调用方必须传入真正的 server 入口；
 * 只有 bundle 里的 server 模块同时包含 cell/main/worker 三个入口。
 */
export function createWorkerNodeReplExecutor(workerUrl: URL): NodeReplExecutor {
  return async (input) => await executeJsInWorker(workerUrl, input);
}

async function executeJsInWorker(
  workerUrl: URL,
  input: NodeReplExecuteInput,
): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const data: WorkerCallData = {
    code: input.code,
    kind: WORKER_KIND,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
    cuaBroker: input.cuaBroker,
    browserBroker: input.browserBroker,
  };
  const worker = new Worker(workerUrl, { workerData: data });
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error !== undefined) rejectRun(error);
      else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled) {
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
      }
    });
    if (input.signal.aborted) onAbort();
  });
}

export function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}
