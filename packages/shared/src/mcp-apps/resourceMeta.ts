import type { McpAppResourceMeta, McpAppsResourcePermission } from "./contract.js";
import { MCP_APPS_RESOURCE_PERMISSIONS } from "./contract.js";
import {
  asRecord,
  normalizeMcpAppCspRelaxations,
  readBoolean,
  readCsp,
  readPositiveInt,
} from "./toolMeta.js";

/**
 * `ui://` HTML 资源项自己的 `_meta`（以被选中内容项的 `_meta.ui` 为准）。
 * csp 与 prefersBorder 兼容 `openai/widgetCSP` / `openai/widgetPrefersBorder` 别名；
 * 尺寸提示只有 `openai/widgetHeightHint` / `openai/widgetMinFrameHeight`；`openai/widgetShowCodexWidgetInline` → showInline；
 * 什么都没声明返回 null。
 */
export function normalizeMcpAppResourceMeta(meta: unknown): McpAppResourceMeta | null {
  const root = asRecord(meta);
  if (!root) return null;
  const ui = asRecord(root.ui);
  const result: McpAppResourceMeta = {};
  const csp = readCsp(asRecord(ui?.csp), asRecord(root["openai/widgetCSP"]));
  if (csp) result.csp = csp;
  const prefersBorder =
    readBoolean(ui?.prefersBorder) ?? readBoolean(root["openai/widgetPrefersBorder"]);
  if (prefersBorder !== undefined) result.prefersBorder = prefersBorder;
  const heightHint = readPositiveInt(root["openai/widgetHeightHint"]);
  if (heightHint !== undefined) result.heightHint = heightHint;
  const minFrameHeight = readPositiveInt(root["openai/widgetMinFrameHeight"]);
  if (minFrameHeight !== undefined) result.minFrameHeight = minFrameHeight;
  const showInline =
    readBoolean(ui?.showInline) ?? readBoolean(root["openai/widgetShowCodexWidgetInline"]);
  if (showInline !== undefined) result.showInline = showInline;
  // F18（上游 a60ba6a7）：后台保留声明只认资源级 `_meta.ui.backgroundRetention` 布尔；
  // 工具 metadata 与 openai 别名都不授予（docs/plugin-ui-background-execution.md §12.2.2）。
  const backgroundRetention = readBoolean(ui?.backgroundRetention);
  if (backgroundRetention !== undefined) result.backgroundRetention = backgroundRetention;
  const cspRelaxations = normalizeMcpAppCspRelaxations(meta);
  if (cspRelaxations) result.cspRelaxations = cspRelaxations;
  const permissions = normalizeMcpAppResourcePermissions(ui?.permissions);
  if (permissions.length > 0) result.permissions = permissions;
  return Object.keys(result).length > 0 ? result : null;
}

/** `_meta.ui.permissions`：只认规范四键且值为对象（`{}`），未知键丢弃；按固定顺序返回。 */
export function normalizeMcpAppResourcePermissions(value: unknown): McpAppsResourcePermission[] {
  const root = asRecord(value);
  if (!root) return [];
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => asRecord(root[key]) !== null);
}
