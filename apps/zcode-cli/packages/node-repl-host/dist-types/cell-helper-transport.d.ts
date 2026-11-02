import type { Duplex } from "node:stream";
import type { NodeReplRunResult } from "@zcode/core/repl";
import { type CellRequest } from "./cell-protocol.js";
export declare const CUA_HELPER_CELL_CONTROL_MAX_BYTES: number;
export declare const CUA_HELPER_CELL_CONNECT_TIMEOUT_MS = 10000;
export declare const CUA_HELPER_CELL_DEFAULT_TIMEOUT_MS: number;
export interface CuaHelperCellOpenFrame {
    readonly schemaVersion: 1;
    readonly type: "cell-open";
    readonly sourceSha256: string;
    readonly challenge: string;
    readonly requestMaxBytes: number;
    readonly responseMaxBytes: number;
}
export interface CuaHelperCellRunInput {
    /** 已编码的原始 fd3 request 行；Helper 只做字节中继，必须原样发送。 */
    readonly line: string;
    readonly request: CellRequest;
    readonly responseMaxBytes: number;
    readonly signal: AbortSignal;
}
export interface CuaHelperCellTransport {
    run(input: CuaHelperCellRunInput): Promise<NodeReplRunResult>;
}
export interface CuaHelperCellTransportOptions {
    /**
     * ready 帧里的私有 cellEndpoint。CUA factory 必须提供；返回 undefined 时
     * 明确 fail closed，绝不回退到按 serverPath spawn。
     */
    readonly endpoint: () => string | undefined;
    readonly sourceSha256: string;
    /**
     * 只由 native fd3 session-ready 注入的瞬时 key getter。缺失/非法时在 cell
     * 调用前 fail closed，不发送 CellRequest，也不回退到 path spawn。
     */
    readonly transportAuthenticationKey?: () => string | undefined;
    readonly requestMaxBytes?: number;
    readonly responseMaxBytes?: number;
    readonly timeoutMs?: number;
    /** 测试注入；生产只使用本机私有 Unix socket。 */
    readonly connectImpl?: (path: string, signal: AbortSignal) => Promise<Duplex>;
    /** 诊断回调，便于核对 Helper 上报的实际 cell PID。 */
    readonly onCellReady?: (pid: number) => void;
}
export declare function cuaHelperSourceSha256(source: string): string;
export declare function createCuaHelperCellTransport(options: CuaHelperCellTransportOptions): CuaHelperCellTransport;
//# sourceMappingURL=cell-helper-transport.d.ts.map