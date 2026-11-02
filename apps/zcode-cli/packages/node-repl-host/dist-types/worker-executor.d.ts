import type { NodeReplRequestMeta } from "@zcode/core/repl";
import type { NodeReplBrowserBrokerConnection } from "./browser-bridge.js";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import type { NodeReplExecutor } from "./node-repl-session-executor.js";
export declare const WORKER_KIND = "zcode-node-repl-call";
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
export declare function createWorkerNodeReplExecutor(workerUrl: URL): NodeReplExecutor;
export declare function isWorkerCallData(value: unknown): value is WorkerCallData;
//# sourceMappingURL=worker-executor.d.ts.map