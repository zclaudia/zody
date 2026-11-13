import { randomUUID } from "node:crypto";
import type { NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { CuaHelperCellTransport } from "./cell-helper-transport.js";
import { runCellChild } from "./cell-child-transport.js";
import {
  CELL_PROTOCOL_VERSION,
  CELL_REQUEST_MAX_BYTES,
  CELL_RESPONSE_MAX_BYTES,
  encodeCellRequest,
  type CellDocumentationRoots,
  type CellRequest,
} from "./cell-protocol.js";
import {
  DEFAULT_BROWSER_DOCUMENTATION_ROOT,
  DEFAULT_CUA_DOCUMENTATION_ROOT,
  type NodeReplExecutor,
} from "./node-repl-session-executor.js";
import {
  buildCellEnvironment,
  isSeaRuntime,
  resolveCellLaunch,
  resolveCellSnapshotLaunch,
  type CellLaunch,
} from "./subprocess-launch.js";

const DEFAULT_ABORT_GRACE_MS = 500;

export interface SubprocessNodeReplExecutorOptions {
  /**
   * 必填：已打包的 server.js/mjs。
   *
   * 不能默认取 `import.meta.url`：源码模式下会指向本模块（必然被拒绝），tsc 产物也不是
   * MCP/cell 入口。调用方必须显式传入真正可执行的 server bundle。
   */
  serverPath: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  browserBroker?: NodeReplBrowserBrokerConnection;
  documentationRoots?: Partial<CellDocumentationRoots>;
  cuaSdk?: CellRequest["cuaSdk"];
  requestMaxBytes?: number;
  responseMaxBytes?: number;
  abortGraceMs?: number;
  platform?: NodeJS.Platform;
  isSea?: () => boolean;
  /** 测试/打包注入；默认按 execPath + serverPath 解析。 */
  launch?: CellLaunch;
  /** 仅显式可信 composition 设置；默认保持原启动参数。 */
  jitless?: boolean;
  /**
   * 已由可信 composition 在同句柄校验、解码的 node-repl server 源码快照。
   *
   * 提供时强制走固定 stdin ESM 入口，serverPath 只作诊断，不再打开执行；不能与 launch
   * 注入或 SEA 组合，防止调用方用另一条启动形状绕过快照。
   */
  sourceSnapshot?: string;
  /**
   * CUA composition 的 Helper 私有 cell 传输。提供时不再 spawn；endpoint 缺失由
   * transport 明确失败，绝不回退到按 serverPath 启动。
   */
  helperCell?: CuaHelperCellTransport;
}

/**
 * 候选 subprocess executor：每次调用启动一个真实 cell 子进程。
 *
 * 默认产品 executor 仍是同进程 Worker；本入口不作为生产隔离声明，也不证明 OS 沙箱、
 * 签名、TCC 或后代进程清理。
 */
export function createSubprocessNodeReplExecutor(
  options: SubprocessNodeReplExecutorOptions,
): NodeReplExecutor {
  const cwd = options.cwd ?? process.cwd();
  const env = buildCellEnvironment(
    options.env ?? process.env,
    options.platform ?? process.platform,
  );
  const sourceSnapshot = options.sourceSnapshot;
  if (sourceSnapshot !== undefined) {
    if (typeof sourceSnapshot !== "string" || sourceSnapshot.length === 0) {
      throw new Error("node_repl cell source snapshot is required");
    }
    if (options.launch !== undefined) {
      throw new Error("node_repl cell source snapshot cannot be combined with a launch override");
    }
    if (options.isSea?.() ?? isSeaRuntime()) {
      throw new Error("node_repl cell source snapshot is not supported in SEA");
    }
  }
  const launch =
    sourceSnapshot !== undefined
      ? resolveCellSnapshotLaunch({ execPath: process.execPath })
      : (options.launch ??
        resolveCellLaunch({
          execPath: process.execPath,
          serverPath: options.serverPath,
          sea: options.isSea?.() ?? isSeaRuntime(),
          ...(options.jitless === undefined ? {} : { jitless: options.jitless }),
        }));
  // 固定快照在构造时复制，避免调用方稍后改写受信资源。
  const cuaSdk = options.cuaSdk ? Object.freeze({ ...options.cuaSdk }) : undefined;
  const documentationRoots: CellDocumentationRoots = {
    browser: options.documentationRoots?.browser ?? DEFAULT_BROWSER_DOCUMENTATION_ROOT,
    cua: options.documentationRoots?.cua ?? DEFAULT_CUA_DOCUMENTATION_ROOT,
  };
  const requestMaxBytes = options.requestMaxBytes ?? CELL_REQUEST_MAX_BYTES;
  const responseMaxBytes = options.responseMaxBytes ?? CELL_RESPONSE_MAX_BYTES;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;

  return async (input) => {
    if (input.signal.aborted) throw input.signal.reason;
    const browserBroker = input.browserBroker ?? options.browserBroker;
    const invocationId = input.cuaBroker?.invocationId ?? randomUUID();
    const request: CellRequest = {
      version: CELL_PROTOCOL_VERSION,
      invocationId,
      code: input.code,
      requestMeta: input.requestMeta,
      syncTimeoutMs: input.syncTimeoutMs,
      documentationRoots,
      ...(cuaSdk ? { cuaSdk } : {}),
      ...(input.cuaBroker
        ? {
            cuaCapability: {
              socketPath: input.cuaBroker.socketPath,
              token: input.cuaBroker.token,
              invocationId: input.cuaBroker.invocationId,
            },
          }
        : {}),
      ...(browserBroker
        ? {
            browserCapability: {
              socketPath: browserBroker.socketPath,
              token: browserBroker.token,
            },
          }
        : {}),
    };
    if (options.helperCell !== undefined) {
      return await options.helperCell.run({
        line: encodeCellRequest(request, requestMaxBytes),
        request,
        responseMaxBytes,
        signal: input.signal,
      });
    }
    return await runCellChild({
      abortGraceMs,
      args: launch.args,
      command: launch.command,
      cwd,
      env,
      line: encodeCellRequest(request, requestMaxBytes),
      request,
      responseMaxBytes,
      signal: input.signal,
      ...(sourceSnapshot === undefined ? {} : { stdinSource: sourceSnapshot }),
    });
  };
}
