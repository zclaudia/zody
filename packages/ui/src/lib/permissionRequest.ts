import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zody/shared/zody-protocol-v4";
import type { ZodyPermissionOption } from "@zody/shared";

export {
  getPermissionRequestPreview,
  type PermissionRequestFileChange,
  type PermissionRequestPreview,
  type PermissionRequestScope,
} from "@zody/shared";

/**
 * macOS CUA 截图「App 内确认弹窗」（specs/computer-use-macos-phase1.md
 * 「2026-10-31 App 内确认弹窗替代 Helper 原生 NSAlert」）在 CLI 侧发起
 * permission 请求时固定的 toolName 字面量。2026-10-31 用户修订后遵循既有
 * 工具权限策略：选项集由通用投影给出（allow_once / allow_always / deny，
 * 会话支持时另有 Full access）。
 */
export const CUA_SCREENSHOT_CONFIRM_TOOL_NAME = "cua_screenshot_confirm";
export const CUA_AX_READ_CONFIRM_TOOL_NAME = "cua_ax_read_confirm";

/** 读取与截图是独立权限，不共享持久授权语义。 */
export function isCuaReadConfirmRequest(request: { kind?: string | null; raw?: unknown }): boolean {
  if (normalizeToolName(request.kind) === CUA_AX_READ_CONFIRM_TOOL_NAME) return true;
  if (!isPlainRecord(request.raw)) return false;
  return (
    (normalizeToolName(request.raw.toolName) ?? normalizeToolName(request.raw.tool_name)) ===
    CUA_AX_READ_CONFIRM_TOOL_NAME
  );
}

/** 目标窗口的展示事实；字段畸形（类型不匹配）时对应槽位为 null，不崩溃。 */
export interface CuaScreenshotConfirmTargetFacts {
  ownerName: string | null;
  windowName: string | null;
  pid: number | null;
  windowId: number | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolName(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

/**
 * 识别 CUA 截图确认请求：kind 与 raw.toolName 任一命中固定字面量即认定
 * （v4 适配器把 payload.toolName 同时写进 request.kind 与 raw）。
 * 参数形状放宽到 `kind?/raw?`，PermissionDialog 的合成 toolCall（TaskChatToolCall）
 * 与 ZodyPermissionRequest 都能直接传入。
 */
export function isCuaScreenshotConfirmRequest(request: {
  kind?: string | null;
  raw?: unknown;
}): boolean {
  if (normalizeToolName(request.kind) === CUA_SCREENSHOT_CONFIRM_TOOL_NAME) {
    return true;
  }
  if (!isPlainRecord(request.raw)) {
    return false;
  }
  const rawToolName =
    normalizeToolName(request.raw.toolName) ?? normalizeToolName(request.raw.tool_name);
  return rawToolName === CUA_SCREENSHOT_CONFIRM_TOOL_NAME;
}

function readTargetString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readTargetNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 从 permission 请求 input.target 解析目标窗口展示事实。
 * input 缺失、target 非对象或所有字段都畸形时返回 null，由弹窗回退显示 reason 字符串。
 */
export function getCuaScreenshotConfirmTarget(request: {
  raw?: unknown;
}): CuaScreenshotConfirmTargetFacts | null {
  if (!isPlainRecord(request.raw)) {
    return null;
  }
  // 三种真实形状：
  // - v4：pendingPermissionToLegacyRequest 把 payload.detail（= 工具 input）直接放进 raw，
  //   即 raw.target；
  // - v4 嵌套：raw.input.target；
  // - legacy：raw.rawInput.target（与 readRawToolCallInput 相同的双字段兼容）。
  const target =
    (isPlainRecord(request.raw.target) ? request.raw.target : undefined) ??
    (isPlainRecord(request.raw.rawInput) && isPlainRecord(request.raw.rawInput.target)
      ? request.raw.rawInput.target
      : undefined) ??
    (isPlainRecord(request.raw.input) && isPlainRecord(request.raw.input.target)
      ? request.raw.input.target
      : undefined);
  if (!target) {
    return null;
  }
  const facts: CuaScreenshotConfirmTargetFacts = {
    ownerName: readTargetString(target.ownerName),
    windowName: readTargetString(target.windowName),
    pid: readTargetNumber(target.pid),
    windowId: readTargetNumber(target.windowId),
  };
  const hasAnyFact =
    facts.ownerName !== null ||
    facts.windowName !== null ||
    facts.pid !== null ||
    facts.windowId !== null;
  return hasAnyFact ? facts : null;
}

/**
 * CUA 截图确认弹窗只保留 allow_once 的专用文案「允许本次截图」；
 * allow_always 与 deny 遵循通用权限文案（2026-10-31 用户修订）。
 * v4 投影会把 allow_once 的 optionId 改写成 allowOnce（product-projection），legacy 链路
 * 仍是 allow_once，两者必须命中同一文案。其他工具的 "Allow once" / "Deny" 展示不受影响。
 */
export function getCuaScreenshotConfirmOptionLabelMessageId(optionId: string): string | null {
  if (optionId === "allow_once" || optionId === "allowOnce") {
    return "chat.permission.cua.screenshotConfirm.allowOnce";
  }
  return null;
}

type PermissionOptionDisplayKind =
  | "allowOnce"
  | "allowAlways"
  | "rejectOnce"
  | "rejectAlways"
  | "custom";

const GENERIC_PERMISSION_OPTION_NAMES: Record<PermissionOptionDisplayKind, Set<string>> = {
  allowOnce: new Set(["allow", "allow once", "approve"]),
  allowAlways: new Set(["always allow", "allow always", "approve always"]),
  rejectOnce: new Set(["deny", "deny once", "reject", "reject once"]),
  rejectAlways: new Set(["always deny", "deny always", "always reject", "reject always"]),
  custom: new Set(),
};

function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function getPermissionOptionDisplayKind(kind: string): PermissionOptionDisplayKind {
  const normalizedKind = kind.trim().toLowerCase();
  const isAllow = normalizedKind.includes("allow") || normalizedKind.includes("approve");
  const isReject = normalizedKind.includes("reject") || normalizedKind.includes("deny");
  const isAlways = normalizedKind.includes("always");

  if (isAllow && isAlways) {
    return "allowAlways";
  }

  if (isAllow) {
    return "allowOnce";
  }

  if (isReject && isAlways) {
    return "rejectAlways";
  }

  if (isReject) {
    return "rejectOnce";
  }

  return "custom";
}

export function shouldPreferPermissionOptionName(
  option: Pick<ZodyPermissionOption, "kind" | "name">,
): boolean {
  const normalizedName = normalizeInlineText(option.name).toLowerCase();
  if (normalizedName.length === 0) {
    return false;
  }

  const displayKind = getPermissionOptionDisplayKind(option.kind);
  if (displayKind === "custom") {
    return true;
  }

  return !GENERIC_PERMISSION_OPTION_NAMES[displayKind].has(normalizedName);
}

function getPermissionOptionSortPriority(kind: string): number {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return 0;
    case "allowAlways":
      return 1;
    case "rejectOnce":
      return 2;
    case "rejectAlways":
      return 3;
    default:
      return 4;
  }
}

export function sortPermissionOptions(
  options: readonly ZodyPermissionOption[],
): ZodyPermissionOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const priorityDelta =
        (left.option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
          ? 1.5
          : getPermissionOptionSortPriority(left.option.kind)) -
        (right.option.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
          ? 1.5
          : getPermissionOptionSortPriority(right.option.kind));
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.index - right.index;
    })
    .map(({ option }) => option);
}
