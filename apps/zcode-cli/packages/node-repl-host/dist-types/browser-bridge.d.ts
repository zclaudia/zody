import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core/repl";
export interface ActiveNodeReplCall {
    generation: number;
    requestMeta: NodeReplRequestMeta;
    signal: AbortSignal;
}
export interface NodeReplBrowserBrokerConnection {
    socketPath: string;
    token: string;
}
export declare function captureNodeReplBrowserBrokerFromEnvironment(env?: NodeJS.ProcessEnv): NodeReplBrowserBrokerConnection | undefined;
export declare function createBrowserBridgeGlobals(input: {
    broker?: NodeReplBrowserBrokerConnection;
    documentationRoot: string;
    generation: number;
    getActiveCall: () => ActiveNodeReplCall | undefined;
    session: () => NodeReplSession;
}): Record<PropertyKey, unknown>;
//# sourceMappingURL=browser-bridge.d.ts.map