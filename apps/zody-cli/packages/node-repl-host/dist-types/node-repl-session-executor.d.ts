import { type NodeReplRequestMeta, type NodeReplRunResult } from "@zody/core/repl";
import { type NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import { type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export declare const DEFAULT_BROWSER_DOCUMENTATION_ROOT: string;
export declare const DEFAULT_CUA_DOCUMENTATION_ROOT: string;
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
    cuaSdk?: {
        root: string;
        clientSource: string;
        documentationSource: string;
    };
    browserDocumentationRoot?: string;
    cuaDocumentationRoot?: string;
    browserBroker?: NodeReplBrowserBrokerConnection;
}
/**
 * 单次调用的 session 执行器。调用方决定它跑在 Worker、cell 子进程还是测试进程；
 * 这里只负责 fresh NodeReplSession、注入两个 bridge，并在 finally 释放 session 资源。
 */
export declare function createNodeReplSessionExecutor(options?: NodeReplSessionExecutorOptions): NodeReplExecutor;
/** 兼容旧入口：默认 Worker/同进程测试仍走同一套 session 逻辑。 */
export declare function createInProcessNodeReplExecutor(options?: NodeReplSessionExecutorOptions): NodeReplExecutor;
//# sourceMappingURL=node-repl-session-executor.d.ts.map