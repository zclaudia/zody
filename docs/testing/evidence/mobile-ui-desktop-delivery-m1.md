# 移动端 UI 随桌面交付：M1 集成与阶段门禁证据

日期：2026-11-03

工作区：`.claude/worktrees/agent-a5b773472361b5960`

分支：`m1-t5-integration`

基线：`54a96516`（M1-T1 release 构建、T2 provider、T3 gateway 生命周期、T4 打包与 rootDir helper）。

本文件记录 M1-T5（Main 装配与阶段门禁）实际执行的修改与验证。主线程或其它 agent 已执行的项目单独标注，不写成本 agent 新执行。

## 修改文件

| 文件                                                                | 修改                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/main/index.ts`                                | 仅新增 Remote UI provider 装配：构造 `MobileUiAssetProvider`、按当前 settings 提供纯 HTTP/WS origin、把 handler 交给 `createRemoteGatewayBackend.mobileUiHandler`。 |
| `packages/desktop/test/mobileUiProviderArtifactIntegration.test.ts` | 新增 focused 集成测试：用真实 `dist-mobile-remote` 读取 release/index/内容哈希资源，覆盖路径拒绝与 CSP。                                                            |
| `packages/desktop/test/mobileUiGatewayProxyIntegration.test.ts`     | 新增 env-gated 真实 Gateway 集成测试：经 `/api/proxy/<backendId>` 验证读取、拒绝、path 契约与业务 channel。                                                         |
| `package.json`                                                      | 新增 `test:mobile-web-release` = `node --test scripts/build-mobile-web-release.test.mjs`。                                                                          |
| `docs/testing/evidence/mobile-ui-desktop-delivery-m1.md`            | 本证据文件。                                                                                                                                                        |

## Main 装配接口

```text
settings.remoteAccess.gatewayUrl
        │ tryNormalizeRemoteAccessGatewayUrl（只保留 origin）
        ▼
resolveSecurityContext() ──> MobileUiAssetProvider ──> CSP connect-src
                                      │
resolveMobileWebRootDir()             │ HttpHandler
 dev: packages/web/dist-mobile-remote │
 pkg: process.resourcesPath/mobile-web│
                                      ▼
                     createRemoteGatewayBackend({ mobileUiHandler })
                                      │ connect() 前 sdk.serveHttp(...)
                                      ▼
                     Gateway /api/proxy/<backendId>/...
```

- 根目录：`resolveMobileWebRootDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopPackageRoot: app.getAppPath() })`。开发态解析到 `packages/web/dist-mobile-remote`，打包态只读 `process.resourcesPath/mobile-web`。
- 安全上下文：每次请求重新读取当前 settings 的 `remoteAccess.gatewayUrl`，经 `tryNormalizeRemoteAccessGatewayUrl` 校验后取 `URL.origin`；不回传凭证，CSP 只出现纯 HTTP/WS origin。
- 能力位：存在 provider 时由 M1-T3 的 `resolveGatewayCapabilities(true)` 同时声明 `zcode-remote-control` 与 `zcode-remote-ui-v1`；未提供 provider 时保持原行为。
- 状态边界：Main 只装配只读静态 provider，不保存 task/session、Host attachment、快照或凭证；UI provider 失败不影响普通桌面工作区。

### Gateway path 契约

从本地 `zclaudia-gateway` 源码（`src/server.ts`）确认：

```ts
const fullPath = req.params[0] || "";
const targetPath = `/${fullPath}${queryString}`;
```

`/api/proxy/<backendId>/mobile-ui/release` 传给 SDK `serveHttp` 的 `http_request.path` 是 `/mobile-ui/release`。provider 只接受这个剥离前缀后的路径；真实集成测试断言 SDK 收到的 path 不含 `/api/proxy/` 前缀，并覆盖完整前缀被 404 拒绝的情况。

## 本 agent 实际执行的测试

环境：Node `v24.21.0`（`mise.toml` 固定 24.14.0；本 worktree 使用 fnm 的 24.21.0），pnpm 10.33.2。

| 命令                                                                                                                                                                                            | 真实结果                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build:mobile-web`                                                                                                                                                                     | exit 0；Vite 构建成功，`releaseId=24974b720e2e7efc48a278c9`、`assetDigest=22be01303314620efff9d403ee03d2a5779d1928c8e64d54a1a1ccaae1d90655`、`desktopVersion=0.1.0`。与主线程构建结果一致，验证跨目录确定性。 |
| `pnpm exec vitest run packages/desktop/test/mobileUiProviderArtifactIntegration.test.ts`                                                                                                        | 1 file / 5 tests passed。真实制品 release、index、内容哈希资源、CSP 与路径拒绝通过。                                                                                                                          |
| `ZCODE_GATEWAY_ENV_FILE=<local env> pnpm exec vitest run packages/desktop/test/mobileUiGatewayProxyIntegration.test.ts`                                                                         | 1 file / 2 tests passed。真实 `/api/proxy` 读取 release/index/hash、拒绝路径/POST、业务 `zcode-remote` channel 打开均通过。                                                                                   |
| `pnpm exec vitest run packages/desktop/test/mobileUiProviderArtifactIntegration.test.ts packages/desktop/test/mobileUiAssetProvider.test.ts packages/desktop/test/remoteGatewayBackend.test.ts` | 3 files / 80 tests passed。                                                                                                                                                                                   |
| `pnpm run test:mobile-web-release`                                                                                                                                                              | 13 tests passed, 0 failed。                                                                                                                                                                                   |
| `node --env-file=<local env> node_modules/vitest/vitest.mjs run packages/desktop/test/mobileRemoteGatewayIntegration.test.ts`                                                                   | 对照 T3 真实 Gateway：6 passed, 1 skipped（未设置 `ZCODE_GATEWAY_IT_RESTART_COMMAND`，gateway 重启场景跳过）。业务 hello/bootstrap/replay/多手机/凭证吊销路径无回归。                                         |
| `pnpm typecheck`                                                                                                                                                                                | exit 0。                                                                                                                                                                                                      |
| `pnpm lint`                                                                                                                                                                                     | 0 errors；303 warnings 均为既有告警，改动文件无告警。                                                                                                                                                         |
| `pnpm architecture:check --changed`                                                                                                                                                             | `architecture: OK`；violations 0、baseline 0、new 0。                                                                                                                                                         |

### 真实 Gateway 环境说明

- 复用现有 `zclaudia-gateway-gateway-1` 实例，未重启、未改写配置、未新增签发凭证。
- `/health` 返回 200，`backends=0`、`peers=0`；本地 gateway 源码包版本 `0.1.0`，SDK 为 `@zclaudia/gateway-backend@0.4.0`，协议 v4。T3 对照 suite 通过，说明当前实例与 SDK 协议兼容。
- 首次尝试真实 proxy 时 backend handshake 返回 `AUTH_FAILED/UNAUTHORIZED`。根因不是版本或凭证失效：同一凭证对 `/api/discovery/backends` 返回 200、对 `/api/backend/token` 返回 201；实际凭证 namespace 为 `zcode`，而本地 `.env.gateway.local` 的 `ZCODE_GATEWAY_NAMESPACE` 仍为 `zody`，`peer_hello` 因 namespace 不匹配被拒。测试改用既有 T3 约定 `ZCODE_GATEWAY_IT_NAMESPACE`（默认 `zcode`），未修改产品鉴权。
- 所有输出与提交均未记录 `zgb_`/`zga_`/`zgd_`、管理令牌或 gateway 地址。

### Gateway 响应头边界（M2 必须处理）

真实 `/api/proxy` 响应只保留 `PROXY_RESPONSE_HEADER_ALLOWLIST` 中的头（`content-type`、`content-length`、`cache-control`、`etag` 等）。因此 provider 设置的 `Content-Security-Policy`、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy` 以及 405 的 `Allow` 不会到达客户端：

- provider 单测与真实制品测试确认 provider 自身正确设置这些头（spec 第 5 节）；
- 真实 Gateway 集成测试显式断言当前实例会剥离 CSP/`Allow`，避免误以为端到端已生效；
- M2 必须在 Android `RemoteUiProxy` 原生层补充安全头，或通过入口 HTML 的 CSP meta 交付；不得为此放宽 provider 或 Gateway 鉴权/响应头白名单。

## 未验证项

- Windows / Linux 的 electron-builder 三平台真实打包未执行；仅主线程执行了 macOS arm64 `--dir`。
- Gateway 重启恢复场景未执行（需要显式 `ZCODE_GATEWAY_IT_RESTART_COMMAND`，且不得擅自重启共享实例）。
- Android 真机 WebView、Remote origin 代理、文件/通知等 E2E 属于 M2/M4，未在本任务验证。
- 真实 HTTPS Gateway 与 release 环境未验证；本地实例为明文 `http://127.0.0.1`。
- `packages/web/mobile.html` 仍有内联主题脚本；CSP 未在本任务修改，由 M2-T2 处理。

## 主线程已执行（非本 agent）

以下由主线程报告，本 agent 未重复执行：

- Node 24 下完整 `pnpm --filter @zcode/desktop build:no-runtime-assets` 成功，确认执行 `build:mobile-web`，`releaseId=24974b720e2e7efc48a278c9`。
- Android `testDebugUnitTest` 通过。
- T1 13 个 node tests、T2 44、T3 31 + 关联 58、T4 16、shared 41、入口 54 均复验通过。
- macOS arm64 直接 `electron-builder --dir` exit 0；产物 `packages/desktop/dist/mac-arm64/Zody Preview.app`，`Resources/mobile-web` 含 3887 个文件、0 sourcemap，`index.html`/`release.json` 存在且 releaseId 一致。

## M2 接口清单

1. Remote 页面通过 Gateway 获取：`GET/HEAD /mobile-ui/release`、`GET/HEAD /assets/remote/index.html`、`GET/HEAD /assets/remote/assets/<hash>.<ext>`；其它路径 404，非 GET/HEAD 405。
2. Gateway 传下来的 path 已剥离 `/api/proxy/<backendId>`；原生代理构造请求时不要重复传前缀。
3. 桌面声明 `zcode-remote-ui-v1`；缺少该能力的桌面停留 Shell。
4. release manifest 字段固定为 `schemaVersion/releaseId/desktopVersion/supportedBridgeVersions/entry/assetDigest`，不得新增第二套协议版本来源。
5. 安全头：经 `/api/proxy` 时 provider 的 CSP 与 `Allow` 被 Gateway 剥离；M2 需在 Android 原生代理或 HTML meta 层补齐。
6. 静态资源缓存规则由 provider 决定：release/index `no-store`，内容哈希资源 `immutable`，其它允许资源 `no-cache`；旧 hash 404 不回填。
