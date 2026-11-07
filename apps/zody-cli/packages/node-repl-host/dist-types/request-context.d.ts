import type { NodeReplRequestMeta } from "@zody/core/repl";
import { ZODY_MCP_REQUEST_CONTEXT_META_KEY, ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL } from "@zody/contracts/mcp";
import { z } from "zod";
export declare const UNTRUSTED_SESSION_KEY = "__unscoped__";
/** 出站/入站共用同一常量源（canonical 与 legacy 都从 contracts 取，避免第二份字面值）。 */
export { ZODY_MCP_REQUEST_CONTEXT_META_KEY, ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL };
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
/**
 * 只读取宿主写入的命名空间；顶层 MCP _meta 是第三方可扩展字段，不能作为路由凭据。
 *
 * R53：canonical `com.zody/request-context` 与 legacy `com.zcode/request-context` 双键读取。
 * 单键按 schema 归一化；双键归一化相等才接受；冲突/任一侧不可用视作不可信，回落 `{}`，
 * 路由落 `UNTRUSTED_SESSION_KEY` —— 插件/模型传入的别名键因此不是新增权限来源。
 */
export declare function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta;
export declare function requestSessionKey(meta: NodeReplRequestMeta): string;
//# sourceMappingURL=request-context.d.ts.map