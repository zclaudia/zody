import type { NodeReplRequestMeta } from "@zody/core/repl";
import { z } from "zod";
export declare const UNTRUSTED_SESSION_KEY = "__unscoped__";
export declare const requestContextSchema: z.ZodObject<{
    parent_span_id: z.ZodOptional<z.ZodString>;
    runtime_scope: z.ZodOptional<z.ZodEnum<{
        main: "main";
        subagent: "subagent";
    }>>;
    session_id: z.ZodOptional<z.ZodString>;
    span_id: z.ZodOptional<z.ZodString>;
    trace_id: z.ZodOptional<z.ZodString>;
    turn_id: z.ZodOptional<z.ZodString>;
    workspace_identity: z.ZodOptional<z.ZodString>;
    workspace_key: z.ZodOptional<z.ZodString>;
    workspace_path: z.ZodOptional<z.ZodString>;
    remote_session_id: z.ZodOptional<z.ZodString>;
    client_mode: z.ZodOptional<z.ZodString>;
    delivery_kind: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
/** 只读取宿主写入的命名空间；顶层 MCP _meta 是第三方可扩展字段，不能作为路由凭据。 */
export declare function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta;
export declare function requestSessionKey(meta: NodeReplRequestMeta): string;
//# sourceMappingURL=request-context.d.ts.map