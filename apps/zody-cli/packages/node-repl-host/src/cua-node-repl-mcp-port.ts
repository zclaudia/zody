import type { CuaObservationRequest } from "@zody/zody-cua/observation-contract";
import { createCuaObservationRuntime } from "./cua-observation-runtime.js";
// 使用 MCP 公开子入口，避免总入口将无关 contracts 装入 cell bundle。
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  buildZodyMcpDualMetaEntry,
  MCP_TOOL_META_TIMEOUT_MAX_MS,
  MCP_TOOL_META_TIMEOUT_MIN_MS,
  ZODY_MCP_META_KEY_COMPAT,
} from "@zody/contracts/mcp";
import type {
  JsonSchema,
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@zody/contracts";
import {
  createCuaCaptureComputerUseRuntime,
  type CuaCaptureExpectation,
  type CuaCaptureImageResult,
  type CuaCaptureTarget,
} from "./cua-capture-runtime.js";
import {
  createCuaHelperCellTransport,
  cuaHelperSourceSha256,
  type CuaHelperCellTransport,
} from "./cell-helper-transport.js";
import { CELL_RUN_FLAG } from "./cell-protocol.js";
import { createNodeReplMcpRuntime } from "./node-repl-mcp-runtime.js";
import {
  createSubprocessNodeReplExecutor,
  type SubprocessNodeReplExecutorOptions,
} from "./subprocess-executor.js";
import { isSeaRuntime } from "./subprocess-launch.js";

const NODE_REPL_SERVER_NAME = "node_repl";
// request-context 键由 contracts 单一来源提供（canonical `com.zody/...` + legacy `com.zcode/...`），
// 不在本文件重复字面值；两种表示同引用写入，见 buildRequestMeta。
// 本地 in-memory server 的默认工具预算与 factory 的 localServerConfig 保持一致。
const DEFAULT_LOCAL_TOOL_TIMEOUT_MS = 600_000;

export interface CuaNodeReplMcpPortCaptureOptions {
  readonly signal?: AbortSignal;
  readonly expected: CuaCaptureExpectation;
}

export interface CuaNodeReplMcpPortInput {
  /** 原有 MCP 端口；除 node_repl 以外的生命周期、资源和工具全部委托给它。 */
  readonly port: McpPort;
  /** app 的显式 captureCuaOnce 闭包；expected 来自真实主工具调用上下文。 */
  captureOnce(
    target: CuaCaptureTarget,
    options: CuaNodeReplMcpPortCaptureOptions,
  ): Promise<CuaCaptureImageResult>;
  /** app 是否拥有原端口；true 时 wrapper.close 一并关闭原端口。 */
  observationOnce?(
    request: CuaObservationRequest,
    options: CuaNodeReplMcpPortCaptureOptions,
  ): Promise<CuaCaptureImageResult>;
  verifyObservationScope?(expected: CuaCaptureExpectation): boolean | Promise<boolean>;
  readonly closePort: boolean;
  /** 已打包的 node-repl server bundle 固定资源名；只作诊断，不作为执行路径。 */
  readonly serverPath: string;
  /**
   * 已由可信 composition 在同一句柄校验并解码的 server 源码快照。
   *
   * CUA factory 必须提供；缺失直接失败，绝不退回 serverPath 重新打开执行。
   */
  readonly sourceSnapshot: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** server 级工具超时；工具 `_meta.timeoutMs` 优先，最终按 MCP 合同上下限收敛。 */
  readonly timeoutMs?: number;
  /**
   * 只允许可信 composition 调整环境/资源上限；launch/isSea 不开放，
   * 防止绕过固定 execPath + sealed serverPath 的启动形状。
   */
  readonly subprocess?: Omit<
    SubprocessNodeReplExecutorOptions,
    "serverPath" | "sourceSnapshot" | "launch" | "isSea" | "jitless" | "helperCell"
  >;
  /** 可选沿用宿主已有的 node_repl browser broker；不影响 CUA capture 的信任边界。 */
  readonly browserBroker?: { readonly socketPath: string; readonly token: string };
  /** 仅 native CUA factory 注入；存在时只走 Helper 私有 cell 传输，不按路径 spawn。 */
  readonly helperCell?: CuaHelperCellTransport;
}

export type CuaNodeReplMcpPortFactory = ((input: {
  readonly port: McpPort;
  captureOnce(
    target: CuaCaptureTarget,
    options: CuaNodeReplMcpPortCaptureOptions,
  ): Promise<CuaCaptureImageResult>;
  observationOnce?(
    request: CuaObservationRequest,
    options: CuaNodeReplMcpPortCaptureOptions,
  ): Promise<CuaCaptureImageResult>;
  verifyObservationScope?(expected: CuaCaptureExpectation): boolean | Promise<boolean>;
  readonly closePort: boolean;
  readonly browserBroker?: { readonly socketPath: string; readonly token: string };
}) => McpPort) & {
  /**
   * 只用于让 core 发起 connectConfiguredServers 的本地发现标记。真实 spawn 仍由本
   * wrapper 的 subprocess executor 负责；bootstrap 只在 wrapper 实际接管端口时注入。
   */
  readonly localServerConfig: McpServerConfig;
};

/**
 * 把捕获能力绑定到真实 node_repl server 的候选 McpPort。
 *
 * 只有显式 native launch composition 才构造本端口；普通 CLI/server/placeholder 不引用。
 * node_repl 的 js 仍由 createNodeReplMcpRuntime 的真实工具合同执行，执行器强制走
 * createSubprocessNodeReplExecutor（独立 cell），不在可信 CLI 进程内跑模型代码。
 */
const FORBIDDEN_SUBPROCESS_OVERRIDES = [
  "launch",
  "serverPath",
  "sourceSnapshot",
  "isSea",
  "jitless",
  "helperCell",
] as const;

/**
 * TypeScript 的 Omit 只约束正常调用方；这里再做运行时拒绝，防止 JS/动态输入通过
 * subprocess 覆盖已校验快照或换用另一条启动形状。
 */
function assertNoSubprocessOverrides(subprocess: object | undefined): void {
  if (!subprocess) return;
  for (const key of FORBIDDEN_SUBPROCESS_OVERRIDES) {
    if (Object.prototype.hasOwnProperty.call(subprocess, key)) {
      throw new Error(`cua_node_repl_subprocess_override_forbidden:${key}`);
    }
  }
}

export function createCuaNodeReplMcpPort(input: CuaNodeReplMcpPortInput): McpPort {
  if (!input.serverPath) {
    throw new Error("cua_node_repl_server_path_required");
  }
  // 构造时一次性校验并捕获快照。createLocal 是懒加载的，不能等后来再读可变 input；
  // 否则调用方在构造后改写 input.sourceSnapshot 就能让后续 cell 执行另一份内容。
  const sourceSnapshot = input.sourceSnapshot;
  if (typeof sourceSnapshot !== "string" || sourceSnapshot.length === 0) {
    throw new Error("cua_node_repl_source_snapshot_required");
  }
  assertNoSubprocessOverrides(input.subprocess);
  if (isSeaRuntime()) {
    // 本候选只服务固定签名 Node；SEA 无法通过 argv 关闭 JIT，显式拒绝而不是改普通默认。
    throw new Error("cua_node_repl_jitless_requires_non_sea");
  }
  interface LocalNodeRepl {
    client: Client;
    runtime: ReturnType<typeof createNodeReplMcpRuntime>;
  }

  let local: LocalNodeRepl | undefined;
  let localConnection: Promise<LocalNodeRepl> | undefined;
  // 每次 disconnect/close 递增：在途连接完成时必须对照它，不能把已断开的 client 留在端口里。
  let localEpoch = 0;
  let localRevision = 0;
  let nodeReplEnabled = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const disposedError = () => new Error("cua_node_repl_mcp_port_disposed");
  const disconnectedError = () => new Error("cua_node_repl_mcp_port_disconnected");

  const createLocal = async (epoch: number): Promise<LocalNodeRepl> => {
    const cuaRuntime = input.observationOnce
      ? createCuaObservationRuntime({
          captureOnce: input.captureOnce,
          observationOnce: input.observationOnce,
          ...(input.verifyObservationScope
            ? { verifyObservationScope: input.verifyObservationScope }
            : {}),
        })
      : createCuaCaptureComputerUseRuntime({ captureOnce: input.captureOnce });
    const runtime = createNodeReplMcpRuntime({
      executeJs: createSubprocessNodeReplExecutor({
        ...input.subprocess,
        serverPath: input.serverPath,
        sourceSnapshot,
        jitless: true,
        ...(input.helperCell ? { helperCell: input.helperCell } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      }),
      cuaRuntime,
      cuaRuntimeOwnership: "borrowed",
      ...(input.browserBroker ? { browserBroker: input.browserBroker } : {}),
    });
    const next = new Client({ name: "zcode-node-repl-mcp-port", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.server.connect(serverTransport);
      await next.connect(clientTransport);
    } catch (error) {
      await next.close().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    if (closed || epoch !== localEpoch || !nodeReplEnabled) {
      await next.close().catch(() => undefined);
      await runtime.dispose().catch(() => undefined);
      throw closed ? disposedError() : disconnectedError();
    }
    return { client: next, runtime };
  };

  const disposeLocal = async (target: LocalNodeRepl): Promise<void> => {
    // 先关 client 让在途 callTool 立刻收到关闭，再 dispose runtime 撤销 broker/capability。
    await target.client.close().catch(() => undefined);
    await target.runtime.dispose().catch(() => undefined);
  };

  const ensureLocal = async (): Promise<LocalNodeRepl> => {
    if (closed) throw disposedError();
    if (!nodeReplEnabled) throw disconnectedError();
    if (local) return local;
    const epoch = localEpoch;
    localConnection ??= createLocal(epoch);
    const pending = localConnection;
    try {
      const created = await pending;
      if (closed) {
        await disposeLocal(created);
        throw disposedError();
      }
      if (epoch !== localEpoch || !nodeReplEnabled) {
        await disposeLocal(created);
        throw disconnectedError();
      }
      if (!local) local = created;
      else if (local !== created) await disposeLocal(created);
      return local;
    } finally {
      if (localConnection === pending) localConnection = undefined;
    }
  };

  const stopLocal = async (): Promise<void> => {
    const previous = local;
    const pending = localConnection;
    if (!previous && !pending) return;
    local = undefined;
    localConnection = undefined;
    localEpoch += 1;
    localRevision += 1;
    if (previous) await disposeLocal(previous);
    if (pending) {
      try {
        await disposeLocal(await pending);
      } catch {
        // createLocal 在发现 epoch/closed 变化后已自行清理；这里只吸收它的拒绝。
      }
    }
  };

  const setEnabled = (enabled: boolean): void => {
    if (nodeReplEnabled === enabled) return;
    nodeReplEnabled = enabled;
    localRevision += 1;
  };

  const localTools = async (): Promise<McpToolDescriptor[]> => {
    const active = await ensureLocal();
    const { tools } = await active.client.listTools();
    const serverTimeoutMs = resolveBoundedToolTimeoutMs(input.timeoutMs);
    return tools.map((tool) => ({
      serverName: NODE_REPL_SERVER_NAME,
      toolName: tool.name,
      // 本地 wrapper 直接从 in-memory server 取 descriptor，必须像真实 MCP adapter 一样
      // 保留 server 级超时；否则 core 会回落到 30s 默认值，长任务被外层提前取消。
      timeoutMs: readToolMetaTimeoutMs((tool as { _meta?: unknown })._meta) ?? serverTimeoutMs,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as unknown as JsonSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as unknown as JsonSchema } : {}),
      ...(tool.annotations
        ? {
            annotations: {
              ...(tool.annotations.readOnlyHint !== undefined
                ? { readOnlyHint: tool.annotations.readOnlyHint }
                : {}),
              ...(tool.annotations.destructiveHint !== undefined
                ? { destructiveHint: tool.annotations.destructiveHint }
                : {}),
              ...(tool.annotations.idempotentHint !== undefined
                ? { idempotentHint: tool.annotations.idempotentHint }
                : {}),
              ...(tool.annotations.openWorldHint !== undefined
                ? { openWorldHint: tool.annotations.openWorldHint }
                : {}),
            },
          }
        : {}),
    }));
  };

  const localStatus = (config?: McpServerConfig): McpServerStatus => ({
    status: nodeReplEnabled ? (local ? "connected" : "connecting") : "disconnected",
    transport: config?.type ?? "stdio",
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  });

  const mergeSnapshot = async (snapshot: McpConnectionSnapshot): Promise<McpConnectionSnapshot> => {
    if (!nodeReplEnabled) return snapshot;
    const tools = await localTools();
    return {
      statuses: {
        ...snapshot.statuses,
        [NODE_REPL_SERVER_NAME]: { ...localStatus(), toolCount: tools.length },
      },
      tools: [
        ...snapshot.tools.filter((tool) => tool.serverName !== NODE_REPL_SERVER_NAME),
        ...tools,
      ],
    };
  };

  return {
    async connectConfiguredServers(servers, options?: McpConnectOptions) {
      const nodeReplConfig = servers[NODE_REPL_SERVER_NAME];
      const delegated = { ...servers };
      delete delegated[NODE_REPL_SERVER_NAME];
      if (nodeReplConfig) {
        setEnabled(true);
      } else {
        // connectConfiguredServers 是 replace 语义：配置里没有 node_repl 时必须真正断开本地 runtime。
        setEnabled(false);
        await stopLocal();
      }
      const snapshot = await input.port.connectConfiguredServers(delegated, options);
      return await mergeSnapshot(snapshot);
    },
    async connectServer(name, config, options) {
      if (name === NODE_REPL_SERVER_NAME) {
        setEnabled(true);
        const tools = await localTools();
        return { ...localStatus(config), toolCount: tools.length };
      }
      return await input.port.connectServer(name, config, options);
    },
    async disconnectServer(name) {
      if (name === NODE_REPL_SERVER_NAME) {
        // 先关闭入口再拆 runtime：新调用立即拒绝，在途 cell/capture 由 dispose 撤销。
        setEnabled(false);
        await stopLocal();
        return localStatus();
      }
      return await input.port.disconnectServer(name);
    },
    async status() {
      const statuses = await input.port.status();
      if (!nodeReplEnabled) return statuses;
      return {
        ...statuses,
        [NODE_REPL_SERVER_NAME]: { ...localStatus(), toolCount: (await localTools()).length },
      };
    },
    async listTools() {
      const tools = await input.port.listTools();
      // base 端口里已有 node_repl descriptor 时说明该能力已启用；用本地真实 server 替换。
      if (tools.some((tool) => tool.serverName === NODE_REPL_SERVER_NAME)) {
        setEnabled(true);
      }
      if (!nodeReplEnabled) return tools;
      return [
        ...tools.filter((tool) => tool.serverName !== NODE_REPL_SERVER_NAME),
        ...(await localTools()),
      ];
    },
    toolListRevision() {
      // local enable/disconnect 也会改变工具面，必须让 core 看到 revision 变化后重新 listTools。
      return (input.port.toolListRevision?.() ?? 0) + localRevision;
    },
    async callTool(request: McpCallToolRequest, options?: McpCallToolOptions) {
      if (request.serverName !== NODE_REPL_SERVER_NAME || !nodeReplEnabled) {
        return await input.port.callTool(request, options);
      }
      const active = await ensureLocal();
      const result = await active.client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          _meta: buildRequestMeta(request),
        },
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
          resetTimeoutOnProgress: true,
          ...(options?.onProgress
            ? {
                onprogress: (notification: {
                  progress: number;
                  total?: number;
                  message?: string;
                }) =>
                  options.onProgress?.({
                    progress: notification.progress,
                    ...(notification.total !== undefined ? { total: notification.total } : {}),
                    ...(notification.message !== undefined
                      ? { message: notification.message }
                      : {}),
                  }),
              }
            : {}),
        },
      );
      return toMcpToolCallResult(result);
    },
    ...(input.port.onAppConnectionInvalidated
      ? {
          onAppConnectionInvalidated: (serverName: string, listener: () => void) =>
            input.port.onAppConnectionInvalidated!(serverName, listener),
        }
      : {}),
    ...(input.port.appConnectionSnapshot
      ? {
          appConnectionSnapshot: (serverName: string) =>
            input.port.appConnectionSnapshot!(serverName),
        }
      : {}),
    ...(input.port.waitForAppConnection
      ? {
          waitForAppConnection: (serverName: string) =>
            input.port.waitForAppConnection!(serverName),
        }
      : {}),
    ...(input.port.pingServer
      ? {
          pingServer: (name: string, pingOptions?: { timeoutMs?: number }) =>
            input.port.pingServer!(name, pingOptions),
        }
      : {}),
    ...(input.port.readResource
      ? {
          readResource: (
            request: Parameters<NonNullable<McpPort["readResource"]>>[0],
            readOptions?: McpCallToolOptions,
          ) => input.port.readResource!(request, readOptions),
        }
      : {}),
    ...(input.port.listResources
      ? {
          listResources: (
            request: Parameters<NonNullable<McpPort["listResources"]>>[0],
            readOptions?: McpCallToolOptions,
          ) => input.port.listResources!(request, readOptions),
        }
      : {}),
    ...(input.port.listResourceTemplates
      ? {
          listResourceTemplates: (
            request: Parameters<NonNullable<McpPort["listResourceTemplates"]>>[0],
            readOptions?: McpCallToolOptions,
          ) => input.port.listResourceTemplates!(request, readOptions),
        }
      : {}),
    ...(input.port.subscribeResource
      ? {
          subscribeResource: (
            request: Parameters<NonNullable<McpPort["subscribeResource"]>>[0],
            readOptions?: McpCallToolOptions,
          ) => input.port.subscribeResource!(request, readOptions),
        }
      : {}),
    ...(input.port.unsubscribeResource
      ? {
          unsubscribeResource: (
            request: Parameters<NonNullable<McpPort["unsubscribeResource"]>>[0],
            readOptions?: McpCallToolOptions,
          ) => input.port.unsubscribeResource!(request, readOptions),
        }
      : {}),
    ...(input.port.unsubscribeResourcesBySubscriber
      ? {
          unsubscribeResourcesBySubscriber: (prefix: string) =>
            input.port.unsubscribeResourcesBySubscriber!(prefix),
        }
      : {}),
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      setEnabled(false);
      closePromise = (async () => {
        try {
          // close 必须等待在途连接，否则 createLocal 可能在 close 返回后才把 client 装回来。
          await stopLocal();
        } finally {
          if (input.closePort) await input.port.close();
        }
      })();
      return closePromise;
    },
  };
}

/** native cli-entry 可绑定的最小工厂：serverPath 等资源由可信 composition 静态提供。 */
export function createCuaNodeReplMcpPortFactory(
  options: Omit<CuaNodeReplMcpPortInput, "port" | "captureOnce" | "closePort" | "helperCell"> & {
    /**
     * ready 帧提供的私有 cellEndpoint。字段按 entry 可选：host/session-entry 的
     * ready 不带该值。CUA factory 存在时，getter 返回 undefined 会在实际 cell
     * 调用前 fail closed，不回退到按 serverPath spawn。
     */
    readonly cellEndpoint?: () => string | undefined;
    /**
     * 同一 fd3 ready 帧里的 private transport key getter；与 cellEndpoint 一样
     * 在 factory 构造期只保存 getter，实际 cell 调用时缺失即 fail closed。
     */
    readonly transportAuthenticationKey?: () => string | undefined;
  },
): CuaNodeReplMcpPortFactory {
  if (isSeaRuntime()) {
    throw new Error("cua_node_repl_jitless_requires_non_sea");
  }
  if (!options.serverPath) {
    throw new Error("cua_node_repl_server_path_required");
  }
  // factory 也必须在构造期捕获快照。它返回的 factory 可能在很久之后、甚至在调用方
  // 改写 options 之后才被调用；后续只允许使用这里冻结的 sourceSnapshot。
  const sourceSnapshot = options.sourceSnapshot;
  if (typeof sourceSnapshot !== "string" || sourceSnapshot.length === 0) {
    throw new Error("cua_node_repl_source_snapshot_required");
  }
  const serverPath = options.serverPath;
  assertNoSubprocessOverrides(options.subprocess);
  const subprocess = options.subprocess
    ? {
        ...options.subprocess,
        ...(options.subprocess.cuaSdk
          ? { cuaSdk: Object.freeze({ ...options.subprocess.cuaSdk }) }
          : {}),
      }
    : undefined;
  // 中文原因：factory 在 native ready 前就可能构造；此时 endpoint 尚不存在。
  // 缺少 getter 不等于构造失败，真正 cell 调用时再由 transport fail closed。
  const cellEndpoint = options.cellEndpoint ?? (() => undefined);
  const transportAuthenticationKey = options.transportAuthenticationKey ?? (() => undefined);
  const helperCell = createCuaHelperCellTransport({
    endpoint: cellEndpoint,
    transportAuthenticationKey,
    sourceSha256: cuaHelperSourceSha256(sourceSnapshot),
    ...(options.subprocess?.requestMaxBytes === undefined
      ? {}
      : { requestMaxBytes: options.subprocess.requestMaxBytes }),
  });
  // 该配置不会交给 base MCP 端口：wrapper 会从 servers 中摘掉 node_repl 后只做本地
  // in-memory server 接线。descriptor 如实表示 stdin ESM 快照启动，不留下可执行 path；
  // 已核验 source 只经子进程私有 stdin，绝不进入 descriptor。
  const toolTimeoutMs = resolveBoundedToolTimeoutMs(options.timeoutMs);
  const localServerConfig: McpServerConfig = {
    type: "stdio",
    command: process.execPath,
    args: ["--jitless", "--input-type=module", "-", CELL_RUN_FLAG],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env
      ? {
          env: Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }
      : {}),
    isolation: "workspace",
    protocolVersion: "2026-07-28",
    timeoutMs: toolTimeoutMs,
  };
  const {
    cellEndpoint: _cellEndpoint,
    transportAuthenticationKey: _transportAuthenticationKey,
    ...portOptions
  } = options;
  const factory = ((input) =>
    createCuaNodeReplMcpPort({
      ...portOptions,
      ...(subprocess ? { subprocess } : {}),
      serverPath,
      sourceSnapshot,
      helperCell,
      timeoutMs: toolTimeoutMs,
      port: input.port,
      captureOnce: input.captureOnce,
      ...(input.observationOnce ? { observationOnce: input.observationOnce } : {}),
      ...(input.verifyObservationScope
        ? { verifyObservationScope: input.verifyObservationScope }
        : {}),
      closePort: input.closePort,
      ...(input.browserBroker ? { browserBroker: input.browserBroker } : {}),
    })) as CuaNodeReplMcpPortFactory;
  return Object.assign(factory, { localServerConfig });
}

function resolveBoundedToolTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOCAL_TOOL_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.floor(value), MCP_TOOL_META_TIMEOUT_MIN_MS),
    MCP_TOOL_META_TIMEOUT_MAX_MS,
  );
}

function readToolMetaTimeoutMs(meta: unknown): number | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta.timeoutMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MCP_TOOL_META_TIMEOUT_MIN_MS) return undefined;
  return Math.min(Math.floor(value), MCP_TOOL_META_TIMEOUT_MAX_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  const context = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...context,
    // R53：同一份可信上下文投影成两种表示，两键引用同一对象（不是两次序列化）。
    ...buildZodyMcpDualMetaEntry(ZODY_MCP_META_KEY_COMPAT.requestContext, context),
  };
}

function toMcpToolCallResult(result: {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}): McpToolCallResult {
  return {
    content: result.content as McpToolCallResult["content"],
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(result._meta ? { _meta: result._meta } : {}),
  };
}

export {
  decodeUtf8Lossless,
  readBoundedBytes,
  readSealedResourceSnapshot,
  type ReadSealedResourceOptions,
  type SealedResourceSnapshot,
} from "./sealed-resource.js";
