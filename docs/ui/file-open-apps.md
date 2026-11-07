# 按格式选择打开应用（file-open-apps / 统一文件菜单）

日期：2026-11-07（upstream v3.17.1 F16 移植，来源 SHA a60ba6a7）

## 背景

本仓现有「打开方式」菜单由 desktop main 的静态白名单（`packages/desktop/src/main/editors.ts`，
`platform.getInstalledEditors()`）提供：跨平台候选 App 列表 + `existsSync` 过滤。它不感知文件
类型——一个 `.pptx` 和一个 `.py` 看到的是同一份编辑器列表，也看不到用户在系统里为该格式注册的
实际关联应用（如 WPS、预览、浏览器打开 PDF）。

上游 v3.17.1 引入两层能力：

- desktop main `file-open-apps` 模块：以**系统关联**为唯一事实源枚举「能打开这个文件的 App」，
  Windows 走 Shell 关联（ProgID / AppsFolder 图标、共享 WPS 启动器 suite 特判），macOS 走
  Launch Services，Linux 走 GIO/`.desktop`。
- ui `file-menu` 模块：`useFileApplications` 消费查询与打开；「另存为」用文件所属 workspace
  Host 的 `stat/readFileRange` 分块读取（≤50 MiB）防截断；`OpenSplitButton` 扩展
  `renderCard` 让整张预览卡复用按钮动作（I15 整卡打开）。

本仓 `OpenSplitButton` 版本较旧（无 `viewMenuItems` / `openDefaultOnPrimary` / `renderCard` /
右键菜单），按任务卡允许「对齐上游组件」或「手写同等透明按钮层」，验收只约束行为合同。

## 范围

- desktop main 新增 `file-open-apps` 模块（查询 + 启动 + 平台原生适配），经
  `IPlatformService` 新增可选方法暴露给 renderer。
- ui 新增 `file-menu` 模块：`useFileApplications`（查询/打开状态）、应用列表菜单项
  （默认标记、前三直显 + 「更多」子菜单）、「另存为」菜单项与分块读取。
- `OpenSplitButton` 扩展：本机文件下拉/右键改为系统关联应用（空结果回退静态编辑器菜单），
  新增 `renderCard` 供整卡复用；下拉与右键共用同一份查询与动作。
- `AssistantPreviewCards`（I15）：整卡点击与主按钮执行同一预览动作（详见
  [assistant-preview-cards.md](./assistant-preview-cards.md) 的整卡打开章节）。
- shared 新增 `FileApplicationInfo` / `FileApplicationTarget` 类型与两条 IPC channel。

## 非目标

- 不把系统关联查询扩展到目录：目录入口沿用调用方原来的编辑器菜单
  （`getInstalledEditors`），见共存章节。
- 不改 `getInstalledEditors` 本身：不移植上游「传文件路径追加匹配类型本机应用」的扩展，
  静态白名单行为、排序（Finder/Explorer 与 QSpace 在前，见
  [qspace-open-with-support.md](./qspace-open-with-support.md)、
  [windows-workspace-editor-menu.md](./windows-workspace-editor-menu.md)）保持现状。
- 远程 workspace（SSH/WSL/Docker/Web `/remote`）不把远端路径交给本机应用：远程文件入口继续
  走现有 `openInEditor(editorId, path, { remoteTarget })` 链路与静态编辑器菜单。
- 不新增协议行、snapshot 字段、relay/Host/Agent 状态；不创建 session。
- 不改变 `desktop-continuous` 与 `web-remote-replayable` 语义。
- 手机端 `mobileFileBrowserSave.ts` 的 16 MiB 保存限额与取消语义保持独立，不与本菜单合并。

## 产品规则

1. **系统关联是唯一事实源**。本机文件的「打开方式」列表 = 系统为该文件类型注册的关联应用；
   默认项标记 `isDefault` 来自系统查询结果，不从列表顺序推断。
2. **只接受本机真实文件**。目标必须满足：`pathKind === "file"`、绝对路径（按当前平台规则）、
   本机 `stat` 为普通文件、无 `remoteTarget`、无 `workspaceIdentity`。任一不满足或系统查询
   失败，一律失败关闭返回空列表。IPC 入口不信任 renderer 声称的 `pathKind`，自行复验。
3. **应用 id 是宿主摘要，不是命令**。renderer 只拿到 `{ id, name, iconDataUrl?, isDefault }`；
   `id` 由 main 对原生应用身份做规范化后哈希生成。打开时 main **重新查询当前关联**并按 id 匹配，
   匹配不到返回 `application_not_available`；不执行 renderer 提供的任何路径/命令。
4. **查询不写系统状态**（不改默认关联、不注册 handler）；每次调用独立，无跨工作区、文件或
   安装状态的持久缓存。
5. **去重与排序**：同一应用（bundle/package/desktop 身份）多个安装副本只显示一条，按
   默认优先 → 系统安装目录 → 版本 → key 的确定性顺序择一；显示名重复时追加身份消歧。列表
   默认项在前。同一选择顺序保证「菜单里看到的项 = 打开时再次选中的真实实例」。
6. **图标**：Windows 原生查询批量解析资源路径与带符号索引并返回有界 PNG；失败显式返回无图，
   **不使用普通 EXE 文件图标冒充应用资源**。共享 WPS 启动器（suite AppID
   `Kingsoft.Office.KPrometheus`）与当前格式的 ProgID 分开保留；所有格式统一使用该 AppID 在
   AppsFolder 登记的真实套件入口图标，不回退 Writer 图标；名称与启动身份不变。macOS/Linux
   图标由 IPC 调用方注入现有应用图标能力。图标提取失败不隐藏有效应用。
7. **打开失败可见**：查询失败、打开失败、IPC 拒绝都要有可见反馈（toast
   `chat.previewCards.openFileFailed`），不只写日志后静默结束。
8. Linux 缺少 GIO 时只保留能通过系统默认启动器确认打开的项。

## 与静态编辑器菜单（getInstalledEditors）的共存（裁决 4）

裁决（upstream-v3.17.1 tier2 P0 裁决 4）：**按格式打开以系统关联为唯一事实源
（file-open-apps），`getInstalledEditors` 静态菜单仅作为无系统关联文件类型的回退。**

| 场景                                                                   | 菜单内容                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 本机文件、系统关联非空                                                 | 仅系统关联应用（默认项在前 + 「更多」子菜单）；不与静态列表合并展示                |
| 本机文件、系统关联为空（该类型无注册应用，或查询失败按失败关闭返回空） | 回退静态编辑器菜单（`getInstalledEditors` 现状列表与排序）                         |
| 目录（workspace header、文件树目录入口等）                             | 维持 `getInstalledEditors` 现状，不引入系统关联                                    |
| 远程 workspace 文件                                                    | 维持现有 `openInEditor(remoteTarget)` + 静态编辑器菜单；系统关联查询不接收远端身份 |

- 回退不合并：系统关联有数据时静态列表完全不出现，避免两份事实源叠加造成重复项与顺序歧义。
- 空即回退：renderer 无法区分「无关联」与「查询失败返回空」（上游语义两者都是空列表），统一
  按同一规则回退；查询失败在 main 侧保留 warn 日志。
- 静态菜单的能力边界不变：它不是格式感知的，回退项打开走现有 `openInEditor(editorId, path)`
  链路与既有 editor 偏好持久化（`persistLastSelectedEditorId`），不冒充系统关联应用。
- 本表规则适用于所有「按格式打开」入口：`OpenSplitButton` 下拉/右键（消息文件卡、文件变更
  摘要面板）与产物「作为文件打开」（`ArtifactOpenAsFileButton`，本机副本同样有真实扩展名）。
  两处入口共用同一份查询与菜单组件，不各自维护第二份列表。

## 状态所有者

- **关联事实**：操作系统（Launch Services / 注册表 + AppsFolder / `.desktop` + GIO）是唯一
  所有者；desktop main `file-open-apps` 服务是只读查询/启动端口，自身无状态。
- **renderer 查询状态**：`useFileApplications` 是单一 per-target 状态所有者（应用列表、
  loading、请求序号）。应用列表属于当前目标和当次查询；切换路径或系统卸载应用后旧结果失效，
  菜单每次打开重新查询。UI 不持有 task/session/stream 状态。
- **保存字节来源**：文件所属 workspace Host 的 `fileService`（`stat` / `readFileRange`）；
  路径保持该 Host 的语义，不转换成本机路径。UI 只维护菜单项忙碌位与 pending 防重入。
- **平台注入**：renderer 经 `IPlatformService`（`packages/shared/src/platform.ts`）访问，不直接
  调用 `window.zody`；Web/远端环境无这些能力时菜单按能力缺席（可选方法不存在即不渲染系统
  关联入口，等同空列表回退规则）。

## 接口与依赖方向

```text
packages/ui  file-menu（useFileApplications / 应用菜单项 / 另存为 / fileCopy）
  -> IPlatformService.getFileApplications?(target) / openFileWithApplication?(id, target) / saveFile?(payload)
packages/shared  FileApplicationInfo / FileApplicationTarget + IPC channel 定义
  （沿用 zody: 前缀：GetFileApplications / OpenFileWithApplication，与 GetInstalledEditors 并列）
packages/desktop  main file-open-apps 模块（createFileApplicationService）
  -> 原生适配器：mac（NSWorkspace/Launch Services）/ windows（Shell IEnumAssocHandlers +
     IDataObject 启动、ProgID/AppsFolder 图标、WPS suite 特判）/ linux（GIO + .desktop 解析）
  -> 适配器可注入（测试用 fake adapter），图标能力可注入（mac/linux 由调用方注入现有图标能力）
```

- 依赖方向单向：ui → shared →（IPC）→ desktop main → 原生适配器。main 不反向依赖 ui；模块不
  依赖 task/session/runtime。
- `FileApplicationTarget` 携带 `path` / `pathKind` / 可选 `workspaceIdentity` /
  可选 `remoteTarget`——后两者只用于**拒绝**本机查询（远端身份失败关闭），不用于路由。
- 鉴于本仓 platform 尚无 `canOpenLocalFiles` 能力位，系统关联菜单的可用性判断 =
  `platform.getFileApplications && platform.openFileWithApplication`（可选方法存在性），不为本
  卡新增独立能力位；桌面平台实现两个方法，Web/远端不实现。

## 事件顺序（按格式打开）

```text
卡片/文件行挂载（默认不预取；仅当主按钮需要显示默认应用名时按目标预取一次）
  -> 用户打开下拉或右键菜单（onOpenChange=open）
  -> useFileApplications.load()：请求序号 +1 -> setState(loading) -> IPC getFileApplications(target)
       （卡片虚拟行重用时，旧目标的迟到响应按序号丢弃）
  -> main：validTarget（绝对路径 + 本机存在普通文件 + 无远端身份）
       -> 原生查询 -> 去重/确定性排序 -> 摘要 id -> （需要时）图标解码为有界 PNG
  -> renderer 渲染：默认项直显 + 前三项直显 + 其余进「更多」子菜单；空列表回退静态编辑器菜单
  -> 用户选择应用 -> IPC openFileWithApplication(id, target)
  -> main：再次 validTarget -> 重查当前关联（不取图标，不把图标解码耗时/失败引入启动链路）
       -> 按 id 匹配 -> 原生启动（Windows IDataObject / macOS open / Linux 系统默认启动器）
  -> 成功 {success:true}；失败 {success:false,error} -> renderer toast，可重试
```

整卡打开（I15）顺序见下节；「另存为」顺序：菜单项选中 -> 读取（见幂等边界）-> 保存对话框 ->
结果提示。

## 幂等边界

- **重复查询**：同一目标可重复调用（菜单每次打开都重查），无缓存；请求序号保证只有最新请求
  的响应能落进状态。
- **重复打开**：每次打开都重查关联后启动；id 失配（默认应用已变更、应用已卸载）返回
  `application_not_available`，不缓存上次身份、不回退执行旧命令。
- **重复保存**：同一菜单项 pending 防重入；读取前后各 `stat` 一次核对 `size` 与 `mtimeMs`。
- **失败重试**：查询/打开/保存失败不改变系统状态，可安全重试；取消保存是正常结果（不提示）。

## 另存为（≤50 MiB 分块读取防截断）

- `platform.saveFile` 是唯一保存端口；字节来源是文件所属 workspace Host 的
  `fileService.stat/readFileRange`（与 `mobileFileBrowserSave.ts` 同一读取形态，但限额独立）。
- 上限 **50 MiB**（`MAX_FILE_COPY_BYTES`），超出按 `file_too_large` 报错并提示
  `fileActions.saveAsTooLarge`；分块 1 MiB 顺序读取。
- **先完整读取原字节，再打开保存对话框**：用户在对话框中选择源文件本身也不会先把源文件截断。
- 读取完成后核对 `stat`：类型、`size`、`mtimeMs` 任一变化按 `file_changed` 失败；chunk 为空或
  超出请求长度同样失败。不做文本解码（按原始字节交付）。
- 成功提示：本仓当前所有 `saveFile` 宿主（桌面保存对话框、手机远控原生保存）都以写盘收尾，
  成功统一提示 `fileActions.saved`；上游按 `canOpenLocalFiles` 区分浏览器「已开始下载」的
  文案随该能力位缺省不移植（本仓无浏览器下载型 saveFile 实现）。取消始终不提示。
- 保存失败可见（`fileActions.saveAsFailed` / 限额 / 不可用文案），不只写日志。

## OpenSplitButton.renderCard 与 I15 整卡打开

- `renderCard?: (button, { handlePreview, canPreview }) => ReactElement`：整张卡片复用按钮的
  操作与状态，右键和下拉不维护两套动作。未传 `renderCard` 时行为与现状一致。
- `AssistantPreviewCards` 用法：铺满卡片的**透明按钮**承载整卡点击（`aria-label` =
  `chat.previewCards.openCard` 带 title），执行与主按钮相同的预览动作（Preview Pane /
  Browser / 文件链接）；右侧打开/下拉控件以更高层级叠放其上；**一次点击只命中一个目标，
  不触发两次预览**；`canPreview=false` 时透明按钮 `disabled`（pointer-events 关闭）。
- 卡片行保留 `data-preview-card-title` 属性作为 E2E 锚点。
- 右键菜单与下拉共用同一份应用查询与动作集：预览、按格式打开（系统关联 + 空回退）、另存为、
  复制绝对/相对路径。同一交互不出现两套不同的打开列表。
- 本仓实现允许二选一：对齐上游 `OpenSplitButton`（含 `viewMenuItems` /
  `openDefaultOnPrimary` / ContextMenu）或手写同等透明按钮层；验收只看行为合同：单一动作源、
  无重复触发、右键与下拉动作等价、整卡点击可访问性（aria-label、disabled）。

## 验收场景

1. 本机文件（含中文/空格路径）下拉与右键列出该文件类型的系统关联应用，默认项带默认标记；
   选择后由该应用真实打开（E2E 用 IPC probe 断言分发参数，不实际启动应用）。
2. 系统关联为空的文件类型回退静态编辑器菜单；系统关联非空时静态列表不出现（共存章节表格）。
3. 目录、远程 workspace 文件、不存在的路径不提供系统关联查询结果（失败关闭），远程入口维持
   `openInEditor(remoteTarget)` 现状。
4. I15：整卡点击与主按钮执行同一预览动作，各验一次且无双触发；不可预览时整卡不可点。
5. 另存为：≤50 MiB 文件保存后字节完整（尺寸/内容一致），>50 MiB 明确报错，取消无提示，读取
   期间文件被改写按失败处理（focused tests）。
6. 打开/保存失败有可见 toast，不静默。
7. Windows：WPS 关联格式统一显示套件入口图标而非 Writer 图标；图标提取失败的应用仍出现在
   列表中（无图不隐藏）。

## E2E 场景清单（按 e2e-case-lifecycle 现行规则登记）

入口：conversation-session 窗口 E2E
（`packages/desktop/test/e2e/conversation-session/conversation-session-assistant-preview-cards.test.ts`
扩展），desktop local 代表客户端。新 case 已登记到
[conversation-session-case-catalog.md](../conversation-session-case-catalog.md) 的 `APC` 组
（APC14–APC16，2026-11-07 accepted），覆盖状态登记于
[conversation-session-e2e-coverage-matrix.md](../testing/conversation-session-e2e-coverage-matrix.md)。

- **APC14 整卡打开（I15）**：completed turn 的文件卡与 Website 卡，先点主按钮再点卡片主体，
  两次动作打开同一 Preview Pane/Browser 目标；断言整卡层存在、disabled 态不可点。
- **APC15 按格式打开统一文件菜单**：以 IPC probe（仅替换目标文件的两条 IPC handler，不启动/
  安装真实应用）固定边界：0 / 1 / 3 / 10 个应用（含默认项）。断言：默认项直显、前三直显 +
  「更多」子菜单分发、右键菜单与下拉同一列表、选择动作经 renderer 后 probe 收到预期
  `applicationId` + `target`；0 应用时回退静态编辑器菜单。
- **APC16 另存为**：预置含中文空格路径的 ≤50 MiB 文件，另存为后对比目标字节完整；取消无
  提示。
- 剪枝（accepted 之外的登记见 catalog）：原生枚举结果依平台而变，不进窗口 E2E（用 probe 固定
  边界，不冒充系统枚举或实际启动）；>50 MiB 限额、1 MiB 分块边界、读取期间变更由 focused
  tests（`packages/ui/test`、`packages/desktop/test`）守住；Windows WPS 图标与 AppsFolder 行为
  由 main 侧单测（fake/脚本适配器）守住，不在 macOS runner 上伪造；Web/手机远端无本机应用
  菜单由 focused tests 守住；light/dark、locale 不与本菜单做全排列。

## 兼容性

- 可选方法 + 失败关闭：旧 renderer 对新 platform 不感知即可忽略；新 renderer 在无能力的宿主
  （Web、远端）按方法缺席处理，回退规则与空列表一致。
- 不新增协议行/snapshot/replayable 字段；`desktop-continuous` 与 `web-remote-replayable` 不受
  影响。
- 工作区身份沿用 `workspaceIdentity?.trim() || workspacePath` 现有构造；本模块中
  `workspaceIdentity` 只用于拒绝本机查询，不参与路由。
