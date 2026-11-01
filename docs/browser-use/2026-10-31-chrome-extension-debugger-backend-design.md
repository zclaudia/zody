# Chrome Extension + `chrome.debugger` Browser Backend 设计

日期：2026-10-31
状态：P0–P3 已实现并通过 macOS 主代理验收；Windows/Linux 未实机验证
关联：`2026-07-07-browser-control-protocol-spec.md`、`2026-07-07-agent-host-main-channel-spec.md`、`2026-07-08-webview-cdp-on-guest-pivot-spec.md`、`2026-09-07-desktop-zoom-coordinate-spec.md`

## 1. 背景与目标

内置浏览器已经通过 `<webview>` guest 的 `webContents.debugger` 使用 CDP。外部 Chrome 不能复用这条 Electron 通路；Chrome 136 起也不能依赖 `--remote-debugging-port` 调试默认用户数据目录。Electron debugger 的 `sessionId` 参数也不能直接套到 `chrome.debugger.sendCommand`。

本方案新增一种 Browser Use backend：用户在当前 Chrome Profile 安装 Manifest V3 扩展，扩展通过 `chrome.debugger` 附加到标签页，Zody 复用现有 browser-client、`BrowserCommand` 和 Playwright-like API 控制页面。

目标：

- 控制当前 Chrome Profile 中已经打开的页面，复用其登录态。
- 支持 Agent 新建标签页，以及经用户授权后接管已有标签页。
- 复用现有 `browsers → tabs → tab` 对象模型，不增加第二套 Agent 工具。
- 保持 IAB 和 CLI managed CDP backend 的现有行为。
- 明确连接、标签页、CDP attachment、命令和取消的唯一所有者。

首版不做：

- 不开放 `--remote-debugging-port`，也不提供 Playwright `connectOverCDP()` 可直接连接的原始 CDP socket。
- 不把外部 Chrome 页面嵌入 Zody side pane；页面仍显示在 Chrome 中，Zody 只展示命令结果和截图。
- 不读取、不导出、不同步 Chrome Cookie 库、密码、历史记录和完整 Profile 数据。已授权页面上的 `Runtime.evaluate` 仍能访问该页自己的 `document.cookie` 和 `localStorage`；这是页面控制能力，不是 Profile 同步。
- 不提供无约束的任意 CDP 工具；Console/Network 诊断能力另立后续规格。
- 不支持手机直接连接 Chrome，也不在本期改变 `web-remote-replayable` 语义。
- 不在首版对用户已打开的 tab 做 viewport 仿真或坐标 CUA。IAB 的 CSS 像素契约不自动适用于外部 Chrome。

## 2. 产品规则

1. **显式配对**：只有完成 Desktop 与扩展配对、协议握手和版本校验的 Profile 才出现在 backend discovery 中。
2. **不静默切换**：IAB 仍是默认 backend。存在 IAB descriptor 时，`getDefault()` 继续选择 IAB，除非用户把某个 extension `browserId` 设为当前窗口的默认 backend。`getForUrl()` 忽略未设为默认的 extension backend，不能因为扩展 tab 的 URL 命中就把任务迁出 IAB。
3. **按 browserId 选择 Profile**：每个已配对 Profile 是独立 backend。`browsers.get("extension")` 只在当前窗口恰好可见一个 extension backend 时成功；多个 Profile 必须 `browsers.get(browserId)`。descriptor metadata 不得设置 `preferred`、`preferredInstance`、`profileIsLastUsed` 或 `profileOrdering`。
4. **Profile 隔离**：不能按窗口标题、URL 或 Chrome 内部数字 tabId 跨 Profile 匹配。
5. **单窗口绑定**：同一 Profile 同一时间只绑定一个 Zody 窗口及其 window-scoped Host。其他窗口不能枚举或控制该 Profile；用户可显式转移绑定。
6. **已有 tab 显式授权**：`browser.user.openTabs()` 只提供可授权页面的标题和去掉 userinfo、query、hash 的 URL。`claimTab` 分两阶段完成，不得把现有 30 秒 Host 桥超时耗在等人点击上。配对 Profile 不等于授权 Agent 控制全部已登录页面。
7. **Agent 新 tab**：配对后，`tabs.new()` 创建的 agent-owned tab 可以直接 attach，但默认后台打开，不调用会激活标签页或把 Chrome 拉到前台的 API。
8. **受限页面 fail closed**：`chrome://`、Chrome Web Store、扩展内部页，以及 DevTools 已占用调试器或其他原因导致 attach 失败的页面，返回 `target_unavailable`。同一轮不得自动重试，也不能退化为 content script 或远程调试端口。
9. **断连不静默续跑**：连接代次变化后，旧 backend/browser/tab binding 全部失效；有副作用命令不自动重试。
10. **首版仅 Desktop local**：`desktop-continuous` 可用；`web-remote-replayable` 不返回 extension descriptor，避免未经恢复链路验证就暴露能力。

## 3. 总体架构

```text
Agent / node_repl / browser-client
              │ 现有 BrowserControlPort + ZCode Protocol
              ▼
Window-scoped Desktop Host
  ExtensionBrowserBackend
    - 向 Main 领取 browserGeneration
    - logical tabId、workspace/session owner、tab class
    - 授权请求、lease、per-tab 串行命令、cancel/timeout、副作用判定
    - CDP sessionId ↔ targetId 映射
  ExtensionCommandExecutor
    - BrowserCommand → 扩展传输契约
              │ HostResponseTypes / HostMessageTypes
              ▼
Electron Main：ExtensionBridgeServer
    - loopback 监听、配对证明、connection registry
    - 按 profileInstanceId 持久化 generation 与窗口绑定
    - Host 路由与 requestId 转发
    - Host 退出时通知扩展 detach
    - 不保存 task/session/workspace/tab claim 业务状态
              │ ws://127.0.0.1:<configured-port>
              ▼
Chrome MV3 Extension
  Offscreen document：WebSocket 连接所有者
  Service worker：chrome.tabs / chrome.debugger 与事件转发
              │ chrome.debugger（tabId 或 targetId，无 CDP sessionId）
              ▼
当前 Chrome Profile 的真实标签页
```

连接所有者是 offscreen document。Service worker 负责 Chrome API，不作为常驻 WebSocket 进程。P0 必须证明：配对完成后空闲 2 分钟且没有 CDP 命令，连接和已有 attachment 仍然有效。做不到时停止后续阶段，而不是把保活留到实现时再补。

Renderer 只负责配对、连接状态、Profile 绑定和撤销授权的展示，通过 `IPlatformService` 访问 Main；不得直接连接 WebSocket，也不得持有第二份 tab ownership。

### 为什么选 loopback WebSocket，而不是 Native Messaging

- 用户只需安装扩展并保持 Zody 运行，不需要额外安装原生消息清单和 companion executable。
- CDP 事件、DOM snapshot 和 base64 截图需要双向、高频和大消息传输，WebSocket 更直接。
- Desktop 与扩展可共享严格的版本化消息契约；后续如确需系统级配对发现，再独立增加 Native Messaging bootstrap，不改变业务协议。
- 本机其他进程可以占用端口并伪造 `Origin`。鉴权靠配对证明和重连挑战，不靠 Origin，也不靠可重放的 bearer token。

## 4. 状态所有者

| 状态/事实                                            | 唯一所有者                     | 其他组件允许持有的内容                                      |
| ---------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| Chrome window/tab 是否存在、URL、active 状态         | Chrome                         | 扩展和 Host 的即时投影，不作为跨事件持久事实                |
| 原生 debugger attachment                             | Chrome 扩展                    | Host 保存 `attachmentId` 与期望状态，不伪造 attach 成功     |
| WebSocket connection、鉴权、绑定 windowId            | Main `ExtensionBridgeServer`   | Host 接收连接代次事件；事件只发给绑定窗口的 Host            |
| generation 计数与配对共享密钥                        | Main 连接注册表                | 扩展只保存自己的密钥副本；Host 不自行从 0 重新计数          |
| `browserId` / 当前 `browserGeneration`               | Host 根据受信握手事件采用      | CLI 持久 Browser 对象只保存引用并逐次校验                   |
| logical tabId、workspace/session/remoteSession owner | Host `ExtensionBrowserBackend` | Main 和扩展不接收 workspacePath/sessionId                   |
| user tab 授权请求、agent/user 标记、lease            | Host                           | 扩展只保存当前连接的 logical tabId、native tabId、tab class |
| 每 tab 命令串行化、pending、timeout/cancel、副作用   | Host                           | Main 仅做传输 correlation                                   |
| CDP sessionId ↔ targetId                             | Host                           | 扩展协议使用 `targetId`，不接受 CDP `sessionId`             |
| CDP attach/detach 的实际执行                         | 扩展 service worker            | Main 不直接调用 Chrome API                                  |
| 设置页草稿、配对码输入、选中 Profile                 | Renderer                       | 不作为服务端连接事实                                        |

禁止把 `webContents` 的同步 getter 假象套在扩展上。外部 Chrome 的 URL/title/navigation 状态通过异步 CDP/`chrome.tabs` 查询获得，不能用可能过期的缓存冒充实时状态。

## 5. 身份与代次

### 5.1 Backend identity

扩展首次安装时生成随机 `profileInstanceId` 并保存到 `chrome.storage.local`。它不读取或上报操作系统 Profile 路径、Chrome 用户名和邮箱。用户清除 extension storage 后，该值重新生成，旧配对失效，必须重新配对。

```text
browserId = "extension:" + profileInstanceId
connectionId = 每次 WebSocket 握手生成的随机 ID
browserGeneration = Main 为该 profileInstanceId 持久化的单调递增整数
```

只有 `hello → 配对或重连证明 → welcome → capabilities ready` 完成后，Host 才向 Main 领取下一个 generation 并返回 descriptor：

```ts
{
  id: browserId,
  generation: browserGeneration,
  type: "extension",
  name: "Chrome Extension",
  capabilities: { browser: [], tab: [] },
  apiSupportOverrides: {
    "BrowserUser.history": false,
    "Tab.setViewportSize": false,
    "CUAAPI.click": false,
    "CUAAPI.double_click": false,
    "CUAAPI.drag": false,
    "CUAAPI.move": false,
    "CUAAPI.scroll": false,
    "CUAAPI.downloadMedia": false,
    "DomCUAAPI.downloadMedia": false,
  },
  metadata: { provider: "zody-chrome-extension" }
}
```

`capabilities` 不列出 `visibility`。Recording 已由现行 manifest 对 `extension` 默认隐藏，descriptor 不得把 `BrowserRecordingAPI.*` 覆盖回 `true`。坐标 CUA 与 `Tab.setViewportSize` 在独立坐标契约验收前保持关闭。

重连、协议升级、撤销配对、窗口转移和 Host 重启后的新握手都领取新 generation。不能使用 `Date.now()`，也不能在 Host 内存里从 0 重新计数。

### 5.2 Tab identity

```text
logical tabId = "extab:" + UUID                 // Host 创建，Agent 使用
TargetRef = { browserId, browserGeneration,
              connectionId, nativeTabId, attachmentId }
ChildTarget = { targetId }                      // chrome.debugger 子 target，不是 CDP sessionId
```

- `nativeTabId` 只在单个 Profile 内有意义，不能作为跨 backend 的公开身份。
- 每次成功 attach 返回新的 `attachmentId`；CDP 请求和事件必须同时携带它。
- `TargetRef` 任一项不匹配都拒绝命令；迟到事件和结果只能按原 request/attachment 清理，不得影响新 attachment。
- Host 内部可以继续使用 Playwright executor 的 `sessionId`。扩展传输只使用 `tabId` 或 `targetId`。Host 负责两者的映射，不得把 `sessionId` 传给 `chrome.debugger.sendCommand`。

### 5.3 P1 落地约束（Main 持久化与 Host 路由）

- Main 的凭据与 generation 记录保存在 Desktop 用户数据区的
  `browser-extension/bridge-state.json`，仅当前用户可读（POSIX `0600`），采用临时文件 +
  rename 原子写。`profileInstanceId` 的 generation 在进程重启后继续单调递增；写入失败不得
  发送 `welcome`。
- `windowId` 是 Zody 窗口的稳定字符串标识，当前取 `String(webContents.id)`。配对会话记录发起
  窗口；重连只把连接事件投递给该窗口的 Host。未绑定窗口的凭据不进入任何窗口 discovery。
- Host ↔ Main 只新增传输消息：Host 请求 `list/request/send`，Main 返回结果并推送
  connection changed 与 `cdp.event` / `target.*`。Generation 由 Main 在握手时发放，Host
  只采用受信值；Host 不转发 workspace/session 字段给扩展。
- Host 的 IAB 与 extension backend 由统一 router 聚合。`web-remote-replayable` 的
  `list()` 过滤 extension descriptor；`execute()` 只按显式 `browserId + browserGeneration`
  路由，backend 消失不得改投 IAB。
- P1 不实现两阶段 claim、openTabs、locator、dialog、viewport 仿真和坐标 CUA。除
  tabs.new/list/get/close、navigate/back/forward/reload/getState、viewport screenshot
  外的命令返回 `capability_unsupported`；`fullPage`、`clip`、`ref` 截图同样拒绝。

### 5.4 P2 落地约束（两阶段 claim、locator 与 dialog）

- 传输新增三条不占用 30 秒命令预算的消息：Host → Extension 的 `claim.request` /
  `claim.cancel` 使用 `send` 语义，Extension → Host 的 `claim.decision` 由 Main 原样转发。
  `claim.request` 只登记 pending 并更新 badge，不做 attach；`claim.decision` 只记录 grant，
  仍由同一 session 第二次 `claimTab` 才 attach。
- pending claim 的唯一所有者是 Host `ExtensionClaimManager`：同一窗口单 pending，同
  session + 同 native tab 合并，其他 session/tab 返回 `permission_denied`；TTL 默认
  2 分钟。超时、取消、连接代次变化和未知 claimId 的晚到同意都 fail closed，并向扩展发送
  `claim.cancel` 清理 badge/Popup。
- 用户 Deny 或关闭 Popup 后，Host 记录一次性拒绝事实：同一 session + 同一 native tab 的
  下一次 `claimTab` 直接返回 `permission_denied`、`sideEffect:"none"`，不重新发送
  `claim.request`、不 attach。拒绝事实消费一次后，后续 claim 才视为新的显式用户意图；
  连接代次变化仍清空拒绝事实。
- `openTabs` 的公开 id 使用 Host 生成的 `extuser:<nativeTabId>`，只在当前 backend scope
  内解析。URL 去掉 userinfo/query/hash；只返回 http(s) 且非 Chrome Web Store 的页面。
  `debuggerAttached` 或 attach 失败都按 `target_unavailable` 处理，同一轮不重试。
- `PlaywrightPage` 是 backend-neutral 执行端口，位于 `packages/desktop/src/browser-core/playwright/`。
  IAB 与 extension 共用 locator、domSnapshot、evaluate、trusted input 和虚拟剪贴板算法；
  extension adapter 只把 Host sessionId 映射到 `debugger.attach({targetId})` 的子 attachment，
  wire 不出现 CDP sessionId。
- JS dialog 事件按事件自带 `targetId` 归属到 nativeTabId 对应的 tab。用户 tab 的命令预算
  耗尽前仍未处理时，Host 发送 `Page.handleJavaScriptDialog { accept:false }`；仍无法解除
  则 detach 并撤销 lease。绝不默认接受可能提交数据的 dialog。
- Chrome/Electron 对隐藏 tab 的 CDP Input 可能静默丢弃。共用 locator 在
  `document.visibilityState === "hidden"` 时对 click/dblclick/check/press 使用页面内事件兜底；
  可见页面仍使用 trusted input。该兜底不改变 IAB 可见页面的既有语义。
- P2 仍不开放坐标 CUA、`Tab.setViewportSize`、`fullPage`/`clip`/`ref` screenshot、
  download、file chooser 和用户 tab 的 viewport 仿真。

### 5.5 P3a 生命周期落地约束

P3a 只实现生命周期与跨窗口转移的内部能力，不接 Settings UI、安装入口、默认 backend
设置或手机 UI（P3b）。

- `debugger.attach` 必须携带 `tabClass:"agent" | "user"`。扩展把该字段持久化到
  `chrome.storage.session` 的 attachment 注册表；子 target attach 继承父 tab 的 class。
  Host 仍是 logical tab owner，扩展只记录 transport 事实，不能自行猜测 class。
- Host `ExtensionRequestTracker` 是命令 cancel/timeout/dispatch 的唯一 owner。每个命令
  requestId 只有一条 entry；`cancelRequest` 只 abort 目标 entry，不删除后续同 key 或
  其他 tab 的 pending。命令超时使用同一 abort 路径并返回 `timeout`。
- 扩展 wire 上的 `cdp.request` requestId 与 Host 命令 requestId 分层记录：Host 为每个
  在途 wire 请求登记，取消时发送 `request.cancel`。扩展只对 `Runtime.evaluate` /
  `Runtime.callFunctionOn` 尽力发送 `Runtime.terminateExecution`；导航、点击等不能伪称
  回滚。已下发副作用命令取消/超时为 `sideEffect:"uncertain"`，未下发为 `"none"`。
- WebSocket close、offscreen/SW 重启、扩展重载都按新 connection 处理。扩展在
  `session.detachAll`、socket close 和扩展启动/重载清理时 detach 全部 debuggee：
  `tabClass:"agent"` 的 Chrome tab 关闭，`tabClass:"user"` 的 tab 只 detach 并留在
  Chrome。清理幂等，旧 attachment 事件不能命中新 binding。
- `session.detachAll` 是显式生命周期屏障：offscreen 必须 await 对应的 worker 清理，
  后续 `welcome`/`tabs.create`/`debugger.attach` 才能继续；worker 侧在清理开始时同步
  占位 flight，`tabs.create`、`tabs.close`、`debugger.attach/detach`、`cdp.request`、
  claim 和 `tabs.list` 都等待 flight。普通 CDP 转发与 `request.cancel` 不进入屏障，
  继续保持 P2 的并发语义。这样旧 cleanup 的 agent tab 台账快照不会包含新 connection
  创建的 tab。
- 扩展在 `chrome.storage.local` 保存 agent tab 台账。`chrome.runtime.onInstalled`
  （安装/更新/重载）时清空 `storage.session` attachment 注册表并按台账关闭 agent tab；
  普通 SW 冷启动不清理，保证 P0 的空闲 attachment 继续可用。浏览器重启后 tabId 会变化，
  因此不用旧台账关闭新会话页面，避免误关用户 tab；P3a 只承诺同一浏览器会话内的扩展重载。
- Host 退出时 Main 对绑定窗口的 Profile 发送 `session.detachAll{reason:"host_exit"}`，
  并立即持久递增 generation（socket 保留）。同窗口新 Host 注册前必须等待该作废完成；
  它拿到的是新 generation，旧 CLI 持久 `browserGeneration` 不能继续控制该 Profile。
  Host 进程同时 dispose tracker/claim/dialog/tab 投影，pending 全部 settle。
- 跨窗口转移只提供 Main/Host 内部能力：Main 先发送
  `session.detachAll{reason:"window_transfer"}`，旧窗口收到 disconnected 事件后全部
  binding 失效；随后 Main 持久递增 generation、更新凭据窗口绑定并把连接事件投递给新窗口。
  connectionId 保持该 socket 的身份；旧 socket 的迟到 disconnect 仍按 connectionId
  判定，不能清除新绑定。
- `finalize` 只更新 lifecycle；`finalizeTabs` 与 IAB 对齐：`keep` 是状态标记集合，
  遗漏的 tab 不关闭、不 detach；`handoff` 只更新 lifecycle，`deliverable` 更新 lifecycle
  后释放 debugger（agent/user tab 都留在 Chrome）。未知或跨 session 的 `keep` tabId
  返回 `backend_unavailable`，不部分应用。
- `turnEnded` abort 同 session/turn 的在途命令；`closeSession` abort 后释放 session 名下
  debugger：默认 agent tab 关闭、user tab detach 并保留；显式 `closeTabs:true` 关闭
  session 名下全部 tab。
- 单帧 8 MiB、结果 4 MiB 上限沿用 transport/pending registry；超限立即失败并删除 pending
  entry，不排队。`fullPage`/`clip`/`ref` screenshot 继续 `capability_unsupported`。

### 5.6 P3b 产品化落地约束

- Settings 通过 `IPlatformService` 的 typed IPC 访问 Main `ExtensionBridgeController`；Renderer
  不建立 WebSocket，也不持有连接/凭据事实。配对码只在发起窗口的 `beginPairing` 返回值中出现，
  status 只返回该窗口的 `pairingSessionId`、`extensionId`、`profileInstanceId` 和过期时间。
- Main 在 `hello` 时把 `extensionId`/`profileInstanceId` 挂到当前配对会话，供发起窗口核对；
  配对码、共享密钥和证明不进入 status、日志或 discovery metadata。
- `getStatus(windowId)` 只返回绑定当前窗口的 Profile，以及绑定窗口已无 Host 注册的孤儿 Profile；
  绑定其他活动窗口的 Profile 不可枚举。撤销/转移在 IPC 入口再次按同一可见性校验，不能只信
  Renderer 传来的 `profileInstanceId`。
- 端口配置由 Main 先重启 bridge 再持久化：新端口占用时恢复旧端口并返回 `port_in_use`，不自动
  扫描。设置值持久化为 `AppSettings.browserExtensionBridgePort`；扩展 Popup 独立保存同一端口。
- 默认 backend 是**当前窗口**设置，唯一 owner 是 Main `ExtensionBridgeController` 的内存 map；
  Settings 通过 typed IPC 写入具体 `browserId`，不写 `AppSettings`。只允许绑定当前窗口的 Profile；
  renderer reload 保持（同一窗口身份），app restart 后安全回落 IAB，不持久化 numeric windowId。
  Main 把值 push 给该窗口 Host，Host 通过 `interaction/browserDefault` 交给 CLI
  `BrowsersFacade` 的既有 `defaultBrowserId` 规则；`web-remote-replayable` 一律返回 undefined，
  不继承桌面 extension 默认。未配置时 IAB 默认不变，配置目标离线时 fail closed。旧的全局
  `AppSettings.browserDefaultBackendId` 被忽略，不迁移到任何窗口。
- 桌面端把 `packages/browser-extension/dist` 作为 `resources/browser-extension` 随包发布；设置页
  仍只提供手动加载步骤，不宣称品牌版 Chrome 可一键安装。手机 Web 仅只读提示，不返回 extension
  discovery，也不提供配对、撤销或转移。

## 6. 扩展与 Desktop 的传输契约

在 `packages/shared/src/browser-use/` 新增严格的 Zod schema，所有跨进程消息使用 `type` 判别联合并 `.strict()` 校验。扩展包从该叶模块导入，不从 shared barrel 导入。首版消息类别：

| 方向             | 消息                                         | 用途                                                     |
| ---------------- | -------------------------------------------- | -------------------------------------------------------- |
| Extension → Main | `hello`                                      | 协议版本、扩展版本、扩展 ID、profileInstanceId、扩展公钥 |
| Main → Extension | `welcome` / `pairingRequired` / `fatalError` | 握手结果、connectionId、nonce、能力版本                  |
| Extension → Main | `pairing.proof` / `resume.proof`             | 配对 HMAC 或重连挑战证明，不包含密钥原文                 |
| Host → Extension | `tabs.list/create/close`                     | 原生标签页生命周期；create 标记 `tabClass:"agent"`       |
| Host → Extension | `claim.request` / `claim.cancel`             | 建立或撤销待授权请求，不 attach                          |
| Extension → Host | `claim.decision`                             | 用户同意、拒绝或 Popup 关闭                              |
| Host → Extension | `debugger.attach/detach`                     | 建立或释放 attachment；子 frame 使用 `targetId`          |
| Host → Extension | `cdp.request`                                | method、params、TargetRef、可选 `targetId`               |
| Extension → Host | `cdp.result` / `cdp.event`                   | CDP 结果与已订阅事件，按 Debuggee `targetId` 区分        |
| Extension → Host | `target.updated/detached/closed`             | 原生 tab 与 attachment 变化                              |
| Host → Extension | `request.cancel`                             | 尽力取消未完成的传输或 evaluate                          |
| Main → Extension | `session.detachAll`                          | 绑定 Host 退出或窗口转移时释放全部调试                   |

要求：

- 每个请求都有独立 `requestId`；pending map 必须 compare-and-delete，重复 ID 直接失败。
- Host 发往 Main 的消息带 window/Host 路由信息；Main 发往扩展前剥离 session、workspace、turn 和本地路径。
- CDP 错误保留 method/code/message，由 Host 归一化为现有 `BrowserCommandResult`。
- 首版使用 JSON frame。单帧上限 8 MiB，截图和 DOM snapshot 的结果上限 4 MiB；超出即失败并释放缓冲，不排队、不无限缓存 console/CDP 事件。
- 首版 `screenshot` 拒绝 `fullPage`。只订阅当前命令需要的 CDP domain/event。
- 扩展连接地址使用字面量 `127.0.0.1`，不使用 `localhost`。

`browserErrorCodeSchema` 新增：

- `authorization_required`：已创建或已存在待授权请求。`sideEffect:"none"`。模型应提示用户点击扩展图标，用户确认后再调用一次 `claimTab`；不得轮询。
- `permission_denied`：用户拒绝配对、拒绝该 tab，或授权已超时/撤销。不得自动重试。
- `target_unavailable`：tab 关闭、用户取消调试、DevTools 占用、目标不可 attach 或 attachment 已失效。同一轮不得自动重试。

断连/旧 generation 使用 `backend_unavailable`；不支持的能力使用 `capability_unsupported`。这些码不能包装成 `execution_error`。错误对象保持现有 `code`、`message`、`sideEffect` 字段，不用 message 文本做流程判断。

## 7. 配对与安全

威胁模型是挡住其他网站、其他扩展和远程连接。本机同一用户下的恶意进程不在本方案的防御范围内；方案要挡住的是端口抢占后重放长期凭证。

### 7.1 配对顺序

```text
发起窗口的 Settings 生成一次性高熵配对码和 pairingSessionId
Chrome 扩展 Popup 连接 ws://127.0.0.1:<port>
        │ hello（无配对码、无共享密钥）
        ▼
Main 校验协议版本，向扩展返回 nonce
        │ 只在发起窗口展示扩展 ID、profileInstanceId、pairingSessionId
        ▼
用户核对 Popup 与 Zody 显示的 pairingSessionId 后输入配对码
        │ pairing.proof = HMAC(pairing码, nonce)
        ▼
Main 校验证明、尝试次数和 TTL
        │ 双方保存共享密钥；welcome
Host 领取新 generation → discovery 可见
```

重连不再发送凭证原文：

```text
hello → Main nonce
resume.proof = HMAC(共享密钥, "client" | nonce | connectionId)
Main 回 HMAC(共享密钥, "server" | nonce | connectionId)
任一步失败则断开，不进入 discovery
```

- WebSocket 只绑定 `127.0.0.1`，禁止 `0.0.0.0` 和局域网访问。
- `Origin: chrome-extension://<预期扩展 ID>` 只作为防御层。预期 ID 来自 manifest `key`，不依赖未打包路径生成的 ID。
- 配对码至少 128 bit 熵，一次性、短时有效并限制尝试次数。证明和共享密钥都不能写入日志、workspace 或 discovery metadata。
- Main 把 generation 与共享密钥放在 desktop 用户数据中的凭据记录里，权限限于当前用户。扩展把密钥放在 `chrome.storage.local`。
- 同一个 `profileInstanceId` 同时只有一条已认证 socket。新的成功握手关闭旧 socket 并领取新 generation。
- 配对会话属于发起 `windowId`。确认 UI 只出现在该窗口，成功后也只绑定该窗口。
- Desktop 与扩展使用同一默认 bridge port 常量，并允许两端一致地覆盖配置。端口占用时 Zody 显示 unavailable，不自动扫描，扩展也不向未通过 pairingSessionId 核对的对端发送证明。

### 7.2 页面授权边界

- 配对只授权 backend discovery 和 Agent 创建新 tab。
- 一个绑定窗口同时只有一个 pending claim。同一 session、同一 native tab 的重复 `claimTab` 合并到该请求。其他 session 或其他 tab 在请求未结束时得到 `permission_denied`。
- 授权只对当前 Profile、当前 native tab 和当前绑定窗口有效。用户同意后必须由同一 session 再次 `claimTab` 才 attach。
- 待授权请求由 Host 计时，默认 2 分钟。超时、取消或 Host 已放弃后，Popup 里的晚到同意不得 attach。
- 用户点击“停止调试”或 Chrome 调试条的 Cancel 后，Host 立即撤销对应 lease。Cancel 会解除该扩展的全部 attachment，Host 按每个 `onDetach` 处理，不自动 re-attach。
- 页面文本、DOM、Console、网络内容和 tab 标题始终视为不可信数据，不能改变 Agent 的系统指令或授权范围。

## 8. 核心事件顺序

### 8.1 Agent 新建 tab

```text
Agent tabs.new(url)
  → Host 校验 backendGeneration，创建 logical tabId 与 owner，tabClass=agent
  → Main 按 connectionId 转发 tabs.create(active:false)
  → Extension chrome.tabs.create
  → Extension chrome.debugger.attach({ tabId }, "1.3")
  → Extension 返回 nativeTabId + attachmentId
  → Host 原子登记 TargetRef，执行 Page.enable 与必要初始化
  → Executor 导航并等待约定的页面状态
  → BrowserCommandResult(meta.backendType="extension")
```

在 attach 成功前不得把 tab 加入 `tabs.list()`。attach 或初始化失败时关闭该 Chrome tab 并丢弃 logical tabId。不得调用 `tabs.update({ active:true })` 或 `Page.bringToFront`。

### 8.2 接管已有 tab

```text
Agent browser.user.openTabs()
  → Host 请求当前 Profile 可授权 tab 列表
  → 返回未 claim、非受限页面的 BrowserUserTabInfo
  → URL 去掉 userinfo、query 和 hash

Agent browser.user.claimTab(info)          // 尚无授权
  → Host 创建唯一 pending claim
  → 扩展图标 badge 显示待授权数量
  → Zody 提示用户点击扩展图标
  → 立即返回 authorization_required，不 attach

用户打开 Popup 并同意
  → Extension 发送 claim.decision=granted
  → Host 只把授权记到发起 session；仍不 attach

同一 session 再次 claimTab(info)
  → debugger.attach → attachmentId
  → Host 建立 session owner + lease + logical tabId，tabClass=user
  → 该 tab 进入当前 session 的 tabs.list()
```

另一个 session 或窗口不得通过已知 nativeTabId 绕过 claim。用户拒绝返回 `permission_denied`，清除 pending claim，不创建 logical tab。首版不程序化打开 Popup。Chrome 调试条仍会在首次 attach 时出现；Popup 同意不能代替它，调试条 Cancel 也不能被扩展重新 attach 对抗。

### 8.3 普通命令与取消

```text
Agent BrowserCommand
  → Host 校验 browser/tab/attachment generation 与 session owner
  → 进入该 logical tab 的串行队列
  → 标记 dispatched 前状态，发送 cdp.request
  → 若命令需要子 frame：Host 分配 sessionId，扩展另行 attach({ targetId })
  → Extension 核对 TargetRef → chrome.debugger.sendCommand(tabId 或 targetId)
  → cdp.result / cdp.event → Host compare-and-delete pending → Agent
```

- 同一 tab 的导航、输入、evaluate 和 viewport 修改串行；不同 tab 可并行。
- timeout/cancel 只结束当前请求，不能删除后来的同 key pending entry。普通命令仍使用现有 30 秒 Host 桥预算。`claimTab` 不在这条预算里等人。
- 已 dispatch 的副作用命令超时或断连时返回 `sideEffect:"uncertain"`，不得自动重放。
- `Runtime.evaluate` 取消可尽力发送 `Runtime.terminateExecution`；点击、导航等动作不能伪称已回滚。
- 子 frame 的 `target.detached` 只清理对应 session 映射，不撤销整个 tab lease。

### 8.4 Detach、关闭与重连

```text
chrome.debugger.onDetach / tabs.onRemoved / WebSocket close / Host 退出
  → Extension 或 Main 上报事实
  → Host 使对应 attachment 或整个 backend generation 失效
  → 结束相关 pending，清除 logical binding 与 lease
  → 后续旧引用命令返回 target_unavailable 或 backend_unavailable
```

- `target_closed`：关闭 logical tab，不尝试重建用户页面。
- 用户主动取消调试：撤销 claim，不自动 re-attach。
- WebSocket 关闭时，扩展本地 detach 全部 debuggee：关闭 `tabClass:"agent"` 的标签页，用户标签页只解除调试并留在 Chrome。
- 绑定窗口的 Host 退出而 socket 仍在时，Main 发送 `session.detachAll`，扩展执行同一套本地清理。
- 首版不恢复旧 logical tab。重连后的 backend 使用新 generation；用户页面要重新 `openTabs()` 并授权。
- offscreen document 或 service worker 重启、扩展重载，都按新 connection 处理。
- 用户 tab 上的 JS dialog 由 CDP 拦截。Agent 在命令超时前未处理时，Host 发送 `Page.handleJavaScriptDialog { accept:false }`；仍不能解除页面阻塞时 detach 并撤销 lease。不得默认接受会提交数据的 dialog。
- `finalize`、`closeSession`、撤销配对和窗口转移必须释放相应 debugger。

## 9. BrowserCommand 执行复用

新增 Host 侧 `ExtensionBrowserBackend`，与现有 IAB bridge 通过统一 `list()/execute()` 聚合：

```text
createBrowserControlRouter([
  existingIabBridge,
  extensionBackendRegistry,
])
```

- `list()` 合并真实可用 descriptor，并按 clientMode 过滤首版不支持的手机链路。
- `execute()` 必须按调用方显式 `browserId + browserGeneration` 路由；backend 消失不能改投 IAB。
- `meta.backendType` 使用现有 `extension`，CLI projection 不需要新增平行结果结构。
- 选择规则见第 2 节。实现时要改 `selectBrowserForUrl()`，不能只依赖现有 IAB 优先排序。

P1 先定义无 Electron 依赖的 CDP transport 接口：`send(method, params, target)` 与按 target 分发的事件。IAB adapter 继续把 Host 内部 `sessionId` 传给 Electron debugger；extension adapter 只输出 `tabId` 或 `targetId`。P2 再把 Playwright injected script、locator 和结果归一化接到这个接口。P1 不阻塞在整份 locator 搬迁上，也不复制一套 locator 算法。Host 不依赖 Main 的 `BrowserGuestManager`。

首版能力：

- backend/discovery、tabs.new/list/get/close、user.openTabs/claimTab。
- navigate/back/forward/reload/getState。
- viewport screenshot、domSnapshot、evaluate。
- locator click/fill/press/select/check。
- 不依赖坐标的键盘输入。
- JS dialog 所需事件与处理。
- turnEnded/finalize/closeSession/cancelRequest。

坐标 CUA、`Tab.setViewportSize`、download、file chooser 和用户 tab 的 viewport 仿真返回 `capability_unsupported`。坐标契约单独验收后，也只对 agent-owned tab 打开；用户已打开的 tab 继续拒绝会改变 Chrome 布局或依赖截图像素坐标的命令。

## 10. 跨窗口与远程边界

### 窗口转移

```text
用户选择“转移到当前 Zody 窗口”
  → Main 撤销旧 window binding
  → 旧 Host 使 generation 失效并 settle/cancel pending，含未完成的 claim
  → Extension detach 所有受控 tab，并关闭 agent-owned tab
  → 新窗口 Host 接管 connection，Main 发放新 generation
  → 用户重新授权需要继续控制的已有 tab
```

Main 只序列化连接绑定转移，不继承旧 Host 的 session/tab 业务状态。

### Desktop 与手机

首版只在本地 Desktop 的 `desktop-continuous` discovery 返回 extension backend。浏览器命令仍是 request/response RPC，不进入 Desktop continuous stream 或手机 replay snapshot；因此本方案不修改 stream、snapshot、queue 和重连协议。未来支持手机时，只能复用桌面已有 Host attachment，经独立恢复场景验证后开放，手机不得直连扩展。

## 11. UI 与扩展组成

### Chrome 扩展

- Offscreen document：WebSocket 与重连证明。
- MV3 service worker：原生 tab 操作、debugger 命令和事件。
- Popup：配对、pairingSessionId 核对、连接状态、pending claim 的授权/停止调试、错误提示。
- `chrome.action` badge 显示当前 pending claim，不程序化打开 Popup。
- 不注入常驻 content script，不实现 BrowserCommand 业务队列，不保存 workspace/session。

### Zody

- Settings → Browser：扩展安装入口、bridge port、已配对 Profile、绑定窗口、默认 backend、撤销配对。默认 backend 保存 `browserId`，不保存 backend type。
- 配对确认只出现在发起窗口，并展示扩展 ID、`profileInstanceId` 和 `pairingSessionId`。
- 现有 Browser 设置区复用当前组件与 `IPlatformService`，同时适配桌面和手机 Web 的只读状态展示；手机首版不提供配对操作。
- Agent 操作外部 Chrome 时不伪造 IAB side-pane tab；结果中的截图和 `backendType:"extension"` 沿用现有 conversation 投影。
- 更新 `control-browser` skill：extension 需显式 `browserId`；`authorization_required` 只提示用户并在其确认后重试一次；`permission_denied` 与 `target_unavailable` 不自动重试。用户 tab 使用 locator，不使用坐标 CUA。

建议代码边界（实现时按架构检查调整）：

```text
packages/browser-extension/                    MV3 offscreen、service worker 与 Popup
packages/shared/src/browser-use/              transport schema 与公共契约
packages/desktop/src/main/                    ExtensionBridgeServer（连接/路由/generation）
packages/desktop/src/host/                    ExtensionBrowserBackend（业务 owner）
packages/desktop/src/browser-core/            无 Electron 依赖的 CDP transport 与共用 executor
packages/ui/src/settings/                     配对与 Profile 管理 UI
```

## 12. 验收场景

### 契约与单元测试

1. 所有 transport schema round-trip，拒绝多余字段、未知版本和错误 TargetRef。`cdp.request` 携带 `sessionId` 时校验失败。
2. discovery 只在双向证明完成后出现。重连、撤销、窗口转移和 Host 重启都领取更大的持久 generation，不复用旧整数。
3. 同 session 多 tab、多 session 同 workspace、不同 workspace 的 list/claim/execute 严格隔离。
4. 已知 nativeTabId 不能跨 Profile、跨窗口或跨 session 绕过 claim。窗口内已有 pending claim 时，第二个 claim 失败。
5. `claimTab` 在授权前立即返回 `authorization_required`，不占用 30 秒命令预算。超时后的 Popup 同意不会 attach。
6. pending compare-and-delete；重复 requestId、迟到结果、旧 attachment 或旧 targetId 事件不影响新请求。
7. 每 tab 串行、多 tab 并行；副作用命令 timeout/disconnect 返回 `uncertain` 且不自动重试。
8. attach 失败、DevTools 占用、用户拒绝、target closed、用户 detach、端口冲突均返回规定错误，且同一轮没有自动重试。
9. `getDefault()` 在 IAB 存在且用户未改默认 backend 时仍返回 IAB。`getForUrl()` 即使 extension 有更精确的 URL 也不选它。两个 extension backend 时 `get("extension")` 失败。
10. IAB router/discovery/executor 现有测试保持通过。P1 只要求 transport adapter 不改变 IAB 行为；P2 再证明共用 locator 未改变行为。

### 真实 Chrome E2E

1. 在 headed Chrome 的独立测试 Profile 加载扩展，完成配对和 discovery；测试不得读取开发者日常 Profile。
2. 配对后空闲 2 分钟，不发送 CDP 命令，连接和 attachment 仍然可用，随后 `Runtime.evaluate` 成功。
3. Agent 新建后台 tab，完成 navigate → domSnapshot → locator fill/click → screenshot，验证页面确实变化、Chrome 未抢到前台，且含跨域 iframe 的 locator 打到对应 `targetId`。
4. 用户手工打开已登录 fixture 页面。未经授权时结果只有标题和去掉 query/hash 的 URL；第一次 `claimTab` 立即返回 `authorization_required`；Popup 同意后第二次 claim 才可操作；撤销后立即失效。
5. 两个 session 各控制一个 tab，URL、页面状态、dialog 和结果不串线。用户 tab 的 dialog 超时后页面解除阻塞。
6. 操作中断开 WebSocket、回收 offscreen document、重载扩展、关闭 tab、取消 debugger、结束 Host 进程，验证 pending、错误码、旧 binding、agent tab 被关闭、用户 tab 仍留在 Chrome 且不再处于调试中。
7. 两个 Zody 窗口竞争同一 Profile，只有绑定窗口可用；转移后旧窗口全部失效，agent tab 被关闭。
8. 超过 8 MiB 的帧和超过 4 MiB 的截图/DOM snapshot 失败并释放缓冲，Host 与扩展内存不持续增长。`fullPage` screenshot 返回 `capability_unsupported`。
9. `chrome://`、Chrome Web Store、DevTools 已打开的页面和非法 scheme fail closed，不出现替代控制通道。
10. Desktop local 完整回归 IAB；手机 replay discovery 不包含 extension，现有恢复语义不变。
11. macOS、Windows、Linux 分别验证打包后扩展连接、`127.0.0.1` 端口、进程退出和凭据存储。Windows 需覆盖防火墙提示和禁止用 `localhost` 连到 `::1`。未实机覆盖的平台必须明确记录。

## 13. 分阶段实施

| 阶段                    | 内容                                                                                                                    | 完成标准                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| P0：协议与保活          | Offscreen 连接、高熵配对证明、重连挑战、hello/welcome、单 tab attach、Runtime.evaluate                                  | 空闲 2 分钟后往返仍成功；伪造 Origin、重放 token、端口占用均失败 |
| P1：Backend 骨架        | 持久 generation、router 聚合、选择规则、tabs.new/list/get/close、navigate/getState/viewport screenshot、CDP target 接口 | Agent 创建并控制 Chrome tab；子 target 映射有单测；IAB 回归通过  |
| P2：已有 tab 与 locator | 两阶段 claim、共用 locator、dialog、授权 UI 与 skill                                                                    | 已打开页面授权后可操作；iframe locator、隔离和权限 E2E 通过      |
| P3：完整生命周期        | cancel/timeout、detach/reconnect、Host 退出清理、跨窗口转移、设置页和错误呈现                                           | 生命周期矩阵与三平台验证完成；坐标 CUA 仍保持关闭                |

Console/Network 诊断、原始 CDP 能力、坐标契约、手机远控、录制和下载另行评审，不混入首次落地。
