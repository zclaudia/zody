import type { NodeReplRequestMeta } from "@zcode/core/repl";
import type { Logger } from "@zcode/contracts";
import type { ComputerUseRuntime, ComputerUseRuntimeContext } from "@zcode/zcode-cua";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export interface NodeReplCuaBroker {
    ready: Promise<void>;
    mint(input: {
        invocationId: string;
        context: ComputerUseRuntimeContext;
    }): Promise<NodeReplCuaBrokerConnection>;
    revoke(invocationId: string): Promise<void>;
    close(): Promise<void>;
}
/**
 * 只为 CUA bridge 绑定收紧 scope。`com.zcode/request-context` 是宿主写入的关联元数据，
 * 不是经认证的 sideband，也不是 live submission authority；这里不签发原生输入资格。
 */
export declare function resolveTrustedCuaContext(meta: NodeReplRequestMeta): ComputerUseRuntimeContext | undefined;
export declare function createNodeReplCuaBroker(input: {
    runtime: ComputerUseRuntime;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker;
export declare function createCuaBrokerSocketPath(platform: NodeJS.Platform | string, id?: `${string}-${string}-${string}-${string}-${string}`): string;
//# sourceMappingURL=cua-broker.d.ts.map