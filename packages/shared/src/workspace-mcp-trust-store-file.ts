import { z } from "zod";

/**
 * Workspace MCP Trust store 文件格式（`workspace-mcp-trust-v1.json`）的单一权威
 * schema（fork F23，语义来源：上游 a60ba6a7 的 workspace-mcp-trust 模块；spec 见
 * docs/specs/workspace-mcp-trust.md §2.2）。
 *
 * 与 `workspace-hook-trust-store-file.ts` 同一先例：信任存储是权限边界，所有
 * 消费者（core 域、CLI store 适配、未来的 services 透传）必须对同一份文件得出
 * 同一结论，schema 下沉到 shared 作为单源；JSON 语法错误与 schema 校验失败统一
 * 归为 `invalid`（fail-closed，不得返回部分结果）。
 *
 * 本文件必须保持 renderer-safe：只依赖 zod，禁止 import node 内建模块
 * （shared 根导出图当前无 node 依赖，摘要计算所需的 node:crypto/node:path 落在
 * core 的 `mcp/workspace-mcp-trust.ts` 单源实现里，见 spec §4 的落位修订）。
 */

export const WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION = 1 as const;

const nonEmptyStringSchema = z.string().trim().min(1);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const workspaceMcpTrustRecordSchema = z
  .object({
    /** 身份键 = workspaceIdentity?.trim() || workspacePath（AGENTS.md 统一规则）。 */
    workspaceIdentity: nonEmptyStringSchema,
    serverName: nonEmptyStringSchema,
    /** 预置启动执行身份（args/env/cwd 等）的声明摘要；任一执行字段变更即失配。 */
    declarationDigest: sha256DigestSchema,
    grantedAt: z.string().datetime(),
  })
  .strict();
export type WorkspaceMcpTrustRecord = z.infer<typeof workspaceMcpTrustRecordSchema>;

export const workspaceMcpTrustStoreFileSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION),
    records: z.array(workspaceMcpTrustRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const keys = store.records.map(
      (record) => `${record.workspaceIdentity}\u0000${record.serverName}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["records"],
        message: "workspace identity and server name keys must be unique",
      });
    }
  });
export type WorkspaceMcpTrustStoreFile = z.infer<typeof workspaceMcpTrustStoreFileSchema>;

export type WorkspaceMcpTrustStoreParseResult =
  | { status: "ok"; file: WorkspaceMcpTrustStoreFile }
  | { status: "invalid" };

/**
 * 解析 MCP trust store 文件内容。损坏（JSON 语法错误或 schema 失败）统一归为
 * `invalid`：消费侧必须按无记录处理（default-deny），不得把已有声明显示为 trusted。
 */
export function parseWorkspaceMcpTrustStoreContent(
  content: string,
): WorkspaceMcpTrustStoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const result = workspaceMcpTrustStoreFileSchema.safeParse(parsed);
  if (!result.success) return { status: "invalid" };
  return { status: "ok", file: result.data };
}
