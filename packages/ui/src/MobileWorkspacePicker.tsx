import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, WebRemoteControlMobileDirectoryListResult } from "@zcode/shared";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 手机「打开其他项目」目录选择器（第二批 E1/E3）。
 *
 * 目录事实全部来自 app 级 `mobile-directory-list` payload（桌面 Main 现读），
 * 不依赖 workspace bridge，空态（桌面无打开的 workspace）同样可用。
 * 确认选择后走 `workspace-open-path-request`；错误码映射为本地化提示，
 * 开关关闭（arbitrary-path-disabled）不自动重试。
 */
export function MobileWorkspacePicker({
  listDirectory,
  openWorkspacePath,
  onClose,
  onOpened,
}: {
  listDirectory(path?: string): Promise<WebRemoteControlMobileDirectoryListResult>;
  openWorkspacePath(workspacePath: string): Promise<string>;
  onClose: () => void;
  /** 打开成功后由宿主切换 workspace（回调参数是聚合列表里的 workspaceKey）。 */
  onOpened(workspaceKey: string): void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [initialResult, setInitialResult] = useState<
    { resolvedPath: string } | "failed" | null
  >(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // 当前浏览目录；footer 的「打开此目录」以它为准，ref 无法驱动 disabled 重渲染。
  const [selectedPath, setSelectedPath] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listDirectory()
      .then((result) => {
        if (cancelled || mountedRef.current === false) return;
        // 起点失败也进入选择器（可手动输入路径），错误由首屏 readdir 再呈现一次。
        setInitialResult(result.ok ? { resolvedPath: result.resolvedPath } : "failed");
      })
      .catch(() => {
        if (!cancelled) setInitialResult("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [listDirectory]);

  const mapDirectoryError = useCallback(
    (error: string): string =>
      intl.formatMessage({
        id: `mobileWorkspacePicker.error.${
          MOBILE_WORKSPACE_PICKER_ERROR_CODES.has(error) ? error : "unreadable"
        }`,
      }),
    [intl],
  );

  const handleReaddir = useCallback(
    async (path: string): Promise<FileEntry[]> => {
      const result = await listDirectory(path);
      if (!result.ok) {
        // DirectoryBrowser 只负责展示错误文案；稳定错误码在这里转成本地化提示。
        throw new Error(mapDirectoryError(result.error));
      }
      return result.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: "directory" as const,
        ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
      }));
    },
    [listDirectory, mapDirectoryError],
  );

  const handleOpen = useCallback(async () => {
    const workspacePath = selectedPath.trim();
    if (!workspacePath || opening) {
      return;
    }
    setOpening(true);
    setOpenError(null);
    try {
      const workspaceKey = await openWorkspacePath(workspacePath);
      await onOpened(workspaceKey);
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      // 桌面回的是稳定错误码（arbitrary-path-disabled / path-invalid / open-failed / timeout）。
      const known = code.startsWith("arbitrary-path-") || code === "path-invalid" || code === "open-failed" || code === "timeout";
      setOpenError(
        known ? mapDirectoryError(code) : intl.formatMessage({ id: "mobileWorkspacePicker.error.open-failed" }, { error: code }),
      );
      logger.warn("[MobileWorkspacePicker] 打开目录失败", { error: code });
    } finally {
      setOpening(false);
    }
  }, [intl, mapDirectoryError, onOpened, openWorkspacePath, opening, selectedPath]);

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background"
      data-mobile-workspace-picker="true"
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage({ id: "mobileWorkspacePicker.title" })}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "mobileWorkspacePicker.title" })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "common.cancel" })}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        {initialResult === null ? (
          <div className="p-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : (
          <DirectoryBrowser
            embedded
            readdir={handleReaddir}
            initialPath={initialResult === "failed" ? undefined : initialResult.resolvedPath}
            onSelect={() => {
              /* 选择动作统一收口到 footer 的「打开此目录」，避免行点击歧义。 */
            }}
            onCancel={onClose}
            onPathChange={(path) => {
              setSelectedPath(path);
            }}
            embeddedFooter={
              <>
                <Button type="button" variant="secondary" size="lg" onClick={onClose}>
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  data-testid="mobile-workspace-picker-open"
                  disabled={!selectedPath.trim() || opening}
                  onClick={() => void handleOpen()}
                >
                  {intl.formatMessage({ id: "mobileWorkspacePicker.open" })}
                </Button>
              </>
            }
          />
        )}
        {openError ? (
          <p
            data-testid="mobile-workspace-picker-error"
            className="mt-2 shrink-0 text-ui-base text-destructive"
          >
            {openError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** 与 shared schema / 桌面受理的错误码一一对应；未知错误按 unreadable 呈现。 */
const MOBILE_WORKSPACE_PICKER_ERROR_CODES = new Set<string>([
  "not-found",
  "not-directory",
  "unreadable",
  "too-large",
  "path-invalid",
  "arbitrary-path-disabled",
  "open-failed",
  "timeout",
]);
