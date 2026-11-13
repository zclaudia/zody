import { resolve } from "node:path";
import { NodeReplSession, type NodeReplRequestMeta, type NodeReplRunResult } from "@zody/core/repl";
import {
  createBrowserBridgeGlobals,
  type ActiveNodeReplCall,
  type NodeReplBrowserBrokerConnection,
} from "./browser-bridge.js";
import {
  createComputerUseBridgeGlobals,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";

const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();

export const DEFAULT_BROWSER_DOCUMENTATION_ROOT = resolve(pluginRoot, "docs");
export const DEFAULT_CUA_DOCUMENTATION_ROOT = resolve(
  process.env.ZODY_CUA_PLUGIN_ROOT ?? pluginRoot,
  "docs",
);

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  /** 本次调用 main 侧 mint 的 CUA capability；为空时 CUA bridge 明确 unavailable。 */
  cuaBroker?: NodeReplCuaBrokerConnection;
  /** 可信 main 捕获的 Browser broker 连接；为空时 bridge 才回退到父进程环境。 */
  browserBroker?: NodeReplBrowserBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplSessionExecutorOptions {
  cuaSdk?: { root: string; clientSource: string; documentationSource: string };
  browserDocumentationRoot?: string;
  cuaDocumentationRoot?: string;
  browserBroker?: NodeReplBrowserBrokerConnection;
}

/**
 * 单次调用的 session 执行器。调用方决定它跑在 Worker、cell 子进程还是测试进程；
 * 这里只负责 fresh NodeReplSession、注入两个 bridge，并在 finally 释放 session 资源。
 */
export function createNodeReplSessionExecutor(
  options: NodeReplSessionExecutorOptions = {},
): NodeReplExecutor {
  const browserDocumentationRoot =
    options.browserDocumentationRoot ?? DEFAULT_BROWSER_DOCUMENTATION_ROOT;
  const cuaDocumentationRoot = options.cuaDocumentationRoot ?? DEFAULT_CUA_DOCUMENTATION_ROOT;

  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    session = new NodeReplSession({
      injectedGlobals: () => ({
        ...createBrowserBridgeGlobals({
          broker: input.browserBroker ?? options.browserBroker,
          documentationRoot: browserDocumentationRoot,
          generation,
          getActiveCall: () => activeCall,
          session: () => session,
        }),
        ...createComputerUseBridgeGlobals({
          broker: input.cuaBroker,
          generation,
          getActiveCall: () => activeCuaCall,
          session: () => session,
          documentationRoot: cuaDocumentationRoot,
          ...(options.cuaSdk ? { documentationSource: options.cuaSdk.documentationSource } : {}),
        }),
      }),
      restrictProcess: true,
      ...(options.cuaSdk ? { cuaSdk: options.cuaSdk } : {}),
    });
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}

/** 兼容旧入口：默认 Worker/同进程测试仍走同一套 session 逻辑。 */
export function createInProcessNodeReplExecutor(
  options: NodeReplSessionExecutorOptions = {},
): NodeReplExecutor {
  return createNodeReplSessionExecutor(options);
}
