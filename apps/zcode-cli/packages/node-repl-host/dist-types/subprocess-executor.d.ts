import type { NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { CuaHelperCellTransport } from "./cell-helper-transport.js";
import { type CellDocumentationRoots } from "./cell-protocol.js";
import { type NodeReplExecutor } from "./node-repl-session-executor.js";
import { type CellLaunch } from "./subprocess-launch.js";
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
export declare function createSubprocessNodeReplExecutor(options: SubprocessNodeReplExecutorOptions): NodeReplExecutor;
//# sourceMappingURL=subprocess-executor.d.ts.map