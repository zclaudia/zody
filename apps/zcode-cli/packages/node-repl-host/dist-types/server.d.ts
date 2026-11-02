import { installNodeReplProcessGuards, installNodeReplShutdownTriggers } from "./process-lifecycle.js";
export declare const NODE_REPL_MCP_PROCESS_TITLE = "zody-node-repl-mcp";
export { captureComputerUseRuntimeFromEnvironment } from "./cua-runtime.js";
export { createNodeReplMcpRuntime, type NodeReplMcpRuntime, type NodeReplMcpRuntimeOptions, } from "./node-repl-mcp-runtime.js";
export { createCuaCaptureComputerUseRuntime, type CuaCaptureComputerUseRuntimeOptions, type CuaCaptureExpectation, type CuaCaptureImageResult, type CuaCaptureTarget, } from "./cua-capture-runtime.js";
export { createCuaNodeReplMcpPort, createCuaNodeReplMcpPortFactory, type CuaNodeReplMcpPortCaptureOptions, type CuaNodeReplMcpPortFactory, type CuaNodeReplMcpPortInput, } from "./cua-node-repl-mcp-port.js";
export { createInProcessNodeReplExecutor, type NodeReplExecuteInput, type NodeReplExecutor, } from "./node-repl-session-executor.js";
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };
export declare function setNodeReplMcpProcessTitle(target?: {
    title: string;
}): void;
export declare function main(): Promise<void>;
//# sourceMappingURL=server.d.ts.map