import { useEffect, useState, type ReactNode } from "react";
import type { FileMediaPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type {
  CodeViewerSource,
  ImageCodeViewerSource,
  TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel, ToolInlinePreview } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";

export function ToolCallBody({
  childToolList,
  displayModel,
  inlinePreviewOverride,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  childToolList: ReactNode;
  displayModel: ToolDisplayModel;
  inlinePreviewOverride?: ToolInlinePreview;
  toolCall: TaskChatToolCallTreeNode["toolCall"];
  workspacePath: string;
  /** 应用主题（store 耦合剥离）：透传给 markdown / 代码块渲染，缺省按 "system" 兜底。 */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：透传给 markdown 渲染，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const inlinePreview = inlinePreviewOverride ?? displayModel.inlinePreview;

  return (
    <>
      {childToolList ?? (
        <>
          {inlinePreview.type === "text" ? (
            <InlineCodeContent
              preview={inlinePreview.source}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {inlinePreview.type === "image" ? (
            <InlineImageContent preview={inlinePreview.source} />
          ) : null}
          {displayModel.planResult ? (
            <InlinePlanResult
              plan={displayModel.planResult.plan}
              planFilePath={displayModel.planResult.planFilePath}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {displayModel.showInput && toolCall.input !== undefined ? (
            <ToolInput input={toolCall.input} />
          ) : null}
          {displayModel.showOutput ? (
            <ToolOutput errorText={toolCall.error} output={toolCall.output} />
          ) : null}
          {displayModel.showKind ? (
            <p className="text-ui-base text-muted-foreground">{toolCall.kind}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function InlineCodeContent({
  preview,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  preview: TextCodeViewerSource;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  if (preview.language === "markdown") {
    return (
      <div className="max-h-60 overflow-auto rounded-xl border border-border bg-muted/15 px-3 py-3">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          // 工具输出里的 markdown 文件链接之前只拿到 onOpenCodeViewer，
          // 点击会退化成 code viewer fallback；有 diff source 上下文时容易打开变更视图。
          // 这里优先交给 shell 的文件链接分流，文件看内容，目录走文件树 reveal。
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {preview.content}
        </MessageResponse>
      </div>
    );
  }

  return (
    <div className="max-h-60 overflow-auto rounded-xl bg-muted/15">
      <CodeBlock code={preview.content} language={preview.language} appTheme={theme} />
    </div>
  );
}

type InlineImagePreviewState =
  | { key: string; status: "loading" }
  | { key: string; status: "failed" }
  | { key: string; status: "loaded"; preview: FileMediaPreview };

/**
 * 来源身份按 AGENTS.md 的统一规则取 `workspaceIdentity?.trim() || workspacePath`：
 * 同一路径在本地和远端工作区可能指向不同文件，只有路径的工作区也要靠 workspacePath 区分。
 * remoteSessionId 再单独入 key，保证复用同一 identity 的不同远控会话之间也会重新绑定。
 */
function inlineImageSourceKey(preview: ImageCodeViewerSource): string {
  const workspaceKey = preview.workspaceIdentity?.trim() || preview.workspacePath || "";
  return [preview.path, workspaceKey, preview.workspaceRemoteSessionId?.trim() ?? ""].join(
    "\u0000",
  );
}

function InlineImageContent({ preview }: { preview: ImageCodeViewerSource }) {
  const { fileService } = useServices();
  const { intl } = useZCodeIntl();
  const sourceKey = inlineImageSourceKey(preview);
  const [state, setState] = useState<InlineImagePreviewState>({
    key: sourceKey,
    status: "loading",
  });
  // 用渲染期比较代替只在 effect 里清空：来源变化后的第一帧就必须撤掉旧图，
  // 否则切 A→B 时会先闪一帧 A 的图片，等 effect 执行后才回到 loading。
  const currentState: InlineImagePreviewState =
    state.key === sourceKey ? state : { key: sourceKey, status: "loading" };

  useEffect(() => {
    let cancelled = false;
    setState({ key: sourceKey, status: "loading" });

    void fileService
      .readMediaPreview({ path: preview.path })
      .then((mediaPreview) => {
        if (cancelled) {
          return;
        }
        // 空结果和空 payload 都是终态失败；继续显示 loading 会让卡片永久停在加载中。
        // 失败原因统一用 warn 记录路径，和 reject / path 不匹配分支保持同一口径。
        if (!mediaPreview || mediaPreview.dataBase64.length === 0) {
          logger.warn("[ToolCallBody] 内嵌图片预览结果为空", {
            path: preview.path,
            hasPreview: Boolean(mediaPreview),
          });
          setState({ key: sourceKey, status: "failed" });
          return;
        }
        // 回包必须对应本次请求的路径：契约要求 readMediaPreview 回显请求路径，
        // 不一致时按失败收口，避免把别的文件内容当成当前图片展示。
        if (mediaPreview.path !== preview.path) {
          logger.warn("[ToolCallBody] 内嵌图片预览回包路径不匹配", {
            path: preview.path,
            resultPath: mediaPreview.path,
          });
          setState({ key: sourceKey, status: "failed" });
          return;
        }
        setState({ key: sourceKey, status: "loaded", preview: mediaPreview });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // 原实现只有 then：reject 会变成 unhandled rejection 且界面永久 loading。
        logger.warn("[ToolCallBody] 内嵌图片预览失败", {
          path: preview.path,
          error: error instanceof Error ? error.message : String(error),
        });
        setState({ key: sourceKey, status: "failed" });
      });

    return () => {
      cancelled = true;
    };
  }, [fileService, preview.path, sourceKey]);

  if (currentState.status === "failed") {
    const unavailable = intl.formatMessage({ id: "codeViewer.imageUnavailable" });
    return <p aria-label={unavailable}>{unavailable}</p>;
  }

  if (currentState.status === "loading") {
    return <p>{intl.formatMessage({ id: "chat.toolCall.loading" })}</p>;
  }

  // 裸 base64 交给 <img> 无法被浏览器识别，必须补全 data URL 前缀。
  return (
    <img
      src={`data:${currentState.preview.mediaType};base64,${currentState.preview.dataBase64}`}
      alt={preview.title}
    />
  );
}

function InlinePlanResult({
  plan,
  planFilePath,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  plan: string;
  planFilePath?: string;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-3 rounded-xl border border-outline/60 bg-muted/15 p-3">
      {planFilePath ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-base text-on-surface-muted">
          <span>{intl.formatMessage({ id: "chat.toolCall.planFile" })}</span>
          <span className="cursor-default rounded-md bg-muted/70 px-2 py-1 font-mono text-on-surface">
            {planFilePath}
          </span>
        </div>
      ) : null}
      <MessageResponse
        className="size-full min-w-0 break-words whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        workspacePath={workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
      >
        {plan}
      </MessageResponse>
    </div>
  );
}
