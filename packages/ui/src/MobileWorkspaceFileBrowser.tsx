import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Ban, Download, Folder, Link2, RefreshCw, X } from "lucide-react";
import type { MobileTargetRef } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { PreviewPane } from "@/PreviewPane.js";
import {
  type MobileFileBrowserOpenRequest,
  useMobileWorkspaceFiles,
} from "@/hooks/useMobileWorkspaceFiles.js";
import {
  getMobileFileBrowserParentDirectory,
  MOBILE_FILE_BROWSER_UNSUPPORTED_DIRECTORY_VIEW,
  resolveMobileFileBrowserError,
  type MobileFileBrowserErrorView,
} from "@/mobileFileBrowserModel.js";
import { MOBILE_FILE_SAVE_MAX_BYTES } from "@/mobileFileBrowserSave.js";
import { createCodeViewerSourceForWorkspaceFile } from "@/workspace-file-tree/model.js";

export type { MobileFileBrowserOpenRequest } from "@/hooks/useMobileWorkspaceFiles.js";

export interface MobileWorkspaceFileBrowserProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  target?: MobileTargetRef;
  openRequest?: MobileFileBrowserOpenRequest | null;
  onClose: () => void;
}

function withWorkspaceScope(
  path: string,
  scope: Pick<
    MobileWorkspaceFileBrowserProps,
    "workspacePath" | "workspaceIdentity" | "workspaceRemoteSessionId"
  >,
) {
  return {
    ...createCodeViewerSourceForWorkspaceFile(path),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.workspaceRemoteSessionId
      ? { workspaceRemoteSessionId: scope.workspaceRemoteSessionId }
      : {}),
  };
}

export function MobileWorkspaceFileBrowser({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  target,
  openRequest,
  onClose,
}: MobileWorkspaceFileBrowserProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const browser = useMobileWorkspaceFiles({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    target,
    openRequest,
  });
  const {
    canSaveOriginal,
    cancelSave,
    entries,
    error,
    isTargetConsistent,
    loading,
    navigateToDirectory,
    previewPath,
    refresh,
    saveOriginal: saveOriginalFile,
    saving,
    setPreviewPath,
    viewDirectory,
  } = browser;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTopRef = useRef(0);
  const wasPreviewingRef = useRef(false);
  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const source = useMemo(
    () =>
      previewPath
        ? withWorkspaceScope(previewPath, {
            workspacePath,
            workspaceIdentity,
            workspaceRemoteSessionId,
          })
        : null,
    [previewPath, workspacePath, workspaceIdentity, workspaceRemoteSessionId],
  );
  const visibleDirectoryName =
    viewDirectory === workspacePath
      ? workspaceName || getPathLeaf(workspacePath)
      : getPathLeaf(viewDirectory);
  // MF05: 错误统一经 mobileFileBrowserModel 分类；除超限截断外都保留旧列表并叠加“旧列表”标识。
  const errorView = useMemo<MobileFileBrowserErrorView | null>(() => {
    if (!isTargetConsistent) {
      return MOBILE_FILE_BROWSER_UNSUPPORTED_DIRECTORY_VIEW;
    }
    if (!error) {
      return null;
    }
    return resolveMobileFileBrowserError(error);
  }, [error, isTargetConsistent]);
  const showStaleListMarker = Boolean(errorView?.keepPreviousEntries && entries.length > 0);

  useLayoutEffect(() => {
    if (previewPath) {
      wasPreviewingRef.current = true;
      return;
    }
    if (wasPreviewingRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = savedScrollTopRef.current;
      wasPreviewingRef.current = false;
    }
  }, [previewPath]);

  const navigateBack = useCallback(() => {
    if (previewPath) {
      setPreviewPath(null);
      return;
    }
    const parent = getMobileFileBrowserParentDirectory(viewDirectory, workspacePath);
    if (parent) navigateToDirectory(parent);
    else onClose();
  }, [navigateToDirectory, onClose, previewPath, setPreviewPath, viewDirectory, workspacePath]);

  useLayoutEffect(() => {
    if (!platform?.onBackPressed) return;
    return platform.onBackPressed(() => {
      navigateBack();
      return true;
    });
  }, [navigateBack, platform]);

  const saveOriginal = useCallback(async () => {
    try {
      const result = await saveOriginalFile();
      if (result && !result.success && !result.canceled) {
        toast(result.error ?? intl.formatMessage({ id: "workspaceFileTree.readFailed" }));
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  }, [intl, saveOriginalFile]);

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="mobile-file-browser"
    >
      <header className="flex min-h-12 items-center gap-2 border-b border-border px-3">
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          aria-label={intl.formatMessage({ id: "common.back" })}
          onClick={navigateBack}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {previewPath ? getPathLeaf(previewPath) : visibleDirectoryName}
        </span>
        {previewPath && canSaveOriginal ? (
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "mobileFileBrowser.saveOriginal" })}
            disabled={saving}
            onClick={() => void saveOriginal()}
          >
            <Download className="size-4" />
          </Button>
        ) : null}
        {previewPath && canSaveOriginal && saving ? (
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "mobileFileBrowser.cancelSave" })}
            data-mobile-file-cancel-save=""
            onClick={cancelSave}
          >
            <Ban className="size-4" />
          </Button>
        ) : null}
        {!previewPath ? (
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "workspaceFileTree.refresh" })}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          aria-label={intl.formatMessage({ id: "common.close" })}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      {previewPath && source ? (
        <div className="min-h-0 flex-1">
          <PreviewPane
            source={source}
            workspacePath={workspacePath}
            onClose={() => setPreviewPath(null)}
            actionsCapability="read-only"
            maxPreviewFileBytes={MOBILE_FILE_SAVE_MAX_BYTES}
          />
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
          {loading && entries.length === 0 ? (
            <p className="p-4 text-sm text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </p>
          ) : null}
          {errorView ? (
            <div role="alert" data-mobile-file-error={errorView.category}>
              <p className="p-4 pb-0 text-sm text-foreground-subtle">
                {intl.formatMessage({ id: errorView.messageId })}
              </p>
              {/* MF05: 失联/错误期间保留的旧列表必须带“旧列表”标识，不能伪称实时内容。 */}
              {showStaleListMarker ? (
                <p
                  data-mobile-file-stale-list=""
                  className="px-4 pb-4 pt-1 text-xs text-foreground-subtlest"
                >
                  {intl.formatMessage({ id: "mobileFileBrowser.staleList" })}
                </p>
              ) : null}
            </div>
          ) : null}
          {(!errorView || errorView.keepPreviousEntries) && isTargetConsistent ? (
            <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const entry = entries[virtualRow.index];
                if (!entry) return null;
                return (
                  <button
                    key={entry.path}
                    type="button"
                    data-mobile-file-row
                    className="absolute left-0 top-0 flex min-h-12 w-full items-center gap-3 border-b border-border px-4 text-left"
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    onClick={() => {
                      if (entry.type === "directory") {
                        navigateToDirectory(entry.path);
                      } else {
                        savedScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
                        setPreviewPath(entry.path);
                      }
                    }}
                  >
                    {entry.type === "directory" ? (
                      <Folder className="size-4 shrink-0" />
                    ) : (
                      <span className="size-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.isSymbolicLink ? (
                      <span
                        className="inline-flex items-center gap-1 text-xs text-foreground-subtle"
                        aria-label={intl.formatMessage({ id: "mobileFileBrowser.link" })}
                      >
                        <Link2 className="size-3" />
                        {intl.formatMessage({ id: "mobileFileBrowser.link" })}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
