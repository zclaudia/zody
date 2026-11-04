# Android 远程控制壳

`packages/android` 是 Zody 手机远控的 Android 壳。壳不重写 Agent 或 RPC 协议，它只做三件事：
加载随 APK 内置的轻 Shell、提供少量原生能力（安全存储、前后台、返回键），以及维持一个不携带
URL 的前台保活服务。Shell 负责配对、选电脑、设置和错误提示；手机主 UI 由当前选中的桌面经
Gateway 提供。架构见[手机远控架构](./web-remote-control/web-remote-control-architecture.md)和
[移动端主 UI 随桌面交付切换方案](../specs/mobile-remote-ui-desktop-delivery.md)。

## 页面来源与入口

新版 APK 只内置轻 Shell，不再包含完整 Remote 主 UI：

- **Shell**：`https://appassets.androidplatform.net/assets/shell/index.html`，由
  `WebViewAssetLoader` 提供。只包含配对、Gateway 设置、backend discovery、选电脑、错误/升级
  提示和 `openRemote` 跳转。
- **Remote**：`https://remote.zody.local/assets/remote/index.html`。该域名只是应用内固定
  origin，不做 DNS 或公网加载；HTML、静态资源和 `release.json` 只经 `RemoteUiProxy` 从当前
  桌面的 Gateway `/api/proxy/<backendId>/...` 读取，业务仍走 `zcode-remote` Channel。
- Gradle 构建时执行根目录 `pnpm build:mobile-shell`，再把 `packages/web/dist-mobile-shell/`
  同步到 `app/src/main/assets/shell/`。任务定义见
  `packages/android/app/build.gradle.kts` 的 `buildMobileShell`、`syncMobileShellAssets` 与
  `clearLegacyRemoteAssets`，挂在 `preBuild` 上；旧 `assets/remote/` 会在构建时删除。
  - 生成目录由 `.gitignore` 排除，不提交构建产物。
  - 可用 `-PmobileShellPnpm=<path>` 覆盖 pnpm 可执行文件。
- `WebViewAssetLoader` 只服务 `/assets/` 路径。主框架导航离开上述两个 allowlist origin 时交给
  系统浏览器（只放行 http/https）；其它 scheme 不打开，两个页面均禁止第三方 iframe。
- Debug 构建允许明文 HTTP（`usesCleartextTraffic=true`），方便真机连本地 gateway；release
  构建只允许 HTTPS。WebView 远程调试只在 debug 构建开启。

### 构建命令

```bash
# 只构建轻 Shell（产物在 packages/web/dist-mobile-shell）
pnpm build:mobile-shell

# 构建桌面交付的 Remote 制品（产物在 packages/web/dist-mobile-remote，随桌面打包）
pnpm build:mobile-web

# 构建 debug APK（Gradle 会自动执行 build:mobile-shell 并同步 assets）
cd packages/android
./gradlew assembleDebug

# release APK：先配置下述专用签名环境变量
./gradlew assembleRelease
```

构建机需要 Node、pnpm 和 Android SDK。Shell 随 APK 升级，Remote 主 UI 与桌面同版：桌面升级
或回滚后手机获得对应版本的 UI。两端仍通过 `hello`/`hello_ack` 的 `protocolVersion`、
`appProtocol` 和 UI release manifest 的 `bridgeVersion` 协商；同版不代表可以删除 stale run、
owner/lease 或协议校验。桌面离线时手机停留在 Shell，不能冷启动主 UI。

## 窗口与系统栏安全区

- Activity 开启 `enableEdgeToEdge()`，窗口铺满整屏；系统栏 insets 的唯一所有者是壳：
  `RemoteControlApp` 给 WebView 套 `safeDrawing`（排除 IME）的 `windowInsetsPadding`，
  页面始终布局在状态栏与手势条之间的安全区内。
- 页面不感知安全区，不消费 `env(safe-area-inset-*)`：Android WebView 对该 CSS 变量的支持
  （尤其底部手势条）不可靠，安全区不能由页面自处理。`mobile.html` 的 `viewport-fit=cover`
  只服务浏览器开发模式。
- 排除 IME 是有意的：键盘弹出时保持 WebView 默认的软键盘行为，不引入第二条 resize 路径。
- 状态栏/手势条区域透出 Compose `Surface` 背景（跟随系统深浅色），加载进度条仍叠加在
  安全区顶部。

## 原生桥（ZodyShellBridge / ZodyRemoteBridge）

新旧页面不再共用单个桥：`MobileShellController` 在导航前移除旧 bridge，只安装目标 source 的
bridge。旧 `ZcodeMobileBridge` 不再注入：

- **Shell**：`ZodyShellBridge` 读写连接配置、递增 `configRevision`、按 backendId 生成并持久化
  `clientInstanceId`、执行 `openRemote(backendId, expectedConfigRevision)`，并提供构建信息和
  诊断；不暴露文件、通知、业务或通用安全存储能力。
- **Remote**：`ZodyRemoteBridge` 提供只读 `getSessionContext()`（sessionId、Gateway、namespace、
  backendId、clientInstanceId、凭证、appVersion 和 bridge capabilities），以及文件、通知、
  前后台、返回 Shell 和安全刷新 veto。除只读会话上下文外，所有状态变更都携带 `sessionId`；
  旧代次返回稳定 `stale-session`。
- **安全存储**：`EncryptedSharedPreferencesSecureStore` 用 Android Keystore 的 AES256-GCM 主密钥
  加 `EncryptedSharedPreferences`（AES256-SIV 加密 key、AES256-GCM 加密 value）。写入用
  `commit()`，方法返回时已经落盘；`allowBackup=false`，凭证不进入系统备份。配置和凭证的唯一
  页面写入方是 Shell 的 `ZodyShellBridge`。
- **release 不降级**：页面只有在浏览器开发模式才允许 `localStorage`；新版 Remote 没有
  SecureStore 写入路径，release 产物不含降级实现。
- **前后台/返回键**：宿主 → 页面事件由 `MobileBridgeEventDispatcher` 调用页面安装的
  `ZcodeMobileBridgeHost`（事件宿主对象名，不是旧注入桥）。页面据此 `suspend`/
  `recoverInBackground`；返回键先询问 `onBackPressed()`，未消费时回退 WebView 历史，没有历史
  则退出 App。权限弹窗、配置变更不会触发 `ON_STOP`。

### 保活服务

`RemoteControlKeepAliveService` 是 `foregroundServiceType="dataSync"` 的前台服务，只表达
「有一个活动会话」：不再接收远端 URL，通知点击固定回到 `MainActivity`。Android 13 及以上在
首次启动时申请 `POST_NOTIFICATIONS`。前台服务只降低进程被回收的概率，真正的断线恢复仍由页面的
replayable snapshot 协议完成。

### 权限

manifest 只保留网络、保活和拍照所需权限，不申请存储权限：

```text
INTERNET
ACCESS_NETWORK_STATE
CAMERA（拍照附件，按需申请）
FOREGROUND_SERVICE
FOREGROUND_SERVICE_DATA_SYNC
POST_NOTIFICATIONS
```

### 文件能力

- **选择附件**：`WebChromeClient.onShowFileChooser` 把 accept 类型映射为
  `ACTION_OPEN_DOCUMENT`（支持多选）；图片场景先弹「拍照 / 选择文件」，拍照用
  `ACTION_IMAGE_CAPTURE` 加 `FileProvider` 临时文件（authority `${applicationId}.fileprovider`，
  路径声明在 `res/xml/file_paths.xml`）。`CAMERA` 权限按需申请，拒绝后回退到系统文件选择器。
  选中的文件仍由 composer 走现有的远端附件字节上传链路；单个附件 16 MiB 上限由
  `maxAttachmentBytes` 在发送前提示。
- **保存与打开**：页面侧由 `packages/web/src/mobile-remote/mobileRemoteFileBridge.ts` 实现
  `IPlatformService.saveFile`（每 256 KiB base64 分块）并调用桥的
  `saveFileBegin/Append/Finish/Abort`，写入 `DownloadsFileWriter`：
  Android 10 及以上用 MediaStore 写公共「下载」目录（无需存储权限），Android 9 及以下写到
  应用专属下载目录。完成后 `openFile(uri, mimeType)` 用 `AndroidMobileFileOpener` 交给
  `ACTION_VIEW`，只接受 MediaStore 或本应用 FileProvider 的 content URI。页面同时提供
  `maxAttachmentBytes = 16 MiB`，composer 在选择附件时提前拒绝超限文件。
- **WebView 下载**：`DownloadListener` 交给 `MobileDownloadHandler`，与页面 `saveFile` 共用同一套
  保存/打开路径；`blob:` URL 只存在于渲染进程，原生读不到，会记录警告。

### 身份与 release 签名

显示名为 `Zody`，applicationId / namespace 为 `io.github.zclaudia.zody.mobile`。versionName 读取仓库根 `package.json`，破坏性升级后 versionCode 为 `2`（必须大于旧版 `1`）。首次启动检测到旧配置 schema 时不静默删除凭证；应用提示“此版本需要重新配对”，用户确认后才清理旧配置。

release 构建要求四个环境变量：`ZODY_ANDROID_KEYSTORE_FILE`、`ZODY_ANDROID_KEYSTORE_PASSWORD`、`ZODY_ANDROID_KEY_ALIAS`、`ZODY_ANDROID_KEY_PASSWORD`。文件必须存在；缺失配置会在 release 编译前失败，不回退 debug key。debug 构建不需要这些变量。

使用专用 release keystore，并离线备份 keystore、alias 与恢复口令；后续 APK 更新必须使用相同签名。CI Secrets 的对应关系见 [构建与发布](fork/build.md)。验证产物可使用 Android SDK 的 `apksigner verify --verbose --print-certs <apk>`；公开前还需真机安装与升级验证。

Zody 不提供托管 gateway，下面的服务器和凭据由用户自行部署、提供和配置。

## 部署与运维

以下指南用于在自有服务器上部署 zclaudia-gateway（Gateway Protocol v4），并给桌面和手机签发凭证。
gateway 源码位于 <https://github.com/zclaudia/zclaudia-gateway>，下面的命令在其检出目录中执行。

### 1. 部署 gateway

```bash
git clone https://github.com/zclaudia/zclaudia-gateway.git
cd zclaudia-gateway
cp .env.example .env
# 必填：编辑 .env，设置 GATEWAY_ADMIN_TOKEN（签发凭证的信任根）
docker compose up -d
```

`docker-compose.yml` 的关键约定：

- `GATEWAY_ADMIN_TOKEN` 必须设置，否则容器拒绝启动；
- 端口默认只绑定 `127.0.0.1:${GATEWAY_PORT:-3200}`，不要把 `GATEWAY_BIND` 改成 `0.0.0.0`
  暴露到公网；
- 数据卷 `gateway-data` 挂到容器 `/data`，SQLite（凭证和 backend 身份）在其中；
- `GATEWAY_TRUST_PROXY` 默认 `false`，只有在可信反代之后才设为 `true`。

### 2. TLS 与反代

在 gateway 前面放一层 Caddy 终止 TLS。下面的 Caddyfile 会自动申请证书、支持 WebSocket 升级
（`/ws` 与 `/channel/*` 都由 `reverse_proxy` 透传），并关闭响应缓冲：

```caddyfile
gateway.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3200 {
        # 关闭缓冲：channel 帧和控制消息必须及时下发
        flush_interval -1
    }
}
```

同时把 gateway 的 `.env` 改成：

```dotenv
GATEWAY_TRUST_PROXY=true
```

否则所有客户端在 gateway 看来都共用反代 IP，会撞上「每 IP 10 条 WS 连接、每分钟 10 次认证失败」
的限额。桌面设置页里的 gateway 地址填写 `https://gateway.example.com`（不要带尾部斜杠）。
release 构建要求 HTTPS；只有本地开发允许 `http://127.0.0.1:3200`。

### 3. CORS

手机有两个应用内 origin：

- Shell：`https://appassets.androidplatform.net`
- Remote：`https://remote.zody.local`

如果设置了 `GATEWAY_ALLOWED_ORIGINS`，必须同时包含两者，否则 Shell 的 discovery/registry 或
Remote 的 WSS/fetch 会被拦截：

```dotenv
GATEWAY_ALLOWED_ORIGINS=https://appassets.androidplatform.net,https://remote.zody.local
```

不设置时 gateway 使用通配符，跨域请求仍可工作。浏览器开发模式（`http://localhost:5173`）如果
也设置了 allowlist，需要把该 origin 一并加入。

### 4. 签发与吊销凭证

用 `/admin` 管理控制台（`https://gateway.example.com/admin`）或仓库脚本：

```bash
cd zclaudia-gateway  # 上一步的检出目录
export GATEWAY_URL=https://gateway.example.com
export GATEWAY_ADMIN_TOKEN=...

# 每台电脑一张 backend 凭证（namespace 与桌面设置页一致，默认 zody）
./scripts/gateway-admin.sh issue-backend zody my-desktop

# 每部手机一张 device 凭证；默认 180 天，可限定只能访问哪些 backend
./scripts/gateway-admin.sh issue-device zody my-phone 180 <backend-id,...>

# 查看与吊销（吊销立即生效：在线连接被 close 1008 断开，后续认证回 401）
./scripts/gateway-admin.sh list
./scripts/gateway-admin.sh revoke <credential-id>
```

- 凭证只在签发时显示一次，立即保存；不要写进日志、截图或仓库。
- `issue-device` 的末位参数是设备可访问的 backend 范围，省略表示整个 namespace。
- backend 凭证填桌面设置页；device 凭证填手机 Shell 配对页。手机只在 registry 显示电脑在线且
  同时具备 `zcode-remote-control` 与 `zcode-remote-ui-v1` 能力位（协议常量，不随品牌改名）时
  才允许 `openRemote`；缺少 UI 能力时停留在 Shell 并提示升级桌面。

### 5. 排障

| 现象                                   | 排查                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 桌面状态 `replaced`                    | 同一张 `zgb_` 凭证被两个进程同时使用；关掉多余实例或重新签发                                           |
| 手机 `gateway-credential-invalid`      | 凭证过期（设备凭证默认 180 天）或已被吊销；用 `list` 确认后重新签发                                    |
| 电脑显示离线                           | 检查桌面远程访问开关、gateway 地址和 namespace；再看 gateway 的 `[audit]` 日志和容器健康检查 `/health` |
| 手机连上后很快断开                     | 确认 `GATEWAY_TRUST_PROXY=true` 且反代正确传递客户端 IP；检查是否触发每 IP 连接数/认证失败限额         |
| 浏览器开发模式 `discoverBackends` 失败 | 检查 `GATEWAY_ALLOWED_ORIGINS` 是否包含 `http://localhost:5173`；确认地址协议与 TLS 匹配               |

### 6. 已知约束

- gateway 是单实例：重启后所有连接和 channel 丢失，桌面与手机会自动重连；SQLite 只持久化凭证和
  backend 身份，不保存任务队列或快照。
- 桌面与 gateway 之间只允许一张 backend 凭证在线；同一凭证在第二个进程登录会把前一个顶掉。
- Shell 随 APK 升级，Remote 主 UI 随桌面升级；桌面离线、无 `zcode-remote-ui-v1` 或 release 与
  bridge 不兼容时，手机停留在 Shell 并提示重试、切换电脑或升级对应一端。APK 不提供桌面离线时
  的完整主 UI、持久化最近可用 UI 或离线业务缓存。
- 本方案不保证新桌面兼容旧 APK；旧 APK 是否仍可工作只由现有 `appProtocol` 自然决定，不纳入
  新 APK 验收。

## 本地开发

```bash
# 起本地 gateway 并签发凭证（默认使用与本仓库同级的 ../zclaudia-gateway 检出，
# 可用 ZCLAUDIA_GATEWAY_DIR 覆盖；凭证 namespace 默认 zody）
pnpm dev:gateway

# 桌面 dev 进程 + Shell/Vite dev server（http://localhost:5173/mobile-shell.html）
pnpm dev:mobile-remote
```

浏览器开发模式从 `mobile-shell.html` 开始，在 Shell 配对页填写本地 gateway 地址、namespace 和
`zgd_` 凭证；`openRemote` 后开发 handoff 会进入 `mobile.html`，其中凭证不进入 URL。需要单独
核对产物时，`pnpm build:mobile-shell` 生成 APK 内置 Shell，`pnpm build:mobile-web` 生成桌面
Remote 制品。真机调试时把 debug APK 连到同一局域网的 gateway 地址（debug 构建允许 HTTP）。
