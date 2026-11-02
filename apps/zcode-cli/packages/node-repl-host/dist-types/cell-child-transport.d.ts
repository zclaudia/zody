import type { Writable } from "node:stream";
import type { NodeReplRunResult } from "@zcode/core/repl";
import { type CellRequest } from "./cell-protocol.js";
export interface CellChildInput {
    abortGraceMs: number;
    args: string[];
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    line: string;
    request: CellRequest;
    responseMaxBytes: number;
    signal: AbortSignal;
    /** 可信 composition 已校验的 server 源码；只经私有 stdin 传送，不进 argv/env。 */
    stdinSource?: string;
}
export interface CellSourceWriter {
    readonly stream: Writable;
    readonly source: string;
    /** 已取消、已退出或已有传输错误时不再继续写。 */
    isUnavailable(): boolean;
    onError(error: unknown): void;
}
/**
 * 把已核验源码快照写入 cell 的私有 stdin，并收口 backpressure/error/close。
 *
 * 独立导出是为了用可控 Writable 确定性覆盖 backpressure、error、abort 和提前 close；
 * 生产路径只由 runCellChild 调用。写入结束时不删除 error 监听，等 close 再清理，
 * 避免 EPIPE 在 end 后变成未处理异常。
 */
export declare function writeCellSource(input: CellSourceWriter): void;
/**
 * 跑一次 cell 子进程。
 *
 * 同步边界：
 * - 成功/失败都以直接子进程的 `exit` 为准，`close` 只覆盖 spawn 失败，不作为退出证据。
 * - 完整 frame 到达且直接子进程干净退出才成功；先解析协议错误，再拒绝非零退出的成功响应。
 * - abort/协议错误在直接子进程退出后立刻收掉父端 pipe 并拒绝，不等待后代释放继承的 fd。
 * - 正常退出但没有完整 frame 时，等 fd4 `end` 判截断；外部 signal deadline 是最后兜底。
 */
export declare function runCellChild(input: CellChildInput): Promise<NodeReplRunResult>;
//# sourceMappingURL=cell-child-transport.d.ts.map