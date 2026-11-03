import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Ban, Download, Folder, Link2, RefreshCw, X } from "lucide-react";
import type { MobileTargetRef } from "@zody/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
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

/**
 * 触屏态命中区下限 44×44px 的 media 前缀（docs/web-remote-control/mobile-viewport-input-and-touch.md D1），
 * 与 lib/mobileTextInput.ts:3 同一 media 内核；桌面不渲染本组件，仍保留 media 作用域约束。
 */
const TOUCH_TARGET_MEDIA = "[@media(hover:none)_and_(pointer:coarse)]";

export function MobileWorkspaceFileBrowser({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  target,
  openRequest,
  onClose,
}: MobileWorkspaceFileBrowserProps) {
  const { intl } = useZodyIntl();
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
  // 触屏态命中区判定（jsdom/SSR 无 matchMedia 时为 false，保持桌面/测试基线渲染）。
  const coarseTouch = isCoarseTouchDevice();
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

  // searchfile-12：窄屏没有面包屑时，深层目录里的同名子目录（多个 src/docs）无法分辨所处路径。
  // 用 workspace 根到当前目录的父链构造面包屑；沿 getMobileFileBrowserParentDirectory 逐级上溯，
  // 无法回到 workspace 根（异常态/根外目录）时整体隐藏，不渲染错误层级。
  const breadcrumbs = useMemo(() => {
    if (previewPath) return null;
    const rootCrumb = {
      path: workspacePath,
      label: workspaceName || getPathLeaf(workspacePath),
    };
    const segments: Array<{ path: string; label: string }> = [];
    let current = viewDirectory;
    while (current && current !== workspacePath) {
      segments.unshift({ path: current, label: getPathLeaf(current) });
      const parent = getMobileFileBrowserParentDirectory(current, workspacePath);
      if (!parent) {
        return null;
      }
      current = parent;
    }
    return [rootCrumb, ...segments];
  }, [previewPath, viewDirectory, workspaceName, workspacePath]);

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

  // searchfile-11：进入新目录后虚拟列表停在上一目录的滚动位置，一进目录就看到中段条目；
  // 目录切换时强制回到顶部。用 ref 判定「目录真的变了」，避免预览关闭（previewPath 变化）
  // 时误触发复位、破坏上面的预览滚动恢复。
  const lastViewDirectoryRef = useRef(viewDirectory);
  useLayoutEffect(() => {
    if (previewPath) return;
    if (lastViewDirectoryRef.current === viewDirectory) return;
    lastViewDirectoryRef.current = viewDirectory;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [previewPath, viewDirectory]);

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
          // 触屏态命中区 ≥44px（D1）；视觉图标不变。
          className={`${TOUCH_TARGET_MEDIA}:size-11`}
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
            className={`${TOUCH_TARGET_MEDIA}:size-11`}
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
            className={`${TOUCH_TARGET_MEDIA}:size-11`}
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
            className={`${TOUCH_TARGET_MEDIA}:size-11`}
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
          className={`${TOUCH_TARGET_MEDIA}:size-11`}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      {breadcrumbs && breadcrumbs.length > 1 ? (
        // searchfile-12：可横向滚动的路径面包屑；末级为当前目录（不可点），其余可点跳层。
        <nav
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1"
          data-mobile-file-breadcrumb=""
        >
          {breadcrumbs.map((crumb, index) => {
            const isLast = index === breadcrumbs.length - 1;
            return (
              <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                    /
                  </span>
                ) : null}
                {isLast ? (
                  <span
                    className="max-w-40 truncate py-0.5 text-ui-sm text-foreground"
                    aria-current="location"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-mobile-file-crumb={crumb.path}
                    className={`max-w-40 shrink-0 truncate text-ui-sm text-foreground-subtle transition hover:text-foreground ${
                      coarseTouch
                        ? // D1：命中区任一方向不足 44px 即为缺陷。评审指出原伪元素方案只扩了
                          // 垂直方向（before:-inset-y-3），水平仅 inset-x-1，短标签（src/docs 等）
                          // 命中区约 28–36px；且面包屑 nav 是 overflow-x-auto 滚动容器，
                          // 超出其盒边界的伪元素命中区会被裁剪。触屏态直接给 44×44 最小盒，
                          // 完整落在 nav 内部，两个方向同时达标；桌面保持 py-0.5 紧凑密度。
                          "inline-flex min-h-11 min-w-11 items-center justify-center px-2"
                        : "py-0.5"
                    }`}
                    onClick={() => navigateToDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
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
        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-y-auto ${
            // searchfile-2：目录切换等待态。弱网下 readdir 未返回时旧目录内容继续可点，
            // 而标题已是新目录名；这里把旧列表置灰并禁止点击，配合下方加载指示明确「内容正在切换」，
            // 标题与可见内容不再背离。刷新同目录时也会短暂进入该状态，语义一致。
            loading && entries.length > 0 ? "pointer-events-none opacity-50" : ""
          }`}
          aria-busy={loading}
        >
          {loading && entries.length === 0 ? (
            <p className="p-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </p>
          ) : null}
          {loading && entries.length > 0 ? (
            <p
              data-mobile-file-loading=""
              className="border-b border-border px-4 py-2 text-ui-base text-foreground-subtle"
            >
              {intl.formatMessage({ id: "common.loading" })}
            </p>
          ) : null}
          {errorView ? (
            <div role="alert" data-mobile-file-error={errorView.category}>
              <p className="p-4 pb-0 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: errorView.messageId })}
              </p>
              {/* MF05: 失联/错误期间保留的旧列表必须带“旧列表”标识，不能伪称实时内容。 */}
              {showStaleListMarker ? (
                <p
                  data-mobile-file-stale-list=""
                  className="px-4 pb-4 pt-1 text-ui-xs text-foreground-subtlest"
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
                        className="inline-flex items-center gap-1 text-ui-xs text-foreground-subtle"
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
