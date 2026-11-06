import { Server } from "@modelcontextprotocol/server";
import type { ComputerUseRuntime } from "@zody/zody-cua";
import { type NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { NodeReplExecutor } from "./node-repl-session-executor.js";
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
export declare function createNodeReplMcpRuntime(input?: NodeReplMcpRuntimeOptions): NodeReplMcpRuntime;
//# sourceMappingURL=node-repl-mcp-runtime.d.ts.map