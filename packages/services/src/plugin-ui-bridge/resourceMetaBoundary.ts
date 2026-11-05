import type { McpAppInstance, McpAppResourceMeta } from "@zody/shared/mcp-apps";
import {
  MCP_APPS_META_KEY_COMPAT,
  normalizeMcpAppResourceMeta,
  resolveMcpAppsCspRelaxations,
} from "@zody/shared/mcp-apps";

/**
 * 资源 `_meta` 的实际入站边界（R52）。规则在 `@zody/shared/mcp-apps`（R50）：
 * 本文件只把归一化结果与 CSP 冲突分开返回，throws 由 `pluginUiBridgeService` 负责，
 * 这样边界逻辑可独立测试、也不产生 service ↔ boundary 循环依赖。
 */
export interface ResourceMetaConflict {
  canonicalKey: string;
  legacyKey: string;
  canonical: unknown;
  legacy: unknown;
}

export interface ResourceMetaBoundaryResult {
  /** 归一化后的资源元数据；CSP 冲突时其中不会包含 `cspRelaxations`（R50 fail-closed）。 */
  meta: McpAppResourceMeta | null;
  /** 非 null 表示调用方必须呈现可见错误并拒绝应用该声明。 */
  conflict: ResourceMetaConflict | null;
}

const NO_RESOURCE_META: ResourceMetaBoundaryResult = { meta: null, conflict: null };

/**
 * 资源项 `_meta` 的唯一解析点。`normalizeMcpAppResourceMeta` 保留既有字段语义，
 * `resolveMcpAppsCspRelaxations` 给出可见的冲突对；冲突时绝不返回放宽（不取更宽的一侧）。
 */
export function readResourceMetaBoundary(meta: unknown): ResourceMetaBoundaryResult {
  return { meta: normalizeMcpAppResourceMeta(meta), conflict: readCspConflict(meta) };
}

function readCspConflict(meta: unknown): ResourceMetaConflict | null {
  // 复用 R50 注册表取键名，避免边界另写一份 `zody/csp` / `zcode/csp` 字面值。
  const resolved = resolveMcpAppsCspRelaxations(meta);
  if (resolved.status !== "conflict") return null;
  const pair = MCP_APPS_META_KEY_COMPAT.csp;
  return {
    canonicalKey: pair.canonical,
    legacyKey: pair.legacy,
    canonical: resolved.canonical,
    legacy: resolved.legacy,
  };
}

/** `resources/list` 一页的最小形状；调用方负责绑定归属 scope，这里只做翻页与解析。 */
export interface ResourceListPage {
  resources: ReadonlyArray<{ uri: string; _meta?: unknown }>;
  nextCursor?: string;
}

export interface ResourceListScope {
  instance: McpAppInstance;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  pluginId: string;
  serverName: string;
}

export type ResourceListReader = (
  params: ResourceListScope & { cursor?: string },
) => Promise<ResourceListPage>;

const LIST_LEVEL_META_MAX_PAGES = 8;

/**
 * `resources/read` 的 HTML 项没带 `_meta` 时，翻 `resources/list` 找同 uri 条目的 `_meta`（最多 8 页）。
 * 列表不可用、翻页失败或找不到都视为"没有声明"，不阻塞沙箱准备；找到的条目仍走同一双键规则（冲突同样可见）。
 */
export async function readListLevelResourceMeta(
  list: ResourceListReader | undefined,
  params: ResourceListScope & { resourceUri: string },
): Promise<ResourceMetaBoundaryResult> {
  if (!list) return NO_RESOURCE_META;
  const scope: ResourceListScope = {
    instance: params.instance,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    serverName: params.serverName,
  };
  let cursor: string | undefined;
  try {
    for (let page = 0; page < LIST_LEVEL_META_MAX_PAGES; page += 1) {
      const result = await list({ ...scope, ...(cursor ? { cursor } : {}) });
      const entry = result.resources.find((item) => item.uri === params.resourceUri);
      if (entry) return readResourceMetaBoundary(entry._meta);
      if (!result.nextCursor) return NO_RESOURCE_META;
      cursor = result.nextCursor;
    }
  } catch {
    return NO_RESOURCE_META;
  }
  return NO_RESOURCE_META;
}
