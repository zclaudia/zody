# 移动端主 UI 随桌面交付切换方案

状态：设计已对齐，尚未实施。用户已接受桌面后端离线时无法冷启动主 UI，并接受切换时移动端破坏性升级。

## 1. 目标与边界

### 1.1 目标

- 新版 Android APK 只保留配对、选电脑、设置、错误诊断和启动跳转所需的轻壳。
- 手机主 UI 由当前选中的桌面端提供，桌面升级或回滚后，手机获得与该桌面同版的 UI。
- UI HTML、静态资源和发布清单经现有 Gateway HTTP proxy 获取；task/session 业务继续走现有 `zcode-remote` Channel。
- 纯移动 UI 修改随桌面版本交付，不再要求发布 APK。
- 桌面离线时允许无法冷启动主 UI，但必须保留配对、设置、重试、切换电脑和升级提示。
- 利用破坏性升级删除完整内置主 UI、旧 `ZcodeMobileBridge` 和旧桥兼容分支，不长期维护双栈。

### 1.2 非目标

- 不建立中心 UI/CDN 服务，不保证一次发布立即更新所有手机。
- 不提供桌面离线时的完整主 UI、持久化最近可用 UI 或离线业务缓存。
- 不把 task/session、快照、队列或 attachment 状态搬进 Gateway 或 UI 静态 provider。
- 不把业务 Channel、SSE、文件内容或 RPC 改成 HTTP-over-channel。
- 不要求新桌面继续兼容旧 APK；旧 APK 是否仍能工作只由现有 `appProtocol` 自然决定，不纳入本方案验收。
- 不在本轮实现 Gateway 凭证完全不进入远程页面的 opaque session grant；安全边界如实见第 8 节。

## 2. 破坏性升级约定

- 新 APK 使用新的 shell 配置 schema 和原生桥，首次启动明确提示“此版本需要重新配对”，由用户确认后清理旧配置；不静默删除凭证。
- `applicationId` 和签名身份保持不变，`versionCode` 必须大于当前值 1，`versionName` 继续跟随根版本。
- 新 APK 只选择同时声明远控和 `zcode-remote-ui-v1` 能力的桌面。缺少 UI 能力时停留轻壳并提示升级桌面，不尝试回退完整内置 UI。
- 新版不保留旧 `ZcodeMobileBridge` 别名、旧页面 origin、旧配置读写路径或旧 APK 适配分支。
- 桌面端继续保留现有 `appProtocol` 协商；UI 与桌面同版不等于可以删除 stale run、owner/lease 和协议校验。

## 3. 总体架构与唯一所有者

```text
┌─ Android 单 WebView ────────────────────────────────────────┐
│ Shell origin：https://appassets.androidplatform.net         │
│   APK 轻壳：配对 / 选电脑 / 设置 / 错误 / 重试               │
│                         │ openRemote(backendId)             │
│ Remote origin：https://remote.zody.local                    │
│   桌面移动 UI：首页 / 任务 / 工作区 / 通知 / 文件            │
└──────────────────────────┬──────────────────────────────────┘
                           │ 仅 UI GET/HEAD，经 Android RemoteUiProxy
                           ▼
        Gateway /api/proxy/<backendId>/assets/remote/...
        Gateway /api/proxy/<backendId>/mobile-ui/release
                           │
                           ▼
        桌面 MobileUiAssetProvider（只读、无业务状态）
                           │
        现有 zcode-remote Channel ──→ Host attachment / runtime
```

| 状态或能力 | 唯一所有者 | 规则 |
| --- | --- | --- |
| Gateway、namespace、凭证、选中 backend、按 backend 持久化的 clientInstanceId | Android 原生安全存储 | 只有 Shell 可写；Remote 只读当前会话上下文 |
| 当前 WebView source、选中 backend、导航代次、sessionId | Android `MobileShellController` | 不保存 task/session 业务状态 |
| Shell 页面与 Remote 页面可用的 JS bridge | Android `MobileShellController` | 导航前移除旧 bridge，只安装目标 source 的 bridge |
| 移动 UI 文件、releaseId、Cache-Control、CSP | 桌面 `MobileUiAssetProvider` | 只读当前桌面制品；不读工作区、settings 或 runtime |
| Gateway backend 连接与 `serveHttp` 注册 | 桌面 `RemoteGatewayBackend` | `connect()` 前注册；配置换代时随 SDK 生命周期释放 |
| 业务协议、attachment、task/session、快照与恢复 | 现有 Channel、Host、runtime | 不经过 UI provider，不改变现有所有者 |
| UI 发布轮询与安全刷新 | Remote Web `MobileUiReleaseController` | 只查询发布清单与页面刷新阻塞项，不复制业务状态 |
| 未提交草稿、pending optimistic overlay、文件操作 | 当前 Remote 页面既有 UI 状态 | 通过 refresh guard 查询，不在发布控制器另存副本 |
| 通知 pending click/action | Android 现有通知 pending 槽 | Remote ready 后才派发；失败或未确认不 ack |
| 原生文件选择、拍照、权限请求 | Android Activity/Compose | 刷新和切换代次时由原生侧 veto 或取消 |

Main 只负责装配 `MobileUiAssetProvider` 和 Gateway 转发，不承载 task/session 业务状态。Desktop 与 Web 的平台差异继续通过 `IPlatformService` 注入；Android 页面不得直接调用未封装的 `window.*`。

## 4. 构建与制品

### 4.1 两份独立 Web 制品

1. **Shell 制品**
   - 新入口 `packages/web/mobile-shell.html` 与 `packages/web/src/mobile-shell/main.tsx`。
   - 只包含配对、Gateway 设置、backend discovery、选电脑、错误与升级提示。
   - 输出 `packages/web/dist-mobile-shell`，APK 同步到 `app/src/main/assets/shell/`。

2. **Remote 制品**
   - 沿用 `packages/web/mobile.html`、`src/mobile-remote/main.tsx` 和 `dist-mobile-remote`。
   - 移除配对和全局连接配置写入路径；需要修改连接或切换电脑时返回 Shell。
   - 输出包含 `index.html`、全部静态资源和 `release.json`，不包含 sourcemap。

普通 Web 客户端继续独立构建，不引入 Gateway mobile SDK；现有 bundle isolation 检查同步覆盖 Shell/Remote 两份产物。

### 4.2 确定性发布标识

构建 Remote 制品后生成：

```json
{
  "schemaVersion": 1,
  "releaseId": "<24 位小写十六进制>",
  "desktopVersion": "<根 package.json version>",
  "supportedBridgeVersions": [1],
  "entry": "/assets/remote/index.html",
  "assetDigest": "<全部文件的相对路径与字节内容摘要>"
}
```

- `releaseId` 由格式版本、`desktopVersion` 和 `assetDigest` 计算；不得使用 mtime、构建机器路径或随机值。
- 同一输入在任何桌面平台产生相同 `releaseId`。
- 构建脚本把同一个 `releaseId` 写入 HTML meta；HTML、manifest 和资源必须来自同一次构建。
- `appProtocol` 的唯一所有者仍是 `packages/shared/src/web-remote-control*`；manifest 不另建业务协议版本来源。
- `packages/shared` 新增严格 schema 和公开类型，用于桌面、Remote Web 校验和测试。

### 4.3 桌面打包

- 桌面生产构建新增 `build:mobile-web` 前置步骤，构建完成后再装配发行资源。
- `electron-builder.config.js` 通过 `extraResources` 把 `packages/web/dist-mobile-remote` 复制到 `resources/mobile-web/`，排除 `**/*.map`。
- 开发态 provider 读取 `packages/web/dist-mobile-remote`；打包态只读 `process.resourcesPath/mobile-web`。
- Android Gradle 删除完整 `dist-mobile-remote → assets/remote` 链路，改为 `dist-mobile-shell → assets/shell`。
- 三平台打包验收确认 `index.html`、`release.json` 和引用资源齐全；APK 不再包含完整 Remote 制品。

## 5. 桌面只读 HTTP 接口

`RemoteGatewayBackend` 在每次 `connect()` 前调用当前 SDK 的 `serveHttp(handler)`，并把请求转交 `MobileUiAssetProvider`。SDK 抽象、fake 和生命周期测试同步增加该接口。

只允许：

| 方法与路径 | 响应 | 缓存 |
| --- | --- | --- |
| `GET/HEAD /mobile-ui/release` | 当前 `release.json` | `no-store` |
| `GET/HEAD /assets/remote/index.html` | 当前入口 HTML | `no-store` |
| `GET/HEAD /assets/remote/assets/<Vite 内容哈希文件>` | JS/CSS 等内容哈希资源 | `public, max-age=31536000, immutable` |
| `GET/HEAD /assets/remote/<其它允许资源>` | 字体、图片、PDF 辅助资源等 | `no-cache` |
| 其它路径或方法 | 404/405，不写缓存 | `no-store` |

规则：

- URL 解码和规范化后再次检查路径包含性；拒绝 `//`、反斜杠、NUL、`..` 逃逸、符号链接和目录读取。
- 只允许 GET/HEAD；body 必须为空。响应大小设上限，文件读取使用异步 IO。
- 旧内容哈希 URL 不存在时返回 404，**不得把当前版本文件回填到旧 URL**，避免新旧 JS 混用。
- 错误、429、5xx 不缓存；不重定向到外部 origin。
- 响应剥离 hop-by-hop 与 `Set-Cookie`，设置正确 MIME、安全头和 CSP。
- 不暴露 `/api`、工作区文件、桌面 settings、凭证、runtime snapshot 或任意绝对路径。
- handler 在 Gateway backend 能力中同时声明 `zcode-remote-control` 与 `zcode-remote-ui-v1`。

## 6. Android 双源与原生代理

### 6.1 两个可信 origin

- Shell：`https://appassets.androidplatform.net/assets/shell/index.html`，由 `WebViewAssetLoader` 提供。
- Remote：`https://remote.zody.local/assets/remote/index.html`，该域名只是应用内固定 origin，不做 DNS 或公网加载。
- Gateway 的 CORS/WebSocket Origin 配置包含这两个精确 origin；release 仍只允许 HTTPS Gateway，Debug 明文规则不变。
- 主框架离开上述 allowlist 时交给系统浏览器；其它 scheme 不打开。两个页面均禁止第三方 iframe。

### 6.2 `RemoteUiProxy`

- 只代理 Remote origin 下第 5 节允许的 GET/HEAD；其它请求返回本地错误或交给现有网络路径，不能形成通用代理。
- 原生侧从当前会话上下文读取 Gateway、backendId 和凭证，构造 `/api/proxy/<backendId><path>` 并注入 Bearer。
- 只转发必要请求头；剥离响应中的 cookie 和 hop-by-hop 头。
- M1 真实 Gateway 验证确认：Gateway 的响应头 allowlist 只保留 `content-type`、`content-length`、`cache-control`、`etag` 等，provider 设置的 CSP、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy` 和 405 `Allow` 不会到达手机。`RemoteUiProxy` 必须在交给 WebView 前按本 spec 的同一安全策略补齐这些头；不得依赖 provider 响应头直接透传，也不得为省事放宽 Gateway 鉴权或响应头白名单。
- Android 的 CSP 生成与桌面 provider 是同一产品契约的两个平台实现：固定指令与当前 Gateway origin 必须由契约测试覆盖，后续修改必须同步，不能各自漂移为不同的安全策略。
- Android `shouldInterceptRequest` 的平台 API 是同步的，网络等待只能发生在 WebView interceptor worker，严禁转到 UI 线程执行；设置连接/读取超时和响应大小上限。
- UI HTML 和发布清单可以整包缓冲；业务 WSS/fetch、文件流和任务事件不经过此拦截器，因此不引入 zcharlie 的 body 头桥或 SSE-over-scheme 兜底。
- 每个响应携带创建时的 navigation generation；backend 切换、返回 Shell 或 Activity 销毁后，旧 generation 的迟到响应不得成为新文档内容。

### 6.3 缓存

- v1 只实现进程内有界 LRU，不实现持久化完整 UI。
- key 包含 Gateway origin、backendId、规范化路径和查询；不得跨 backend 命中。
- 仅缓存明确 `immutable` 的 GET 200；`no-store/no-cache/private`、错误和重定向不进入长期缓存。
- 建议初始上限 128 条、总字节数有界；超限按 LRU 回收，不能简单全清造成请求尖峰。
- HTML 和 release 每次联网获取；缓存失败不得阻止返回 Shell。
- 不引入 Service Worker，避免固定 origin 下跨 backend 的缓存所有权失控。

## 7. 原生桥拆分与 stale 防护

破坏性升级后使用两个互斥 bridge，不保留旧 `ZcodeMobileBridge`：

### `ZodyShellBridge`

- 读取、写入、清除连接配置；配置写入递增 `configRevision`。
- 按 backend 生成并持久化 `clientInstanceId`；同一手机重连同一 backend 必须复用，换 backend 必须不同。Remote 只读该值，不得再经 SecureStore 自行生成或写入。
- 打开指定 backend：`openRemote(backendId, expectedConfigRevision)`。
- 获取 Shell 构建信息、Debug 传输能力和连接诊断。
- 不暴露 Remote 文件、通知动作或业务能力。

### `ZodyRemoteBridge`

- `getSessionContext()`：返回当前 `sessionId`、Gateway、namespace、backendId、按 backend 持久化的 clientInstanceId、凭证、appVersion 和 bridge capabilities。
- 文件保存/打开、通知、前后台事件、返回 Shell。
- 除只读会话上下文外，所有会改变原生或远端状态的调用都带 `sessionId`；native 检查当前代次，旧 sessionId 一律拒绝。
- 不提供任意 key 的安全存储读写，不允许修改 Gateway 或选中 backend。

切换 source 前先移除旧 bridge，再递增 generation、使旧 sessionId 失效，最后安装新 bridge 并导航。CSP 禁止第三方 frame，降低 `addJavascriptInterface` 向所有 frame 注入带来的暴露面。

Bridge v1 能力声明：

```json
{
  "schemaVersion": 1,
  "bridgeVersion": 1,
  "appVersion": "<APK versionName>",
  "capabilities": ["session-context", "file-save", "file-open", "notifications", "lifecycle"]
}
```

未来新增原生能力只做 additive capability 扩展；改变既有命令语义时提高 `bridgeVersion` 和桌面 manifest 的最低支持要求，仍需发布 APK。

## 8. 凭证与远程页面威胁模型

- v1 业务仍使用现有 Web Gateway client 的 WSS/fetch，因此 Remote 页面会获得当前设备凭证；**不得宣称凭证完全不进入页面**。
- 凭证只从 `getSessionContext()` 读取，不写 localStorage、URL、日志、遥测或 Web 普通 Store。
- **仅限浏览器开发模式**：没有原生桥时，由 development-only 会话适配器模拟 `ZodyRemoteBridge`，消费 Shell 的开发 handoff/config 并生成合法 sessionId、returnShell 和 capabilities。该适配器及其 URL/localStorage 降级不得进入 release 产物；开发 `clientInstanceId` 的唯一生成/持久化所有者仍是 Shell 的开发 config client，Remote 不另建写入路径。
- Remote 页面由用户选中的桌面提供，属于新增可信代码来源；桌面、桌面发行制品和 Gateway 静态代理都在信任边界内。
- Remote CSP 至少禁止第三方脚本、`object`、frame 和非预期 base；`connect-src` 只包含 Remote origin、当前配置 Gateway 的 HTTP/WS origin 及现有功能必需的 scheme。
- Shell bridge 与 Remote bridge 互斥，Remote 不能修改配置，外部导航不获得任何 bridge。
- 文件打开继续只允许本应用 FileProvider/MediaStore 生成的 URI；通知和文件操作校验 sessionId。
- 若未来要求远程 XSS 也无法读取长期凭证，应另行设计短期、单 backend 的 opaque grant 和原生网络传输，不在本轮通过增加零散过滤分支实现。

## 9. 关键事件顺序

### 9.1 冷启动与打开主 UI

```text
Activity → ShellController：创建 generation=1
Activity → WebView：只安装 ShellBridge，加载 Shell
Shell → 原生配置：读取配置与选中 backend
Shell → Gateway：discovery/registry，检查 zcode-remote-ui-v1
用户 → Shell：选择 backend
Shell → ShellController：openRemote(backendId, configRevision)
ShellController：校验 revision，移除 ShellBridge，generation=2，创建 sessionId
ShellController → WebView：安装 RemoteBridge，加载 Remote origin
RemoteUiProxy → Gateway → Desktop：GET release + index + assets
Remote → RemoteBridge：读取 sessionContext / bridgeCapabilities
Remote → ReleaseController：校验 manifest 支持 bridgeVersion=1
Remote → Desktop：现有 hello / hello_ack / appProtocol 协商
Remote → Android：标记 remote ready，再派发 pending notification intent
```

旧桌面没有 UI capability、资源加载失败或 bridge 不兼容时均不得启动业务 Channel；返回 Shell 显示对应升级或网络错误。

### 9.2 切换电脑或返回设置

```text
Remote → RemoteBridge：returnShell(reason, sessionId)
ShellController：验证 sessionId
ShellController：移除 RemoteBridge，generation += 1，旧 session 失效
ShellController → Remote transport：页面卸载并 dispose 现有 Channel
ShellController → WebView：安装 ShellBridge，加载 Shell
迟到的旧 HTTP 响应 / 文件动作 / 通知动作：generation 或 sessionId 不符，丢弃
```

不得新建 Agent、Local Host 或远程会话；只释放手机侧 transport，桌面已有 Host attachment 继续由原所有者处理。

### 9.3 桌面升级与安全刷新

```text
Remote → GET /mobile-ui/release：前台 60s 轮询；回前台/网络恢复/重连立即检查
Desktop → Remote：新 releaseId，supportedBridgeVersions 含 1
Remote：同一 releaseId 间隔至少 5s 再确认
Remote → refresh guards：查询草稿、pending overlay、文件操作、弹层和原生操作
所有 guard 通过 → 刷新前再次 GET release → window.location.reload()
任一 guard 阻塞 → 保留当前文档，显示“新版已就绪”及原因
刷新失败/断网/429/5xx → 保留当前文档，不循环刷新
```

- 后台不自动刷新；同一标签页一分钟最多自动刷新一次。
- 手动“安全刷新”使用同一组 guard，不绕过未提交工作。
- 正在运行的后台任务由桌面 runtime 持有；只有在 `web-remote-replayable` 恢复验收通过后才允许刷新，不得复制或重跑任务。
- pending optimistic overlay、未提交草稿、未保存设置、文件写入、系统文件选择/拍照/权限弹窗必须阻止刷新。
- 原生侧在 reload 前检查文件选择、拍照和权限请求；进行中则 veto。
- 现有 `beforeunload` dispose 继续释放手机 transport；不得因 reload 重起 Agent。

### 9.4 通知深链

```text
通知点击 → Android pending 槽（持久化，未 ack）
Cold start → Shell → 选中 backend → Remote ready
Android → Remote：按 backendId + notificationId 派发
Remote → Host：沿 workspaceIdentity + remoteSessionId 恢复目标
成功确认 → Android ack 并清理 pending 槽
加载失败 / backend 不符 / stale generation → 保留 pending，不 ack
```

## 10. 失败与恢复规则

| 场景 | 行为 |
| --- | --- |
| 未配对或配置损坏 | 打开 Shell 配对；不加载 Remote |
| 桌面离线或 Gateway 不可达 | Shell 显示重试、设置和切换电脑；无完整主 UI |
| 桌面无 `zcode-remote-ui-v1` | 提示升级桌面，不发起 Remote 导航 |
| release 不支持当前 bridge | 提示升级 APK，不启动业务 Channel |
| HTML/资源加载失败 | 首次加载返回 Shell；已打开文档的发布检查失败则保留文档 |
| 旧 hash 资源 404 | 记录可诊断错误并触发安全刷新，不返回新文件冒充旧资源 |
| backend 切换时在途响应 | generation 不符，丢弃 |
| Remote 进程/页面崩溃 | 回 Shell，提供重试；桌面 runtime 不由手机重建 |
| 桌面更新导致 Channel 断开 | 沿用现有恢复语义，随后检查 release；不另建恢复队列 |

## 11. 实施顺序

每一步先更新对应测试和接口，再实现；不保留长期双栈，但按垂直切片验收。

### M1：制品与桌面 provider

- 新增 Remote release 构建脚本、shared schema、确定性摘要和 HTML meta。
- 把 Remote 制品纳入桌面三平台打包。
- 实现 `MobileUiAssetProvider`、`serveHttp` 注册、capability 和路径/缓存/CSP 测试。
- 用真实 Gateway 验证只能读取 UI 路径，业务 Channel 回归不受影响。

### M2：Shell/Remote 拆分与 Android 双源

- 拆出 Shell 入口，Remote 改为只读 session context。
- Android 实现 `MobileShellController`、双 bridge、`RemoteUiProxy`、generation/sessionId 和进程内有界缓存。
- Gradle 改为只打包 Shell，完成新 `versionCode` 和重新配对流程。
- 验证冷启动、桌面不支持、离线错误、切换电脑和 stale 响应。

### M3：发布检测与安全刷新

- 实现 `MobileUiReleaseController`、严格 manifest 校验和刷新 guard 注册接口。
- 接入 composer、pending optimistic overlay、设置草稿、文件操作、弹层和原生 veto。
- 复用并验证 `web-remote-replayable` 恢复，不以刷新重建 runtime。
- 验证桌面升级/回滚、断网保留文档、刷新限频和 bridge 不兼容。

### M4：文件、通知与清理

- 验证 Remote origin 下文件选择、拍照、保存、打开和通知深链。
- 删除完整 Remote assets、旧桥、旧配置迁移和内置主 UI 相关代码、测试与文档引用。
- 更新 `mobile-remote-control-via-gateway.md`、`zody-android-and-http-release.md`、部署/CORS/发布文档和架构模块说明。
- 执行全量要求检查并记录真实结果。

## 12. 验收场景

### 构建与接口

1. 同一 Remote 输入重复构建得到相同 releaseId；任一 HTML/JS/CSS/模板字节变化都会改变 releaseId。
2. Windows、macOS、Linux 桌面包均包含完整 Remote 制品且无 sourcemap；APK 只含 Shell。
3. `serveHttp` 在 connect 前注册；config 重连后旧 handler 不接收新请求。
4. GET/HEAD 正常；POST、路径逃逸、符号链接、任意 API/文件路径和超限响应均被拒绝。
5. 当前 hash 缓存 immutable；旧 hash 404 且绝不回当前文件；release/HTML/no-cache 资源按规则重取。

### 冷启动与切换

6. 新 APK + 新桌面可完成配对、选电脑、Remote 加载和现有 hello/appProtocol/业务恢复。
7. 新 APK + 旧桌面停留 Shell，明确提示升级桌面，无白屏和无限重试。
8. 桌面离线时无法冷启动主 UI，但配对、设置、重试、切换电脑和错误诊断可用。
9. backend 切换、快速来回导航和在途响应不会覆盖新页面；旧 sessionId 的文件/通知调用被拒绝。
10. Activity 重建和进程死亡后从原生配置恢复；在线则重新加载 Remote，离线则回 Shell。

### 更新与数据保护

11. 桌面升级/回滚产生新 releaseId；二次确认前不刷新，manifest 异常时保留当前文档。
12. 未发送 composer 草稿、pending optimistic overlay、未保存设置、文件操作和系统弹窗均阻止自动及手动安全刷新。
13. 后台运行任务刷新后按 replayable 语义恢复，不重复 admission、不新建 Agent、不丢失 owner/lease。
14. 一分钟内无 reload 循环；后台不刷新，回前台和网络恢复会重新检查。
15. bridge 不兼容时只提示升级 APK，不启动业务连接。

### 安全与平台能力

16. Shell/Remote bridge 互斥；Remote 无法写连接配置，外部导航和 iframe 无 bridge。
17. 凭证不出现在 URL、日志、遥测、localStorage 或普通 Web Store；release 明文 HTTP 仍 fail closed。
18. Remote 下文件选择、拍照、分块保存、取消、打开文件和孤儿保存会话回收保持现有行为。
19. 通知冷启动深链只在正确 backend + Remote ready 后派发；失败不 ack，stale intent 不进入新会话。
20. 两种流式语义均回归：Desktop continuous 与手机 web-remote-replayable 不因 UI 代理改变。
21. 常规二次进入命中 immutable 缓存；不同 backend 不共享缓存，默认 Gateway 限流下无静态请求风暴。

### 工程门禁

- 行为实施时执行并如实记录目标包测试、Android JVM/相关真机 E2E、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 交互变化具备真实 E2E；浏览器模拟不能替代 Android WebView、Gateway 和桌面包验收。
- 未执行、签名受限或平台未覆盖的项目必须明确列为未验证，不写成通过。
