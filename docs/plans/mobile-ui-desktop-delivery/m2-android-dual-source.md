# M2：Shell/Remote 拆分与 Android 双源

目标：新版 APK 只包含轻 Shell；Remote 主 UI 由 M1 桌面 provider 加载。实现双 origin、双 bridge、原生只读代理、进程内缓存和破坏性升级。

前置：Gate M1 已通过；spec 第 2、3、6、7、8、9.1、9.2、10、11 M2 节。M2-T1 契约交接前不得启动下游。

## M2-T1：拆分 Shell Web 入口并冻结桥契约

前置：Gate M1。

独占写文件：

- `packages/shared/src/mobile-ui-bridge.ts`、公开入口和 focused 测试。
- `packages/web/mobile-shell.html`、`packages/web/src/mobile-shell/**`。
- `packages/web/src/mobile-remote/mobileRemoteSetup.tsx`、`mobileRemoteSettingsDraft.ts`、`mobileRemoteConfigStore.ts`、`gatewayBootstrapConfig.ts`、`mobileRemoteBackendDiscovery.ts` 的 Shell 归属调整。
- `packages/web/vite.config.ts`、根 `package.json` 的 Shell 构建脚本。
- Shell focused 测试；不修改 Android 或 `mobile-remote/bootstrap.tsx`。

实施：

1. 按 spec 定义 `MobileShellConfig`、`MobileSessionContext`、`MobileBridgeCapabilities`、`configRevision` 和稳定错误码的公开类型/schema。
2. Shell 只承载配对、Gateway 设置、discovery、选电脑、错误/升级提示和 `openRemote(backendId, expectedConfigRevision)`。
3. 把全局连接配置写入集中在 Shell；Remote 不再拥有设置写路径。
4. Shell 检查 `zcode-remote-control` 与 `zcode-remote-ui-v1`；缺 UI capability 时提示升级桌面，不调用 openRemote。
5. 新增 `build:mobile-shell` 和独立 `dist-mobile-shell`；Remote `build:mobile-web` 产物契约保持 M1 不变。
6. 复用现有组件、主题、国际化和移动安全区，不重写一套视觉系统。

测试：

- 配置 schema、session context、bridge capabilities 严格校验。
- discovery 支持/离线/不支持 UI 的选择规则；配置 revision 过期不导航。
- Shell 产物不含 Remote 主工作台；普通 Web 与 Remote 隔离检查不受影响。

交接：TS 契约、Shell bridge 调用面、Shell 产物路径和 Android 需要实现的 JSON 字段。

## M2-T2：Remote Web 改为只读 session context

前置：M2-T1。

独占写文件：

- `packages/web/src/mobile-remote/bootstrap.tsx` 及未分配给 M2-T1 的 `mobile-remote/*`。
- `packages/web/src/webPlatformService.ts` 中 Remote bridge 注入段。
- Remote focused 测试；不修改 Vite 配置、Shell 文件或 Android。

实施：

1. Remote 启动只从 `ZodyRemoteBridge.getSessionContext()` 获取当前会话；校验 M2-T1 schema。
2. 凭证仅保存在当前 bootstrap 内存并交给现有 Gateway client，不写 URL、日志、遥测、localStorage 或普通 Store。
3. 所有文件、通知和 lifecycle 平台适配器携带 sessionId；旧 sessionId 错误映射为 stale-session 终态，不自动写新配置。
4. 修改连接、重新配对和切换电脑统一调用 `returnShell(reason, sessionId)`，删除 Remote 的设置保存入口。
5. manifest/bridge 不兼容时在启动业务 Channel 前显示升级 APK；release 监控由 M3 实现，本任务只保留启动校验。
6. 保持现有 `appProtocol`、web-remote-replayable、pending optimistic overlay 和通知 pending 语义。

测试：

- 无效 context、缺失 bridge、stale session、backend 不匹配均 fail closed。
- 凭证不进入 Web Storage/URL/日志；Remote 无配置写入路径。
- 现有 mobile bootstrap、聊天恢复和文件/通知适配器 focused 测试按新桥更新。

交接：Remote 对 Android 的完整调用面、页面 ready 时序、stale 处理和测试证据。

## M2-T3：Android 配置 schema、破坏性升级与 Shell 制品打包

前置：M2-T1。

独占写文件：

- `packages/android/app/build.gradle.kts`。
- `packages/android/app/src/main/java/io/github/zclaudia/zody/mobile/bridge/SecureKeyValueStore.kt`。
- 新增 `.../config/` 下配置 store/schema/revision 实现和测试。
- `packages/android/app/src/main/res/values*/strings.xml` 的重新配对文案。
- `ApplicationIdentityTest.kt` 与构建 focused 测试；不修改 MainActivity、RemoteControlApp 或旧桥文件。

实施：

1. 原生配置 store 成为 Gateway、namespace、凭证、选中 backend 和 configRevision 的唯一持久所有者。
2. 提供“检测旧 schema → 返回需要重新配对 → 用户确认后清除”的原子接口；不得在构造 store 时静默删凭证。
3. `versionCode` 大于 1，`versionName` 和签名规则保持现有发布约定。
4. Gradle 改为构建/同步 `dist-mobile-shell → assets/shell`，不再执行完整 Remote 同步；删除生成目录旧 Remote 残留。
5. 保持 Debug 明文和 Release HTTPS、签名验证、通知权限 manifest 规则。

测试：

- 旧配置只检测不删除，确认后一次清理，重复启动幂等；revision 单调递增。
- 并发写入串行化，损坏配置 fail closed；凭证不写日志。
- APK 只包含 Shell 资源，`versionCode` 升级和 release 签名校验有效。

交接：配置 store API、Shell assets 路径、重配对状态和测试证据。

## M2-T4：实现 RemoteUiProxy 与有界缓存纯模块

前置：M2-T1。

独占写文件：

- 新增 `packages/android/app/src/main/java/io/github/zclaudia/zody/mobile/remoteui/` 下 proxy、cache、models 和错误映射。
- 对应 `app/src/test/.../remoteui/` focused 测试。
- 不修改 Gradle、MainActivity、RemoteControlApp、bridge 或通知模块。

实施：

1. 定义纯数据 `RemoteUiSessionContext`，由后续 controller 填充，不在本模块读取 Android Store。
2. 只接受固定 Remote origin 和 spec 允许的 GET/HEAD；映射到 `/api/proxy/<backendId><path>`，原生注入 Bearer。
3. 使用平台 HTTP client 在 WebView interceptor worker 执行，设置连接/读取超时、响应大小上限；禁止 UI 线程调用。
4. 请求/响应头白名单、cookie/hop-by-hop 清理、无外部重定向、HTML/错误有界缓冲。
5. 进程内 LRU key 包含 Gateway origin、backendId、路径和 query；只缓存 immutable GET 200，按条数和总字节回收。
6. 每次调用接收 generation，返回时标记该 generation；controller 负责最终丢弃，不在 cache 内创建业务状态。

测试：

- 路径逃逸、方法、凭证注入、响应头、超时、大小限制、缓存 TTL/容量/LRU/backend 隔离。
- no-store/no-cache/private、错误、重定向不缓存；HEAD 不写错误缓存。
- 用本地 fake server，不访问真实服务、不记录真实凭证。

交接：proxy/cache API、线程约束、错误模型、测试证据。

## M2-T5：MobileShellController、双 bridge 与 WebView 集成

前置：M2-T3、M2-T4；可同时读取 M2-T2 最新契约，最终集成需等其交接。

独占写文件：

- `packages/android/app/src/main/java/io/github/zclaudia/zody/mobile/MainActivity.kt`。
- `.../ui/RemoteControlApp.kt`，可新增 `.../ui/shell/` controller/navigation 模块。
- `.../bridge/ZcodeMobileBridge.kt` 的删除替代、新 `ZodyShellBridge`/`ZodyRemoteBridge` 及直接测试。
- 现有 bridge 测试的新桥适配；不修改 M2-T3 store、M2-T4 remoteui 或 Web 文件。

实施：

1. controller 串行管理 Shell/Remote source、generation、sessionId、configRevision 和当前 backend，不保存业务状态。
2. 导航前移除旧 bridge、使旧 session 失效，再安装目标 bridge；Shell/Remote origin 和外部导航严格分流。
3. ShellBridge 实现配置读写、打开 Remote、诊断；RemoteBridge 实现只读 context、文件/通知/lifecycle/returnShell。
4. 文件、通知等状态变更调用校验 sessionId；沿用现有 FileProvider/MediaStore URI 限制和通知 pending 槽。
5. 接入 M2-T4 proxy/cache，旧 generation 响应不得进入新文档；加载失败回 Shell。
6. 首次启动呈现重新配对确认，确认后调用 M2-T3 清理接口；Activity 重建按持久配置恢复。
7. 保持保活服务、系统栏、文件选择、拍照和通知权限生命周期，不新增业务兜底分支。

测试：

- 双 bridge 互斥、外部导航无桥、stale session/generation、快速切换、Activity 重建。
- Remote ready 前不派发通知 intent；旧桌面和 bridge 不兼容不启动 Channel。
- 更新 Android JVM 测试，真实 WebView 行为留给 M2-T6，不以 mock 替代。

交接：完整导航时序、controller API、原生测试结果和 E2E 环境要求。

## M2-T6：端到端集成、破坏性升级验收与 Gate M2

前置：M2-T2、M2-T5 全部交接。

独占写文件：

- M2 集成/E2E 脚本和 `docs/testing/evidence/mobile-ui-desktop-delivery-m2.md`。
- 经主 agent 授权可修复 M2 模块集成缺陷，不再并行修改其它任务文件。

实施与验收：

1. 新 APK + 新桌面完成重新配对、discovery、Remote 加载和现有业务恢复。
2. 新 APK + 旧桌面停留 Shell；离线桌面保留设置/重试/切换电脑，无白屏和无限重试。
3. 验证路径拒绝、旧 hash 404、CORS、Release HTTPS、凭证不进日志/Web Storage。
4. 快速切换电脑和导航，确认旧 HTTP 响应、文件/通知 sessionId 不污染新会话。
5. 验证进程死亡、Activity 重建、通知冷启动深链和 Remote 失败回 Shell。
6. 检查 APK 不含完整 Remote，桌面包包含 Remote；记录包体变化但不把目录大小等同 APK 压缩收益。
7. 执行 Android focused、真实 Gateway/WebView E2E、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，记录未覆盖平台。

Gate 证据：真实设备/模拟器记录、失败与恢复矩阵、测试命令、未验证项和 M3 可依赖的 ready/reload/session 契约。
