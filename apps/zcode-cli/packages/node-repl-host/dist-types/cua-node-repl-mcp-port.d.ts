import type { Logger, McpPort, McpServerConfig } from "@zcode/contracts";
import { type CuaCaptureExpectation, type CuaCaptureImageResult, type CuaCaptureTarget } from "./cua-capture-runtime.js";
import { type CuaHelperCellTransport } from "./cell-helper-transport.js";
import { type SubprocessNodeReplExecutorOptions } from "./subprocess-executor.js";
export interface CuaNodeReplMcpPortCaptureOptions {
    readonly signal?: AbortSignal;
    readonly expected: CuaCaptureExpectation;
}
export interface CuaNodeReplMcpPortInput {
    /** 原有 MCP 端口；除 node_repl 以外的生命周期、资源和工具全部委托给它。 */
    readonly port: McpPort;
    /** app 的显式 captureCuaOnce 闭包；expected 来自真实主工具调用上下文。 */
    captureOnce(target: CuaCaptureTarget, options: CuaNodeReplMcpPortCaptureOptions): Promise<CuaCaptureImageResult>;
    /** app 是否拥有原端口；true 时 wrapper.close 一并关闭原端口。 */
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
    readonly subprocess?: Omit<SubprocessNodeReplExecutorOptions, "serverPath" | "sourceSnapshot" | "launch" | "isSea" | "jitless" | "helperCell">;
    /** 可选沿用宿主已有的 node_repl browser broker；不影响 CUA capture 的信任边界。 */
    readonly browserBroker?: {
        readonly socketPath: string;
        readonly token: string;
    };
    /** 仅 native CUA factory 注入；存在时只走 Helper 私有 cell 传输，不按路径 spawn。 */
    readonly helperCell?: CuaHelperCellTransport;
}
export type CuaNodeReplMcpPortFactory = ((input: {
    readonly port: McpPort;
    captureOnce(target: CuaCaptureTarget, options: CuaNodeReplMcpPortCaptureOptions): Promise<CuaCaptureImageResult>;
    readonly closePort: boolean;
    readonly browserBroker?: {
        readonly socketPath: string;
        readonly token: string;
    };
}) => McpPort) & {
    /**
     * 只用于让 core 发起 connectConfiguredServers 的本地发现标记。真实 spawn 仍由本
     * wrapper 的 subprocess executor 负责；bootstrap 只在 wrapper 实际接管端口时注入。
     */
    readonly localServerConfig: McpServerConfig;
};
export declare function createCuaNodeReplMcpPort(input: CuaNodeReplMcpPortInput): McpPort;
/** native cli-entry 可绑定的最小工厂：serverPath 等资源由可信 composition 静态提供。 */
export declare function createCuaNodeReplMcpPortFactory(options: Omit<CuaNodeReplMcpPortInput, "port" | "captureOnce" | "closePort" | "helperCell"> & {
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
}): CuaNodeReplMcpPortFactory;
export { decodeUtf8Lossless, readBoundedBytes, readSealedResourceSnapshot, type ReadSealedResourceOptions, type SealedResourceSnapshot, } from "./sealed-resource.js";
//# sourceMappingURL=cua-node-repl-mcp-port.d.ts.map