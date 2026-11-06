import type { NodeReplRequestMeta } from "@zody/core/repl";
import {
  readZodyMcpMetaEntry,
  ZODY_MCP_META_KEY_COMPAT,
  ZODY_MCP_REQUEST_CONTEXT_META_KEY,
  ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL,
} from "@zody/contracts/mcp";
import { z } from "zod";

export const UNTRUSTED_SESSION_KEY = "__unscoped__";

/** 出站/入站共用同一常量源（canonical 与 legacy 都从 contracts 取，避免第二份字面值）。 */
export { ZODY_MCP_REQUEST_CONTEXT_META_KEY, ZODY_MCP_REQUEST_CONTEXT_META_KEY_CANONICAL };

export const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).optional(),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

/**
 * 只读取宿主写入的命名空间；顶层 MCP _meta 是第三方可扩展字段，不能作为路由凭据。
 *
 * R53：canonical `com.zody/request-context` 与 legacy `com.zcode/request-context` 双键读取。
 * 单键按 schema 归一化；双键归一化相等才接受；冲突/任一侧不可用视作不可信，回落 `{}`，
 * 路由落 `UNTRUSTED_SESSION_KEY` —— 插件/模型传入的别名键因此不是新增权限来源。
 */
export function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const read = readZodyMcpMetaEntry(meta, ZODY_MCP_META_KEY_COMPAT.requestContext, (value) => {
    const parsed = requestContextSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });
  return read.status === "accepted" ? read.value : {};
}

export function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}
