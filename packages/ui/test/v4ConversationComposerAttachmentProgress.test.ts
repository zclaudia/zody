import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  TID_V4_COMPOSER_SEND,
  testId,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";

const attachmentState = vi.hoisted(() => ({
  attachments: [] as Array<Record<string, unknown>>,
  hookOptions: [] as Array<Record<string, unknown>>,
  retryAttachment: vi.fn(),
}));

const cuaEntryProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/prompt-editor/ChatPromptEditor.js", async () => {
  const React = await import("react");
  return {
    ChatPromptEditor: (props: Record<string, unknown>) =>
      React.createElement(
        "form",
        null,
        props.topContent as ReactNode,
        props.leadingActions as ReactNode,
        props.submitControl as ReactNode,
      ),
  };
});

vi.mock("@/components/ai-elements/attachments.js", async () => {
  const React = await import("react");
  const Container = ({
    children,
    data,
    openLabel: _openLabel,
    ...props
  }: { children?: ReactNode; data?: { url?: string } } & Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, "data-composer-attachment-url": data?.url ?? "" },
      children,
    );
  return {
    Attachment: Container,
    AttachmentHoverCard: Container,
    AttachmentHoverCardContent: Container,
    AttachmentHoverCardTrigger: ({ children }: { children?: ReactNode }) => children,
    AttachmentInfo: (props: Record<string, unknown>) => React.createElement("span", props),
    AttachmentPreview: ({ fallbackIcon: _fallbackIcon, ...props }: Record<string, unknown>) =>
      React.createElement("span", props),
    AttachmentRemove: (props: Record<string, unknown>) => React.createElement("button", props),
    Attachments: Container,
  };
});

vi.mock("@/components/ai-elements/image-preview-dialog.js", async () => {
  const React = await import("react");
  return {
    ImagePreviewDialog: ({ items }: { items: Array<{ filename?: string }> }) =>
      React.createElement("div", {
        "data-composer-image-preview": items.map((item) => item.filename).join(","),
      }),
  };
});

vi.mock("@/v4/composer/useComposerAttachments.js", () => ({
  useComposerAttachments: (options: Record<string, unknown>) => {
    attachmentState.hookOptions.push(options);
    return {
      attachmentError: null,
      adoptSentAttachments: vi.fn(async () => {}),
      attachmentInputRef: { current: null },
      attachments: attachmentState.attachments,
      clearAttachments: vi.fn(),
      handleAttachmentInputChange: vi.fn(),
      handleDragLeaveComposer: vi.fn(),
      handleDragOverComposer: vi.fn(),
      handleDropComposer: vi.fn(),
      handlePaste: vi.fn(),
      handleWhiteboardMentionSelected: vi.fn(),
      hasAttachments: attachmentState.attachments.length > 0,
      hasUnreadyAttachments: attachmentState.attachments.some(
        (item) => item.uploadStatus !== "ready",
      ),
      isDraggingOverComposer: false,
      openAttachmentPicker: vi.fn(),
      prepareForSend: vi.fn(async () => null),
      removeAttachment: vi.fn(),
      retryAttachment: attachmentState.retryAttachment,
      setAttachmentError: vi.fn(),
    };
  },
}));

vi.mock("@/v4/composer/V4ComposerCuaEntry.js", async () => {
  const React = await import("react");
  return {
    V4ComposerCuaEntry: (props: Record<string, unknown>) => {
      cuaEntryProps.push(props);
      return React.createElement("span", { "data-cua-entry": "true" });
    },
  };
});

vi.mock("@/v4/composer/V4ComposerToolbar.js", async () => {
  const React = await import("react");
  return {
    V4ComposerModeSwitch: () => React.createElement("span"),
    V4ComposerModelControls: () => React.createElement("span"),
  };
});

const AnyConversationComposer = ConversationComposer as unknown as ComponentType<
  Record<string, unknown>
>;

function renderComposer(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AnyConversationComposer, {
        draftMode: true,
        onSelectModel: vi.fn(),
        onSelectThought: vi.fn(),
        onSendText: vi.fn(async () => {}),
        onStop: vi.fn(),
        onSwitchMode: vi.fn(),
        sessionId: null,
        snapshot: null,
        workspacePath: "/workspace",
        ...overrides,
      }),
    ),
  );
}

describe("ConversationComposer attachment upload progress", () => {
  it("只让聚焦且未禁用的 composer 监听 add-to-chat，且不渲染不可用系统 CUA 入口", () => {
    const html = renderComposer({
      disabled: true,
      isWebRemoteControl: true,
      listenAddToChatEvents: false,
      remoteSessionId: "remote-1",
    });

    expect(attachmentState.hookOptions.at(-1)).toMatchObject({
      listenAddToChatEvents: false,
    });
    expect(html).not.toContain('data-cua-entry="true"');
    expect(cuaEntryProps).toEqual([]);
  });

  it("图片中央显示主题 token 圆环与百分比，未 ready 时发送按钮 disabled", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "image.png",
        id: "image-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-1",
        operationId: "operation-image-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 42,
        uploadStatus: "uploading",
      },
    ];

    const html = renderComposer();

    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, "image-1")}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain("42%");
    expect(html).toContain('stroke-dasharray="42 100"');
    expect(html).toContain("bg-background/85");
    expect(html).toContain("size-3.5 rounded-full bg-primary");
    expect(html).toContain('data-composer-attachment-kind="image"');
    expect(html).toContain("size-12");
    // 走查 composer-4/touch-6：圆角裁剪从卡片根节点内移到预览包裹层，
    // 根节点 overflow-visible 放行 × 的触屏扩展命中区。
    expect(html).toContain("size-12 overflow-visible rounded-lg");
    expect(html).toContain("size-full overflow-hidden rounded-lg");
    expect(html).not.toContain("size-12 overflow-hidden");
    expect(html).toContain('data-composer-image-preview="image.png"');
    expect(html).not.toContain("bg-white");
    expect(html).toContain(`disabled="" data-testid="${TID_V4_COMPOSER_SEND}"`);
  });

  // 走查 design-6：媒体附件上传进度百分比之前是任意字号 text-[7px]，弱网传大图时不可读。
  it("媒体附件上传进度使用 text-ui-xs 字号 token，不再使用 text-[7px]", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "image.png",
        id: "image-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-1",
        operationId: "operation-image-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 42,
        uploadStatus: "uploading",
      },
    ];

    const html = renderComposer();

    expect(html).toContain("bg-background/85 text-ui-xs");
    expect(html).not.toContain("text-[7px]");
  });

  it("输入框附件按媒体（图片/视频）优先于文件排序，媒体组内保持添加顺序", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "SNAKE-ARENA.md",
        id: "file-first",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-first",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "avatar.png",
        id: "image-second",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-second",
        operationId: "operation-image-second",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "demo.mov",
        id: "video-third",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "video/quicktime",
        objectUrl: "blob:video-third",
        operationId: "operation-video-third",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 100,
        uploadStatus: "ready",
      },
    ];

    const html = renderComposer();

    expect(html.indexOf('data-composer-attachment-kind="image"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="file"'),
    );
    expect(html.indexOf('data-composer-attachment-kind="video"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="file"'),
    );
    // 媒体组内按添加顺序混排：后加的图片仍在先加的视频之前。
    expect(html.indexOf('data-composer-attachment-kind="image"')).toBeLessThan(
      html.indexOf('data-composer-attachment-kind="video"'),
    );
    expect(html).toContain('data-composer-file-attachments-row="true"');
    expect(html).toContain("flex-col items-start");
    expect(html).toContain('data-composer-attachment-kind="image"');
    expect(html).toContain('data-composer-attachment-kind="video"');
    expect(html).toContain('data-composer-attachment-kind="file"');
    // 视频与图片共用 48px 媒体卡片；本地 objectUrl 存在时显示首帧。
    expect(html).toContain('data-composer-attachment-kind="video"');
    expect(html).toContain('data-composer-attachment-url="blob:video-third"');
    expect(html).toContain('data-composer-image-preview="avatar.png,demo.mov"');
    expect(html).toContain("size-12");
    expect(html).toContain("h-12");
    expect(html).toContain("w-fit max-w-full");
    expect(html).toContain("gap-2 rounded-lg border");
    expect(html).toContain("size-9 rounded-md bg-background");
    expect(html).toContain("pr-6");
    expect(html).not.toContain("pr-8");
    expect(html).toContain("SNAKE-ARENA.md");
    expect(html).toContain('title="SNAKE-ARENA.md"');
    expect(html).toContain("truncate text-ui-base");
    expect(html).toContain("min-w-0 max-w-40 flex-1");
    expect(html).toContain(">MD<");
    expect(html.match(/data-composer-attachment-remove=/gu)).toHaveLength(3);
    expect(html).toContain("size-3.5 rounded-full bg-primary");
    expect(html).toContain("lucide-x size-2.5");
    expect(html).toContain("opacity-0");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("focus-visible:opacity-100");
    expect(html).toContain("[@media(hover:none)]:opacity-100");
    // 走查 composer-4/touch-6：× 视觉 14px 保持不变，触屏态以伪元素展开 44×44 命中区。
    // （content-[''] 中的引号会被 renderToStaticMarkup 转义为 &#x27;，这里只断言到 content-[ 前缀。）
    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:after:size-11");
    expect(html).toContain("(pointer:coarse)]:after:content-");
    expect(html.match(/top-0\.5/gu)).toHaveLength(3);
    expect(html.match(/right-0\.5/gu)).toHaveLength(3);
    // 保留原有定位契约：× 仍锚在 0.5 偏移。负向断言排除触屏扩展命中区的伪元素类
    // （after:top-1/2 合法存在，不能被裸 "top-1" 子串误伤）。
    expect(html).not.toMatch(/\btop-1(?![/\d])/);
    expect(html).not.toMatch(/\bright-1(?![/\d])/);
  });

  // 走查 composer-3/touch-7：发送/停止是手机端最高频操作，触屏态命中区抬升到 44×44。
  it("发送按钮触屏态命中区抬升到 44px（min-h-11/min-w-11），视觉 icon 尺寸不变", () => {
    const html = renderComposer();

    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-h-11");
    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:min-w-11");
    expect(html).toContain(`data-testid="${TID_V4_COMPOSER_SEND}"`);
    expect(html).toContain("size-4");
  });

  // 走查 composer-4/touch-6：重试按钮触屏态伪元素向左展开 44×44，且带 z-30
  // 保证与 × 扩展命中区的重叠带内优先重试、不误删附件。
  it("失败附件的重试按钮触屏态命中区 44px 并以 z-30 优先于移除按钮", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 1,
        filename: "notes.md",
        id: "file-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-1",
        showComplete: false,
        uploadError: "network unavailable",
        uploadProgress: 17,
        uploadStatus: "failed",
      },
    ];

    const html = renderComposer();

    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:after:size-11");
    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:z-30");
    expect(html).toContain("[@media(hover:none)_and_(pointer:coarse)]:after:right-[-8px]");
  });

  // 媒体卡片（grid 变体、block 流）里的重试按钮原本始终溢出 48px 卡片、被根节点
  // overflow-hidden 裁剪为不可见；根节点放开裁剪后改为显式不渲染，可见行为不变。
  it("媒体附件失败态不渲染重试按钮（保持既有不可见行为），文件失败态渲染", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 1,
        filename: "avatar.png",
        id: "image-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "image/png",
        objectUrl: "blob:image-1",
        operationId: "operation-image-1",
        showComplete: false,
        uploadError: "network unavailable",
        uploadProgress: 17,
        uploadStatus: "failed",
      },
      {
        adopted: false,
        autoRetryCount: 1,
        filename: "notes.md",
        id: "file-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-1",
        showComplete: false,
        uploadError: "network unavailable",
        uploadProgress: 17,
        uploadStatus: "failed",
      },
    ];

    const html = renderComposer();

    // 只剩文件附件的重试 testid；媒体（image-1）不渲染重试按钮。
    expect(html.match(/v4-attachment-upload-retry-[^"]+/gu)).toEqual([
      testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, "file-1"),
    ]);
  });

  it("视频附件与图片同样显示主题 token 上传进度环与 48px 卡片", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 0,
        filename: "demo.mov",
        id: "video-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "video/quicktime",
        objectUrl: "blob:video-1",
        operationId: "operation-video-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadProgress: 42,
        uploadStatus: "uploading",
      },
    ];

    const html = renderComposer();

    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, "video-1")}"`);
    expect(html).toContain('role="status"');
    expect(html).toContain("42%");
    expect(html).toContain('stroke-dasharray="42 100"');
    expect(html).toContain('data-composer-attachment-kind="video"');
    expect(html).toContain('data-composer-attachment-url="blob:video-1"');
    expect(html).toContain("size-12 overflow-visible rounded-lg");
  });

  it("非图片失败态提供 alert、错误提示、重试和适配窄屏的行内布局", () => {
    attachmentState.attachments = [
      {
        adopted: false,
        autoRetryCount: 1,
        filename: "notes.md",
        id: "file-1",
        localZeroCopy: false,
        referenceOwnership: "composer",
        mimeType: "text/markdown",
        operationId: "operation-file-1",
        showComplete: false,
        sizeBytes: 100,
        staged: false,
        uploadError: "network unavailable",
        uploadProgress: 17,
        uploadStatus: "failed",
      },
    ];

    const html = renderComposer();

    expect(html).toContain('role="alert"');
    expect(html).toContain("network unavailable");
    expect(html).toContain(`data-testid="${testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, "file-1")}"`);
    expect(html).toContain('aria-label="重试上传"');
    expect(html).toContain("flex-wrap");
    expect(html).toContain("max-w-full");
    expect(html).toContain("text-destructive");
  });
});
