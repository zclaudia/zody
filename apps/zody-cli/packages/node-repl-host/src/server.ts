import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { NodeReplRunResult } from "@zody/core/repl";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { isCellInvocation, runCellMain } from "./cell-executor.js";
import { isControlOnlyInvocation, runControlOnlyMain } from "./control-only.js";
import { captureComputerUseRuntimeFromEnvironment } from "./cua-runtime.js";
import { createNodeReplMcpRuntime, type NodeReplMcpRuntime } from "./node-repl-mcp-runtime.js";
import { createInProcessNodeReplExecutor } from "./node-repl-session-executor.js";
import {
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
  isDirectMcpEntrypoint,
} from "./process-lifecycle.js";
import { isWorkerCallData } from "./worker-executor.js";

export const NODE_REPL_MCP_PROCESS_TITLE = "zody-node-repl-mcp";
const NODE_REPL_CELL_PROCESS_TITLE = "zody-node-repl-cell";

export { captureComputerUseRuntimeFromEnvironment } from "./cua-runtime.js";
export {
  createNodeReplMcpRuntime,
  type NodeReplMcpRuntime,
  type NodeReplMcpRuntimeOptions,
} from "./node-repl-mcp-runtime.js";
export {
  createCuaCaptureComputerUseRuntime,
  type CuaCaptureComputerUseRuntimeOptions,
  type CuaCaptureExpectation,
  type CuaCaptureImageResult,
  type CuaCaptureTarget,
} from "./cua-capture-runtime.js";
export {
  createCuaNodeReplMcpPort,
  createCuaNodeReplMcpPortFactory,
  type CuaNodeReplMcpPortCaptureOptions,
  type CuaNodeReplMcpPortFactory,
  type CuaNodeReplMcpPortInput,
} from "./cua-node-repl-mcp-port.js";
export {
  createInProcessNodeReplExecutor,
  type NodeReplExecuteInput,
  type NodeReplExecutor,
} from "./node-repl-session-executor.js";
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

export async function main(): Promise<void> {
  // control-only 诊断入口必须先于 MCP/cell 分支返回：它只读私有 bootstrap/control fd，
  // 不注册工具、不加载模型输入，也不创建 Worker 或 cell。
  if (isControlOnlyInvocation(process.argv)) {
    process.exit(await runControlOnlyMain());
  }

  // cell 模式只走私有 fd3/fd4，不启动 MCP stdio；共享 bundle 因此不需要新增入口文件。
  if (isCellInvocation(process.argv)) {
    process.title = NODE_REPL_CELL_PROCESS_TITLE;
    process.exit(await runCellMain());
  }

  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // main() 返回前先捕获 producer；下面的 MCP factory 延迟到 initialize，届时环境可能已清理。
  const computerUseRuntime = captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      // 多个 connection 共享同一个 producer；borrowed runtime 只关闭自己的 broker，
      // owned producer 由本 shutdown 在最后唯一 await 一次。
      const runtime = createNodeReplMcpRuntime({
        cuaRuntime: computerUseRuntime,
        cuaRuntimeOwnership: "borrowed",
        // 只有当前 server bundle 同时包含 main/cell/worker 三个入口。
        workerUrl: new URL(import.meta.url),
      });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
      try {
        await computerUseRuntime?.dispose();
      } finally {
        await handle.close().catch(() => undefined);
        process.exit(0);
      }
    })();
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  const controller = new AbortController();
  void execute({
    code: workerData.code,
    requestMeta: workerData.requestMeta,
    signal: controller.signal,
    syncTimeoutMs: workerData.syncTimeoutMs,
    cuaBroker: workerData.cuaBroker,
    browserBroker: workerData.browserBroker,
  })
    .then((result) => parentPort?.postMessage(result))
    .catch((error) => {
      parentPort?.postMessage({
        logs: "",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies NodeReplRunResult);
    });
}

// 固定 Node 以 `--input-type=module - CELL_RUN_FLAG` 从私有 stdin 接收已核验快照时，
// argv[1] 是 "-"，import.meta.url 是 cwd/[eval1]，isDirectMcpEntrypoint 不会命中。
// 这里只认显式 stdin+cell 模式启动 main，不把普通 import/普通直接执行入口放宽。
const isStdinCellEntrypoint =
  isMainThread &&
  process.argv[1] === "-" &&
  isCellInvocation(process.argv) &&
  process.execArgv.includes("--input-type=module");

if (
  isMainThread &&
  (isStdinCellEntrypoint || (await isDirectMcpEntrypoint(import.meta.url, process.argv[1])))
) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
