# M1：制品与桌面 provider

目标：冻结 Remote UI 发布契约，完成确定性制品、桌面只读 provider、Gateway `serveHttp` 生命周期和三平台打包配置。此阶段不修改 Android 运行方式，现有 APK 继续加载完整内置 UI。

前置：spec 第 4、5、11 M1、12 节；M1-T1 完成前不得并行启动其它任务。

## M1-T1：冻结 release 契约并生成确定性 Remote 制品

前置：无。

独占写文件：

- `packages/shared/src/mobile-ui-release.ts`、必要的 shared 公开入口与对应测试。
- `packages/shared/src/remoteAccess.ts` 中新增 UI capability 常量及对应测试；不改现有设置 schema。
- `scripts/build-mobile-web-release.mjs` 及 focused 测试。
- `scripts/check-mobile-web-bundle-isolation.mjs` 的入口文件名兼容。
- `packages/android/app/build.gradle.kts` 中 `index.html` 的同步与存在性检查；不改变 Android 页面加载方式。
- `packages/web/vite.config.ts`、`packages/web/mobile.html` 中 release 注入所需最小改动。
- 根 `package.json` 的 `build:mobile-web` 脚本。
- 不提交 `packages/web/dist-mobile-remote` 生成物。

实施：

1. 按 spec 定义 `MobileUiReleaseManifest` 的 TypeScript 类型、严格运行时 schema 和 `WEB_REMOTE_CONTROL_UI_BACKEND_CAPABILITY = "zcode-remote-ui-v1"`。
2. 实现路径与字节内容摘要；排除 sourcemap、临时文件和机器相关元数据，统一 `/` 路径分隔符。
3. 构建后将 `mobile.html` 规范化为 `index.html`，写入 `release.json`，并向 HTML 注入同一 `releaseId` meta。
4. 保持 Remote base 为 `/assets/remote/`；普通 Web 构建入口和行为不变。
5. isolation 检查和 Android Gradle 同步统一读取规范化后的 `index.html`，不保留 `mobile.html` 副本，不改变 APK 当前加载内置页面的运行方式。
6. 验证同一输入重复构建摘要一致，任一字节变化会改变摘要；HTML、manifest、资源缺失时 fail closed。

测试：

- manifest 缺字段、额外字段、非法 releaseId、空 supportedBridgeVersions 均拒绝。
- 路径排序、不同 mtime、不同构建目录不影响摘要；内容变化影响摘要。
- HTML meta 与 `release.json` 一致，重复注入不产生多个基线。
- 普通 Web 与 mobile bundle isolation 检查继续通过。

交接：公开类型/schema、capability 常量、构建命令、产物布局和真实测试输出。下游任务以此契约为准，不再另创 manifest 字段。

## M1-T2：实现桌面 MobileUiAssetProvider

前置：M1-T1。

独占写文件：

- `packages/desktop/src/main/remote-access/mobileUiAssetProvider.ts`。
- 可新增同目录 `mobileUiAssetProvider*.ts` 辅助模块及 focused 测试。
- 不修改 `remoteGatewayBackend*`、`main/index.ts` 或打包配置。

实施：

1. 提供 `createMobileUiAssetProvider({ rootDir, resolveSecurityContext, ... })`，返回符合 Gateway `HttpHandler` 的异步 handler。
2. 只支持 spec 第 5 节路径和 GET/HEAD；实现 MIME、HEAD 空 body、响应大小上限和异步文件读取。
3. 路径先解码再规范化并复查包含性；拒绝 `//`、反斜杠、NUL、`..` 逃逸、目录、符号链接和隐藏写入入口。
4. 当前 Vite 内容哈希资源返回 immutable；HTML/release no-store；其它允许资源 no-cache；旧 hash 缺失返回 404，不回填当前文件。
5. 错误、429、5xx、重定向不可缓存；剥离 cookie 与 hop-by-hop 响应头。
6. CSP 禁止第三方脚本/object/frame 和非预期 base；connect 来源由 `resolveSecurityContext()` 提供当前 Gateway HTTP/WS origin，不读或返回凭证。
7. provider 不 import Host、runtime、Repo、Service 具体实现，不保存 task/session 状态。

测试：

- 覆盖 spec 第 12 节构建与接口第 3～5 项。
- 覆盖 query 处理、重复解码、编码斜杠、Windows 路径分隔符、符号链接、超大文件和文件读取失败。
- 确认旧 hash 不会得到当前内容，CSP 不包含凭证或任意通配脚本源。

交接：handler 签名、rootDir/securityContext 注入方式、异常映射和测试证据。

## M1-T3：把 serveHttp 接入 RemoteGatewayBackend 生命周期

前置：M1-T1。

独占写文件：

- `packages/desktop/src/main/remote-access/remoteGatewayBackend.ts`。
- `remoteGatewayBackendTypes.ts`、`remoteGatewayBackendSupport.ts`。
- 上述模块的直接测试和 fake SDK；不改 `main/index.ts`、device transport 或 provider 文件。

实施：

1. 在 SDK 抽象中加入 `serveHttp(handler)` 和 backend options 的 UI capability；依赖中接受可选 `mobileUiHandler`。
2. 每次 active SDK `connect()` 前同步注册 handler；channel handler 的既有注册顺序不得改变。
3. config 重连、测试连接、dispose、REPLACED 和异常重连时，旧 SDK/handler 不得继续响应新代次请求。
4. 未配置 provider 时保持当前行为，不注册空通用代理；provider 异常由 M1-T2 映射为有界响应。
5. 不改 `zcode-remote` Channel、hello、appProtocol、通知和 Host attachment。

测试：

- connect 前注册顺序；多次 reload 不重复注册到当前 SDK。
- stale SDK、测试连接和 dispose 的生命周期；无 provider 时现有测试全部保持语义。
- registry 同时包含远控和 UI capability；原 capability 不删除。

交接：依赖注入字段、SDK fake 变化、生命周期测试证据。

## M1-T4：把 Remote 制品纳入桌面生产构建和发行资源

前置：M1-T1。

独占写文件：

- `packages/desktop/package.json`。
- `packages/desktop/scripts/run-production-build.mjs` 及 focused 测试。
- `packages/desktop/electron-builder.config.js` 与打包配置 focused 测试。
- 可新增 `packages/desktop/scripts/mobile-web-assets.mjs` 专用于路径/完整性校验。
- 不修改根 `package.json`、web Vite 配置或 Main 装配点。

实施：

1. 在桌面生产 bundle 前调用 M1-T1 的构建入口，避免与并行 tsup/Vite 产生写入竞争。
2. 通过 `extraResources` 将 `../web/dist-mobile-remote` 映射到 `resources/mobile-web`，排除 `**/*.map`。
3. 提供开发态 `packages/web/dist-mobile-remote` 与打包态 `process.resourcesPath/mobile-web` 的根路径解析函数。
4. 打包前验证 `index.html`、`release.json` 和入口引用资源存在；缺失时 fail closed。
5. 不把 Android `assets/remote` 加入桌面包，不改变其它 runtime resources。

测试：

- 构建顺序、Windows 路径、资源映射、sourcemap 排除和缺失制品失败。
- 检查现有 asar repack/签名流程不会把 Remote 制品误当 JS 主进程代码。
- 当前平台可执行时做一次真实打包检查；其它平台标为未验证。

交接：rootDir 解析函数、打包产物位置、真实/未执行的平台验证。

## M1-T5：Main 装配、真实链路集成与阶段门禁

前置：M1-T2、M1-T3、M1-T4 全部交接。

独占写文件：

- `packages/desktop/src/main/index.ts` 的 Remote UI provider 装配段。
- 可新增 M1 集成测试和 `scripts/` 下单一用途验证脚本。
- `docs/testing/evidence/mobile-ui-desktop-delivery-m1.md`。
- 经主 agent 授权后，可修正 M1 各模块的集成缺陷；不再并行修改其它任务文件。

实施：

1. 用 M1-T4 rootDir 和 M1-T2 provider 构造 M1-T3 `mobileUiHandler`；安全上下文只暴露 Gateway origin，不暴露凭证。
2. 经真实 Gateway `/api/proxy/<backendId>` 请求 release、HTML、hash 资源和拒绝路径；记录状态、缓存头、CSP 与响应摘要，不记录凭证。
3. 验证业务 Channel hello/bootstrap/恢复路径与 M1 前一致，UI provider 失败不影响普通桌面工作区。
4. 检查开发态 rootDir；打包态在可用平台验证资源完整性。
5. 运行 focused 测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实记录已有失败和环境限制。

Gate 证据：

- 真实 Gateway 请求结果与路径拒绝证据。
- 重复构建 releaseId 一致、内容变化后改变的证据。
- 业务 Channel 回归结果。
- 修改文件清单、测试命令、未验证平台及后续 M2 必须遵守的接口清单。
