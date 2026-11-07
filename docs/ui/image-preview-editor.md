# 图片标注编辑器与加入草稿（image-preview-editor）

日期：2026-11-07（upstream v3.17.1 F15 移植，来源 SHA a60ba6a7）。承接 fork
[upstream-review-ledger](../fork/upstream-review-ledger.md) 旧候选 I12（图片复制、保存、加入草稿）的
「加入草稿」线，语义归属见共存章节。

## 背景

上游 v3.17.1 在 ui 新增 `image-preview-editor` 全新模块
（`contract.ts` / `geometry.ts` / `annotations.tsx` / `ImageEditorToolbar.tsx` /
`ImagePreviewSurface.tsx` / `composerTarget.ts` / `index.ts` / `module.ts` / `CONTRACT.md`），
并把标注能力并入共享 `ImagePreviewDialog`（上游
`docs/ui/shared-image-preview-dialog.md` 的 "Preview editing" 章节）。

本仓按 tier2 P0 裁决 4 **落地为独立模块、独立入口**：标注/导出/入草稿不并入任何预览弹窗。
本仓现状（三条预览链路均只读）：

- Composer 草稿媒体（图片/视频）经 ai-elements `ImagePreviewDialog` 只读画廊预览
  （`packages/ui/src/v4/ConversationComposer.tsx` 的 `composerMediaPreviewItems`）。
- Composer 草稿 PDF 与已发送 user row 的媒体经 `ChatMediaAttachmentPreviewDialog`
  （图片/视频/PDF 懒加载只读预览，`packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx`）。
- Markdown / Browser Use / `node_repl` 结果图片经共享画廊 dialog
  （[shared-image-preview-dialog.md](./shared-image-preview-dialog.md)）。

## 范围

- `packages/ui/src/image-preview-editor/` 全模块：几何与历史纯函数（geometry）、标注渲染与
  PNG 导出（annotations）、工具栏（ImageEditorToolbar）、编辑器 Surface（ImagePreviewSurface）、
  焦点 Composer 捕获通道（composerTarget）、类型契约（contract）与公开入口（index/module）。
- 捕获通道：`registerImageComposerTarget` / `captureImageComposerTarget`，DOM CustomEvent
  `zcode:image-preview-composer-target`，同步单次请求-应答（事件名沿用本仓 composer 域既有
  add-to-chat 事件前缀：`WORKSPACE_FILE_ADD_TO_CHAT_EVENT`、`CODE_COMMENT_ADD_TO_CHAT_EVENT`
  均为 `zcode:`）。
- Composer 侧注册：`useComposerAttachments` 在 `listenAddToChatEvents && !disabled` 时注册
  receiver，`append` 走既有 `addAttachmentFiles`（唯一入队路径）。
- 入口（本卡唯一）：Composer 草稿**图片**附件 chip 的「标注」动作，打开独立编辑器 Dialog；
  输入源 = 该附件的 `objectUrl` 与 `filename`。
- i18n：`imageEditor.*` 文案（zh-CN / en-US 同步）。

## 非目标

- 预览弹窗不承载标注：`ChatMediaAttachmentPreviewDialog`、共享 `ImagePreviewDialog` 画廊、
  PdfViewer、Preview Pane 不出现标注工具、导出或入草稿按钮（共存章节）。
- 已发送 user row 图片、Markdown / 工具结果图片不新增标注入口（保持只读事实；后续卡另行评估）。
- 视频与 PDF 不提供标注：编辑器只接受 `image/*` 源。
- 不做剪贴板复制（I12 的「复制」线不承接，剪枝登记：无卡片依据，且旧口径已裁定「不新造
  clipboard 桥来凑平台一致」）；原格式字节下载保持共享画廊既有 Download 语义。
- 编辑器不持久化：不写 localStorage / snapshot / 协议字段；不上传原始文件；不发送消息；
  不调用主进程 / IPC / `window.zody`；不创建会话。
- 不改 `desktop-continuous` 与 `web-remote-replayable` 语义。

## 产品规则

1. **原图只读**。标注只叠加在渲染层；保存产出**新 PNG 附件追加草稿**，原附件字节与条目不变，
   不覆盖、不删除、不改上传状态。
2. **工具链**：select（选择/移动）、pen（画笔）、text（文字）、rectangle（矩形）、ellipse（椭圆）、
   arrow（箭头）、eraser（橡皮擦）、颜色选择、undo/redo。橡皮擦**整条移除**命中的标注，永不修改
   源像素；选中标注可用 Delete/Backspace 删除。
3. **坐标系**：标注点、线宽、字号均存储在原图自然像素坐标；视口缩放/平移只是渲染 transform，
   不改写标注数据；画笔/文字线宽按显示比例补偿（自然像素存储，屏幕视觉线宽稳定）。
4. **平移缩放**：缩放范围 50%–300%，滚轮（无需修饰键、以指针为锚点）、按钮与双指捏合同一区间；
   平移有界（溢出量夹紧），viewport resize 后重新夹紧；未溢出的 fit 图用普通光标，仅
   select 工具且图片溢出视口时 grab/grabbing；编辑工具用 crosshair / text 光标。
5. **文字工具**：点击放置锚点后弹出输入框；Enter（非输入法合成态 `isComposing`）提交、Escape
   取消、切换工具时自动提交非空文本；输入期间方向键与 Ctrl/Cmd+Z 被输入框消费，不触发画布
   快捷键（`input, textarea, [contenteditable=true]` 目标守卫）。
6. **导出**：canvas 尺寸 = 原图 `naturalWidth × naturalHeight`（自然尺寸，不受视口缩放影响）；
   只栅格化原图与标注层（非屏幕截图，避免缩放与主题背景污染输出）；选择框等编辑态装饰不进入
   导出；源图像素 > **32,000,000** 时拒绝导出并按失败提示（限制 canvas 内存）；跨域污染导致
   canvas 失败按显式错误处理。
7. **文件名**：源文件名去扩展名、剔除文件系统非法字符、截断 80 字符后拼 `-edited.png`
   （`<base>-edited.png`）；无有效 base 时用 `image-edited.png`；MIME 固定 `image/png`。
8. **保存与接收方**：点击保存时**同步**捕获当前焦点 Composer receiver；无 receiver → toast
   `imageEditor.noComposer`（不导出、不产生文件）；导出**异步**完成后不得重新查找 receiver
   （防止追加到另一会话），只校验既有 receiver 的活性并同步 `append`；任何失败（导出失败、
   receiver 已释放、append 拒绝）→ 保留标注与历史、toast `imageEditor.saveFailed`、可重试；
   成功 → `onSaved()` 回调（宿主可据此关闭编辑器）。
9. **附件门禁沿用现有**：`MAX_CHAT_ATTACHMENTS`（8）、`platform.maxAttachmentBytes` 尺寸过滤、
   上传调度与重试全部由 `useComposerAttachments` 既有逻辑承担（见
   [chat-file-attachments.md](./chat-file-attachments.md)）；编辑器不建第二套 admission，满额或
   超限时 `append` 按拒绝处理走失败提示。
10. **关闭即销毁**：transform 与标注历史只属于当前编辑器实例；关闭 Dialog 或更换源图即丢弃
    未保存标注（与上游语义一致，不弹确认、不暂存）。
11. **多 Composer 决定性**：捕获先到先得——事件应答由**首个已注册且活跃**的 receiver 占用；
    receiver 释放（scope 换代 / unmount / disabled）后旧引用 `append` 恒返回 false。

## 与 ChatMediaAttachmentPreviewDialog 的共存（裁决 4）

裁决（upstream-v3.17.1 tier2 P0 裁决 4）：**图片标注编辑器作为独立新模块落地；
ChatMediaAttachmentPreviewDialog 保留现有只读预览（图片/视频/PDF 懒加载），标注/导出/入草稿
不并入预览弹窗，入口独立。**

| 场景                                  | 行为                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer 草稿图片附件                 | chip 上「标注」动作打开**独立编辑器 Dialog**；预览点击仍走共享画廊（只读），两者互不嵌套                                                                            |
| ChatMediaAttachmentPreviewDialog      | 保持只读（图片/视频/PDF 懒加载/文本），不出现标注工具、导出或入草稿按钮                                                                                             |
| 共享 ImagePreviewDialog 画廊          | 保持只读 pan/zoom/download；不并入标注（裁决细化：裁决原文点名 ChatMediaAttachmentPreviewDialog，同一「预览弹窗」原则扩展到共享画廊，避免同类弹窗出现两套编辑语义） |
| 已发送 user row / Markdown / 工具图片 | 只读，无标注入口（非目标）                                                                                                                                          |
| 下载原字节                            | 共享画廊既有 Download 不变；编辑器只产出新 PNG，不承担原格式保存                                                                                                    |

I12 承接口径：「加入草稿」由本卡承接（保存 → 焦点 Composer 草稿新附件）；「保存原格式字节」
由共享画廊既有 Download 承担（不在本卡改动）；「复制到剪贴板」不承接（剪枝，见非目标）。

## 状态所有者

- **编辑器实例**（ImagePreviewSurface）：transform、标注历史（past/present/future）、进行中
  draft、文字 draft、selected、tool、color、saving、alive 标记的唯一所有者；关闭即销毁；
  不进 Zustand、不持久化。
- **附件事实与 admission**：`useComposerAttachments`（scopeKey =
  `workspaceIdentity?.trim() || workspacePath` + composer scope）是草稿附件列表与上传状态的
  唯一所有者；`addAttachmentFiles` 是唯一入队路径。
- **捕获通道无状态**：CustomEvent `detail` 是单次应答载体；receiver 以惰性包装反映活性
  （释放后 append 返回 false），通道不保存引用列表。

保存链路事件顺序（幂等与失效边界）：

```text
点击「保存到对话」（pending 锁检查）
  -> captureImageComposerTarget()：dispatchEvent 同步取首个活跃 receiver
  -> 无 receiver：toast noComposer，结束（不导出）
  -> 有 receiver：置 saving（工具/缩放/指针输入禁用）
       -> exportAnnotatedImage(img, overlay, filename)：异步自然尺寸 PNG
            -> 源像素 > 32M / canvas 失败 / 导出失败：toast saveFailed，保留标注，解锁
  -> 编辑器已关闭/换图（alive=false）：静默丢弃，不 append
  -> target.append(file)（同步 admission）
       -> false（receiver 已释放 / 满额 / 超尺寸）：toast saveFailed，保留标注
       -> true：onSaved()（宿主关闭编辑器；新附件走既有上传调度）
```

Composer 侧注册/释放顺序：

```text
useComposerAttachments(listenAddToChatEvents && !disabled)
  -> useLayoutEffect commit 阶段注册：append = (file) => addAttachmentFiles([file]).length === 1
       （commit 阶段先释放旧 receiver，避免 passive effect 前的回调写入旧草稿 scope）
  -> deps 变化（scopeKey 换代 / disabled）：cleanup 先置 active=false 再移除监听
  -> 异步导出完成后旧 receiver 的 append 恒 false（不写入旧 scope 草稿）
```

## 接口与依赖方向

```text
packages/ui  v4/composer/useComposerAttachments -> image-preview-editor（registerImageComposerTarget）
packages/ui  宿主（ConversationComposer 草稿图片 chip）-> image-preview-editor（编辑器 Dialog/Surface）
image-preview-editor -> components/ui（button/input/toast）、i18n/IntlProvider、logger、lucide 图标
```

- 依赖方向单向：宿主与 composer hook 依赖编辑器模块；编辑器模块不 import `v4/*`、不依赖
  composer / store / 服务层；无循环依赖。
- `contract.ts` 只导出类型：`ImageComposerTarget { append(file: File): boolean }`（同步
  admission；false 不发送、不重试）、`ImagePreviewSurfaceProps { src; alt; filename?;
imageTestId?; onSaved; onClose }`。
- `geometry.ts` 为纯函数（`clampOffset` / `zoomAtPoint` / `updateHistory` / `undoHistory` /
  `redoHistory` 与 Point/Size/Transform/History/Annotation/AnnotationTool 类型），无 DOM 依赖，
  可直接单测。
- `module.ts`：`id: "image-preview-editor"`，`requires: ["ui"]`，`publicEntrypoints:
["index.ts", "contract.ts"]`。
- 渲染层纯前端能力：不调用 `window.zody`、不新增 IPC / 平台服务方法；桌面与手机 Web 同一
  renderer 路径。
- 失败路径日志用 `packages/ui/src/logger.ts` 的 `logger.warn`，禁止 `console.log`。

## 幂等边界

- **保存防重入**：pending ref 锁；saving 期间工具、缩放与指针输入禁用；重复点击不重复导出 /
  追加，不产生重复文件。
- **半条标注不提交**：pointercancel / lostpointercapture 丢弃进行中 draft，仅 pointerup 提交
  历史；主动 release 后的重复事件由指针集合过滤。
- **历史操作**：undo/redo 到边界为 no-op；新编辑清空 future（redo 分支失效）。
- **receiver 活性**：多次 capture 都取当前首个活跃注册者；导出完成后不重新查找；释放后的旧
  receiver append 恒 false。
- **重复注册**：同一 hook 依赖变化先 unregister 再 register，事件应答不落进已释放实例。
- **缩放夹紧**：每次 transform 变化与 viewport resize 后重新夹紧 offset，溢出不累积。

## 验收场景

1. 工具链：草稿图片 → 打开编辑器 → 画笔/文字/矩形/椭圆/箭头按当前颜色绘制，select 选择并
   移动，eraser 整条擦除，undo/redo 往返一致；原图像素不被修改。
2. 平移缩放：滚轮以指针为锚缩放且限制 50%–300%；按钮与双指捏合同区间；拖拽平移始终有界，
   窗口 resize 后仍受界；未溢出图普通光标，仅 select+溢出才 grab/grabbing。
3. 文字输入：Enter（非合成态）提交、Escape 取消、切工具自动提交；输入期间 Ctrl/Cmd+Z 与
   方向键不触发画布快捷键。
4. 自然尺寸导出：已知像素 fixture → 保存 → PNG 尺寸等于原图 naturalWidth/Height、标注颜色
   出现在预期像素、文件名为 `<base>-edited.png`；不受视口缩放影响。
5. 入草稿：Composer 已有正文与附件 → 保存 → 恰好新增 1 个 PNG 草稿附件、正文与原附件保留、
   零发送（不产生 sendText / queue command）。
6. 无接收方：无活跃 Composer（未注册或 disabled）→ 保存 → `imageEditor.noComposer` 提示、
   不导出。
7. 失效与失败：导出中关闭编辑器或 scope 换代、append 拒绝（满额/超尺寸）、编码失败、
   > 32M 源像素 → 无迟到或重复追加；失败保留可编辑历史并可重试。
8. 布局与可达性：390/1100 宽、深浅主题、中英文下工具栏与保存可达、无横向溢出；toolbar role
   与逐工具 aria-label；保存 pending 态有状态文案。

## E2E 场景清单（按 e2e-case-lifecycle 现行规则登记）

组件交互验收入口：`packages/ui/test/browser/manual-review/pending/image-preview-editor.test.mjs`
（含 `.fixture.tsx`；本卡落点内）。fixture 以假 receiver（`registerImageComposerTarget`）断言
append 合同、导出像素与失效路径。manual-review/pending 未转正不计为正式 Desktop 通过。
场景已登记到
[conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 的
**PA161**（2026-11-07 accepted，先于代码写入，符合 e2e-case-lifecycle 覆盖规划规则）：

- **PA161-01 工具链**、**PA161-02 平移缩放**、**PA161-03 文字输入**、**PA161-04 自然尺寸导出**、
  **PA161-05 入草稿（正文/原附件保留 + 零发送）**、**PA161-06 无接收方提示**、
  **PA161-07 失效与失败**、**PA161-08 保存防重入**、**PA161-09 宽度/主题/语言矩阵**。
- 桌面 conversation-session 真实 Composer 保存链路 E2E 需 `packages/desktop`（不在本卡落点，
  缺口登记待协调，与 PA159/PA160 同口径）；**顺序约束：本卡先于 F28 完成**，F28 草稿事务须把
  「附件插入」纳入 claim/restore 测试。
- 剪枝登记：真实触屏设备、Windows/Linux 原生窗口、真实手机远控链路不由浏览器组件测试冒充；
  upload / 发送 / queue / fork / replay 组合剪枝（保存只走既有 draft admission，不新增第二条
  发送路径）；light/dark × locale × 宽度取代表组合不做全集。

## 兼容性

- 无协议行、snapshot、replayable 字段变更；relay / desktop main 不保存编辑器状态。
- `desktop-continuous` 与 `web-remote-replayable` 共用同一 renderer 路径，行为一致。
- receiver 随 composer scopeKey（`workspaceIdentity?.trim() || workspacePath` + scope）注册，
  scope 换代自动失效，无跨身份迟到写入。
- 上游将标注并入共享 `ImagePreviewDialog` 的做法不移植（裁决 4），上游
  `docs/ui/shared-image-preview-dialog.md` 的 "Preview editing / Editing validation" 章节仅作
  语义参考。
