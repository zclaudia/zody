import type { NodeReplRequestMeta } from "@zcode/core/repl";
import { z } from "zod";

export const UNTRUSTED_SESSION_KEY = "__unscoped__";

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

/** 只读取宿主写入的命名空间；顶层 MCP _meta 是第三方可扩展字段，不能作为路由凭据。 */
export function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  return parsed.success ? parsed.data : {};
}

export function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}
