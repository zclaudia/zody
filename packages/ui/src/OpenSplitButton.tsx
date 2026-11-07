import type { EditorInfo, FileApplicationInfo } from "@zody/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZodyIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";
import { FileApplicationChoices } from "@/file-menu/FileApplicationChoices.js";
import { FileSaveAsMenuItem } from "@/file-menu/FileSaveAsMenuItem.js";
import { useFileApplications } from "@/file-menu/useFileApplications.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  stopPropagation?: boolean;
  /**
   * 整张卡片复用按钮的操作与状态（upstream v3.17.1 OpenSplitButton.renderCard，
   * 来源 SHA a60ba6a7）：右键和下拉不会维护两套动作；卡片主体通过透明按钮执行
   * 与主按钮相同的预览动作（I15 整卡打开，docs/ui/assistant-preview-cards.md）。
   */
  renderCard?: (
    button: ReactNode,
    /** 卡片主体整卡点击复用主按钮的预览动作与可用状态。 */
    actions: { handlePreview: () => void; canPreview: boolean },
  ) => ReactElement;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZodyIntl();
  const platform = usePlatform();
  const fileActions = useFileContextActions();
  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  // F16（SHA a60ba6a7）：本机文件按格式打开以系统关联为唯一事实源；仅当系统
  // 关联查询能力缺席或结果为空时回退静态编辑器菜单（docs/ui/file-open-apps.md
  // 共存章节，裁决 4）。远程身份不查询系统关联，继续走 openInEditor(remoteTarget)。
  const fileApplications = useFileApplications(
    target.type === "file"
      ? {
          path: target.path,
          pathKind: "file",
          workspaceIdentity: previewSource?.workspaceIdentity,
        }
      : null,
    isRemoteSource,
  );
  const systemAppsAvailable = !isRemoteSource && fileApplications.available;
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);

  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    setLoadingEditors(true);
    try {
      setEditors(await platform.getInstalledEditors());
      setEditorsLoaded(true);
    } catch (error) {
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target]);

  // 菜单打开时同时发起两份查询：系统关联是展示优先级的事实源；静态列表仅在
  // 系统关联为空（或宿主无该能力）时作为回退渲染，提前并行加载避免回退时再等待。
  const handleMenuOpenChange = (open: boolean) => {
    if (!open || target.type !== "file") return;
    if (systemAppsAvailable) void fileApplications.load();
    if (!systemAppsAvailable || !fileApplications.apps.length) void loadEditors();
  };

  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenSystemApplication = (application: FileApplicationInfo) => {
    if (target.type !== "file") {
      return;
    }
    void fileApplications.open(application);
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: result.error ?? "unknown-error",
        });
        // 返回失败和 IPC 拒绝都必须有可见反馈，不能只写日志后静默结束（SHA a60ba6a7）。
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 第三方 App 打开文件异常", {
          editorId: editor.id,
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  /** 系统关联非空时渲染系统应用；为空/能力缺席时回退静态编辑器菜单（裁决 4）。 */
  const renderOpenWithChoices = (variant: "dropdown" | "context") => {
    if (systemAppsAvailable) {
      if (fileApplications.loading && !fileApplications.apps.length) {
        const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
        return <Item disabled>{intl.formatMessage({ id: "common.loading" })}</Item>;
      }
      if (fileApplications.apps.length) {
        return (
          <FileApplicationChoices
            variant={variant}
            applications={fileApplications.apps}
            loading={fileApplications.loading}
            onSelect={handleOpenSystemApplication}
          />
        );
      }
    }
    if (loadingEditors && !sortedEditors.length) {
      const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
      return <Item disabled>{intl.formatMessage({ id: "common.loading" })}</Item>;
    }
    if (!sortedEditors.length) {
      const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
      return (
        <Item disabled>
          {intl.formatMessage({
            id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
          })}
        </Item>
      );
    }
    const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
    return sortedEditors.map((editor) => (
      <Item key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
        <img src={editor.iconDataUrl} alt={editor.name} className="size-4 shrink-0" />
        <span>{editor.name}</span>
      </Item>
    ));
  };

  const renderFileMenuActions = (variant: "dropdown" | "context") => {
    const Separator = variant === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
    const CopyItem = variant === "context" ? ContextMenuItem : DropdownMenuItem;
    if (target.type !== "file") {
      return (
        <CopyItem onSelect={handleOpenExternal}>
          <ExternalLinkIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.previewCards.openExternal" })}</span>
        </CopyItem>
      );
    }
    return (
      <>
        {variant === "context" && (
          <ContextMenuItem disabled={!canPreview} onSelect={handlePreview}>
            <PanelRightIcon className="size-4" />
            {intl.formatMessage({ id: "chat.previewCards.previewInSidePane" })}
          </ContextMenuItem>
        )}
        {renderOpenWithChoices(variant)}
        <Separator />
        <FileSaveAsMenuItem
          variant={variant}
          path={target.path}
          workspacePath={previewSource?.workspacePath}
          workspaceIdentity={previewSource?.workspaceIdentity}
          workspaceRemoteSessionId={previewSource?.workspaceRemoteSessionId}
        />
        <CopyItem onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}>
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </CopyItem>
        <CopyItem
          onSelect={() =>
            void fileActions.copyRelativePath({
              path: target.path,
              relativePath: previewSource?.workspacePath
                ? getWorkspaceFileRelativePath(previewSource.workspacePath, target.path)
                : target.label,
            })
          }
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
        </CopyItem>
      </>
    );
  };

  if (hideOpenWithMenu) {
    const openButton = (
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 px-2"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
      </div>
    );
    // renderCard 存在时仍然提供右键菜单：整卡与下拉/右键共用同一份动作（SHA a60ba6a7）。
    if (!renderCard) return openButton;
    return (
      <ContextMenu onOpenChange={(open) => open && handleMenuOpenChange(open)}>
        <ContextMenuTrigger asChild>
          {renderCard(openButton, { handlePreview, canPreview })}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
          {renderFileMenuActions("context")}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  const button = (
    <DropdownMenu onOpenChange={(open) => open && handleMenuOpenChange(open)}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 pr-1.5"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            onClick={stopEventPropagation}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-64 max-w-[calc(100vw-1rem)]"
        onClick={stopEventPropagation}
      >
        {renderFileMenuActions("dropdown")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  if (!renderCard) return button;
  return (
    <ContextMenu onOpenChange={(open) => open && handleMenuOpenChange(open)}>
      <ContextMenuTrigger asChild>
        {renderCard(button, { handlePreview, canPreview })}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64 max-w-[calc(100vw-1rem)]">
        {renderFileMenuActions("context")}
      </ContextMenuContent>
    </ContextMenu>
  );
}
