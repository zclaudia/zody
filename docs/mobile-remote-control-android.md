# Android 远程控制壳

`packages/android` 是 ZCode 手机远控的 Android 壳。壳不重写 Agent 或 RPC 协议，它只做三件事：
加载随 APK 内置的手机页面、提供少量原生能力（安全存储、前后台、返回键），以及维持一个不携带
URL 的前台保活服务。页面自身通过 zclaudia-gateway 连接桌面，架构见
[手机远控架构](./web-remote-control/web-remote-control-architecture.md)。

## 页面来源与入口

- 壳内没有远端页面地址，也没有二维码扫描、deep link 或最近链接列表。启动后只加载内置页面：
  `https://appassets.androidplatform.net/assets/remote/index.html`。
- Gradle 构建时先执行根目录的 `pnpm build:mobile-web`，再把 `packages/web/dist-mobile-remote/`
  同步到 `app/src/main/assets/remote/`，并把 `mobile.html` 重命名为 `index.html`。
  - 任务定义见 `packages/android/app/build.gradle.kts` 的 `buildMobileWeb` 与
    `syncMobileWebAssets`，两者挂在 `preBuild` 上。
  - 生成目录由 `.gitignore` 排除，不提交构建产物。
  - 可用 `-PmobileWebPnpm=<path>` 覆盖 pnpm 可执行文件。
- `WebViewAssetLoader` 只服务 `/assets/` 路径。主框架导航如果离开
  `appassets.androidplatform.net/assets/remote/`，会交给系统浏览器（只放行 http/https），
  WebView 不再加载其它页面；注入的原生桥因此不会暴露给远端页面。
- Debug 构建允许明文 HTTP（`usesCleartextTraffic=true`），方便真机连本地 gateway；release
  构建只允许 HTTPS。WebView 远程调试只在 debug 构建开启。

### 构建命令

```bash
# 只构建内置页面（产物在 packages/web/dist-mobile-remote）
pnpm build:mobile-web

# 构建 debug APK（Gradle 会自动执行上面的 pnpm 任务并同步 assets）
cd packages/android
./gradlew assembleDebug

# release APK
./gradlew assembleRelease
```

构建机需要 Node、pnpm 和 Android SDK。APK 内置页面与桌面版本不再配套，升级任一端都要靠
`hello`/`hello_ack` 的 `protocolVersion` 与 `appProtocol` 协商（见架构文档）。

## 原生桥（ZcodeMobileBridge）

`WebView.addJavascriptInterface(..., "ZcodeMobileBridge")` 注入，方法名是平铺的
`secureStoreGet/secureStoreSet/secureStoreRemove`；页面侧
`packages/web/src/mobile-remote/mobileRemoteSecureStore.ts` 把它们归一化成
`secureStore.get/set/remove`，其余代码只依赖 `IPlatformService.secureStore`。

- **安全存储**：`EncryptedSharedPreferencesSecureStore` 用 Android Keystore 的 AES256-GCM 主密钥
  加 `EncryptedSharedPreferences`（AES256-SIV 加密 key、AES256-GCM 加密 value）。写入用
  `commit()`，方法返回时已经落盘；`allowBackup=false`，凭证不进入系统备份。
- **release 不降级**：页面只有在浏览器开发模式才允许 `localStorage`；release 构建缺少原生桥时
  保存凭证直接失败，`localStorage` 代码不会进入生产产物。
- **前后台**：Activity 的 `ON_START`/`ON_STOP` 通过 `MobileBridgeEventDispatcher` 调用页面的
  `ZcodeMobileBridgeHost.onAppLifecycle("foreground"|"background")`，页面据此
  `suspend`/`recoverInBackground`。权限弹窗、配置变更不会触发 `ON_STOP`。
- **返回键**：`BackHandler` 先询问页面 `onBackPressed()`；页面未消费时回退 WebView 历史，没有
  历史则退出 App。

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

### 当前限制

- `applicationId`、`namespace` 和 Java 包路径仍是模板值 `com.example.zcode_mobile`，品牌信息待
  方案「待决事项 1」确定后再替换。

## 部署与运维

以下指南用于在自有服务器上部署 zclaudia-gateway（Gateway Protocol v4），并给桌面和手机签发凭证。
仓库地址示例为 `~/SourceCode/zclaudia-gateway`，以实际检出为准。

### 1. 部署 gateway

```bash
cd ~/SourceCode/zclaudia-gateway
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

手机页面来自 APK 内置 origin `https://appassets.androidplatform.net`。如果设置了
`GATEWAY_ALLOWED_ORIGINS`，必须包含它：

```dotenv
GATEWAY_ALLOWED_ORIGINS=https://appassets.androidplatform.net
```

不设置时 gateway 使用通配符，跨域请求仍可工作。浏览器开发模式（`http://localhost:5173`）如果
也设置了 allowlist，需要把该 origin 一并加入。

### 4. 签发与吊销凭证

用 `/admin` 管理控制台（`https://gateway.example.com/admin`）或仓库脚本：

```bash
cd ~/SourceCode/zclaudia-gateway
export GATEWAY_URL=https://gateway.example.com
export GATEWAY_ADMIN_TOKEN=...

# 每台电脑一张 backend 凭证（namespace 约定为 zcode）
./scripts/gateway-admin.sh issue-backend zcode my-desktop

# 每部手机一张 device 凭证；默认 180 天，可限定只能访问哪些 backend
./scripts/gateway-admin.sh issue-device zcode my-phone 180 <backend-id,...>

# 查看与吊销（吊销立即生效：在线连接被 close 1008 断开，后续认证回 401）
./scripts/gateway-admin.sh list
./scripts/gateway-admin.sh revoke <credential-id>
```

- 凭证只在签发时显示一次，立即保存；不要写进日志、截图或仓库。
- `issue-device` 的末位参数是设备可访问的 backend 范围，省略表示整个 namespace。
- backend 凭证填桌面设置页；device 凭证填手机设置页。手机只在 registry 显示电脑在线且具备
  `zcode-remote-control` 能力位时才允许连接。

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
- 手机页面与桌面各自升级：用旧版 APK 连接新版桌面时，按 `appProtocol` 协商结果提示升级手机或
  电脑端。

## 本地开发

```bash
# 起本地 gateway 并签发凭证（默认 ../zclaudia-gateway 的 docker-compose）
pnpm dev:gateway

# 桌面 dev 进程 + 手机页面 Vite dev server（http://localhost:5173/mobile.html）
pnpm dev:mobile-remote
```

浏览器开发模式在手机设置页填写本地 gateway 地址、namespace 和 `zgd_` 凭证即可；真机调试时
把 debug APK 连到同一局域网的 gateway 地址（debug 构建允许 HTTP）。
