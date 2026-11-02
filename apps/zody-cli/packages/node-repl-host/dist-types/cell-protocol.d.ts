import { z } from "zod";
import type { NodeReplRunResult } from "@zody/core/repl";
export declare const CELL_PROTOCOL_VERSION = 1;
export declare const CELL_RUN_FLAG = "--zcode-node-repl-cell";
export declare const CELL_REQUEST_MAX_BYTES: number;
export declare const CELL_RESPONSE_MAX_BYTES: number;
export declare const CELL_DIAGNOSTIC_MAX_BYTES: number;
export interface CellBrokerCapability {
    socketPath: string;
    token: string;
}
export interface CellCuaCapability extends CellBrokerCapability {
    invocationId: string;
}
export interface CellDocumentationRoots {
    browser: string;
    cua: string;
}
export type CellRequest = {
    version: typeof CELL_PROTOCOL_VERSION;
    invocationId: string;
    code: string;
    requestMeta: Record<string, unknown>;
    syncTimeoutMs: number;
    cuaCapability?: CellCuaCapability;
    browserCapability?: CellBrokerCapability;
    documentationRoots: CellDocumentationRoots;
};
export declare const cellRequestSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    invocationId: z.ZodString;
    code: z.ZodString;
    requestMeta: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    syncTimeoutMs: z.ZodNumber;
    cuaCapability: z.ZodOptional<z.ZodObject<{
        socketPath: z.ZodString;
        token: z.ZodString;
        invocationId: z.ZodString;
    }, z.core.$strict>>;
    browserCapability: z.ZodOptional<z.ZodObject<{
        socketPath: z.ZodString;
        token: z.ZodString;
    }, z.core.$strict>>;
    documentationRoots: z.ZodObject<{
        browser: z.ZodString;
        cua: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const cellResponseSchema: z.ZodUnion<readonly [z.ZodObject<{
    version: z.ZodLiteral<1>;
    invocationId: z.ZodString;
    ok: z.ZodLiteral<true>;
    result: z.ZodObject<{
        result: z.ZodOptional<z.ZodString>;
        logs: z.ZodString;
        error: z.ZodOptional<z.ZodObject<{
            name: z.ZodString;
            message: z.ZodString;
            stack: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        images: z.ZodOptional<z.ZodArray<z.ZodObject<{
            base64: z.ZodString;
            mimeType: z.ZodString;
        }, z.core.$strict>>>;
        browserScreenshotImageIndices: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
        structuredResults: z.ZodOptional<z.ZodArray<z.ZodObject<{
            content: z.ZodArray<z.ZodObject<{
                type: z.ZodString;
            }, z.core.$catchall<z.ZodUnknown>>>;
            isError: z.ZodOptional<z.ZodBoolean>;
            structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strict>>>;
        responseMeta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        cuaApp: z.ZodOptional<z.ZodObject<{
            appKey: z.ZodString;
            displayName: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    version: z.ZodLiteral<1>;
    invocationId: z.ZodNullable<z.ZodString>;
    ok: z.ZodLiteral<false>;
    error: z.ZodObject<{
        name: z.ZodString;
        message: z.ZodString;
        stack: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export type CellResponse = z.infer<typeof cellResponseSchema>;
export declare class CellProtocolError extends Error {
    constructor(message: string);
}
export declare function encodeCellRequest(request: CellRequest, maxBytes?: number): string;
export declare function parseCellRequest(raw: string, maxBytes?: number): CellRequest;
export declare function encodeCellResponse(response: CellResponse, maxBytes?: number): string;
export declare function parseCellResponse(raw: string, maxBytes?: number): CellResponse;
export declare function cellErrorResponse(invocationId: string | undefined, error: unknown): CellResponse;
export declare function cellResultResponse(invocationId: string, result: NodeReplRunResult): CellResponse;
//# sourceMappingURL=cell-protocol.d.ts.map