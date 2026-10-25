import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

export function getMobileFileBrowserParentDirectory(path: string, rootPath: string): string | null {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(rootPath);
  const samePath = path.includes("\\")
    ? normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()
    : normalizedPath === normalizedRoot;
  if (!normalizedPath || samePath) return null;

  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex < 0) return null;
  let parent = normalizedPath.slice(0, separatorIndex);
  if (/^[a-z]:$/iu.test(parent)) parent += "/";
  if (!parent) parent = "/";
  return parent.replace(/\//g, path.includes("\\") ? "\\" : "/");
}

export function createMobileFileDirectoryTooLargeError(): Error {
  return new Error("DIRECTORY_TOO_LARGE: Directory exceeds the mobile file browser limit.");
}

export function isMobileFileDirectoryTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    (typeof error === "object" &&
      error !== null &&
      (("code" in error && (error as { code?: unknown }).code === "DIRECTORY_TOO_LARGE") ||
        ("name" in error &&
          (error as { name?: unknown }).name === "WorkspaceFileDirectoryTooLargeError"))) ||
    message.includes("DIRECTORY_TOO_LARGE")
  );
}

export function isMobileFileExternalDirectoryUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNSUPPORTED_EXTERNAL_DIRECTORY");
}

export type MobileFileBrowserErrorCategory =
  | "unsupportedExternalDirectory"
  | "directoryTooLarge"
  | "notFound"
  | "unreadable"
  | "offline"
  | "generic";

export interface MobileFileBrowserErrorView {
  category: MobileFileBrowserErrorCategory;
  /** 渲染错误文案使用的 i18n key。 */
  messageId: string;
  /**
   * true 时保留旧 entries 继续渲染（组件需叠加“旧列表”标识）。
   * DIRECTORY_TOO_LARGE 的截断响应不能伪称完整列表，必须整体替换为超限提示。
   */
  keepPreviousEntries: boolean;
}

/** 目标 workspace 与打开请求不一致 / 授权外目录：无旧列表可言，直接提示不支持。 */
export const MOBILE_FILE_BROWSER_UNSUPPORTED_DIRECTORY_VIEW: MobileFileBrowserErrorView = {
  category: "unsupportedExternalDirectory",
  messageId: "mobileFileBrowser.unsupportedExternalDirectory",
  keepPreviousEntries: false,
};

function isErrnoCodeError(error: unknown, codes: readonly string[]): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && codes.includes(code)) {
      return true;
    }
  }
  // RPC/序列化边界可能丢掉 code 字段只保留 message，按 errno 关键字兜底匹配。
  const message = error instanceof Error ? error.message : String(error);
  return codes.some((code) => message.includes(code));
}

/**
 * 手机文件浏览的错误三分类 + 通用兜底（MF05）。
 *
 * 失联（offline）时按 spec 保留带标识的已有列表；notFound/unreadable 同样保留旧列表并标识，
 * 只有 DIRECTORY_TOO_LARGE 明确不保留，避免把被截断的目录伪装成完整结果。
 */
export function resolveMobileFileBrowserError(error: unknown): MobileFileBrowserErrorView {
  if (isMobileFileExternalDirectoryUnsupported(error)) {
    return MOBILE_FILE_BROWSER_UNSUPPORTED_DIRECTORY_VIEW;
  }
  if (isMobileFileDirectoryTooLargeError(error)) {
    return {
      category: "directoryTooLarge",
      messageId: "mobileFileBrowser.directoryTooLarge",
      keepPreviousEntries: false,
    };
  }
  if (isRemoteWorkspaceDisconnectedError(error)) {
    return {
      category: "offline",
      messageId: "mobileFileBrowser.offline",
      keepPreviousEntries: true,
    };
  }
  if (isErrnoCodeError(error, ["ENOENT"])) {
    return {
      category: "notFound",
      messageId: "mobileFileBrowser.directoryNotFound",
      keepPreviousEntries: true,
    };
  }
  if (isErrnoCodeError(error, ["EACCES", "EPERM"])) {
    return {
      category: "unreadable",
      messageId: "mobileFileBrowser.directoryUnreadable",
      keepPreviousEntries: true,
    };
  }
  return {
    category: "generic",
    messageId: "workspaceFileTree.readFailed",
    keepPreviousEntries: true,
  };
}
