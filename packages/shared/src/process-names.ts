const ZODY_PROCESS_PREFIX = "zody";
// 主窗口标题随产品名（Zody）；Preview/Dev 构建若以带渠道后缀的产品名作标题也视为主窗口。
const MAIN_WINDOW_TITLE_PATTERN = /^Zody(?: Preview| Dev)?$/;
const REMOTE_WINDOW_TITLE_PATTERN = /^Zody(?: Preview| Dev)? - /;
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinZodyProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ZODY_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatZodyMainProcessName(): string {
  return joinZodyProcessName("main");
}

export function formatZodyGpuProcessName(): string {
  return joinZodyProcessName("gpu");
}

export function formatZodyHostProcessName(label?: string): string {
  return joinZodyProcessName("host", label);
}

export function formatZodyRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || MAIN_WINDOW_TITLE_PATTERN.test(normalizedTitle)) {
    return joinZodyProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinZodyProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = REMOTE_WINDOW_TITLE_PATTERN.exec(normalizedTitle)?.[0];
  if (remoteWindowPrefix) {
    return joinZodyProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinZodyProcessName("renderer", normalizedTitle);
}

export function formatZodyAgentProcessName(provider: string, workspacePath?: string): string {
  return joinZodyProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatZodyUtilityProcessName(name?: string, type = "utility"): string {
  return joinZodyProcessName(type, name);
}
