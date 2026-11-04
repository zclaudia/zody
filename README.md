# Zody

<div align="center"><img src="public/logo/icons/1024x1024.png" alt="Zody" width="128" height="128" /></div>

简体中文 · [English](README.en.md)

Zody 是从 Z.AI ZCode 分叉并独立维护的 AI 编程工作台，包含 Electron 桌面端、终端 Agent、Web 界面和 Android 手机远控。模型由用户自行配置，手机远控使用用户提供的 gateway；本项目不提供托管模型或 gateway 服务。

`0.1.0` 为首个公开预览版本。桌面端及 CLI/Web 的首发目标为 macOS arm64/x64、Windows x64、Linux x64。macOS / Windows 预览包未签名；Android release APK 使用独立签名密钥。实际发行状态以 [Releases](https://github.com/zclaudia/zody/releases) 为准。

## 使用发行包

从 Releases 下载对应平台的安装包或 `zody-cli-<version>-<target>.tar.gz`，核对 `SHA256SUMS.txt`。CLI/Web 包包含 Node.js 与运行资源，无需另装 Node.js 或 pnpm。解压后运行 `zody/bin/zody`，Windows 使用 `zody\bin\zody.cmd`；也可以把该 `bin` 目录加入 PATH。

```bash
zody --help
zody --version
zody
zody --web --workspace /path/to/project --no-open
```

Web 默认只监听 `127.0.0.1`。非回环监听地址必须启用 token；`--host 0.0.0.0` 默认生成 token，`--token` 可指定 token，不能在此模式下使用 `--no-token`。直接使用 HTTP 服务入口时，通过 `ZODY_SERVER_AUTH_TOKEN` 配置认证。网络部署还需要自行配置 TLS 和访问控制。

升级时手动下载新版；没有自动更新下载或安装。问题请提交至 [Issues](https://github.com/zclaudia/zody/issues)。

## 数据和项目配置

用户级数据写入 `~/.zody/`；设置 `ZODY_DATA_BASE_DIR` 可改变其父目录。Zody 不读取、迁移或自动删除旧 `~/.zcoder/`、`~/.zcode/` 用户数据。

项目同时支持 `.zody/` 和 `.zcode/`：优先使用 `.zody/` 的同名文件或资源，缺失时读取 `.zcode/`，所有修改只写 `.zody/`。配置文件按文件覆盖，技能等目录资源按名称合并，Hook 声明仍需通过原有信任审查。详见 [兼容规则](apps/zody-cli/docs/design/v2/zody-path-compatibility.md)。内部 `@zcode/*` 包名、协议标识及已有 `ZCODE_*` 配置键不做机械替换。

## 源码开发

准备 Git、Node.js **24.14.0**、pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准），在仓库根目录执行：

```bash
pnpm bootstrap
pnpm dev:desktop
# 或 Web 客户端及本地后端
pnpm dev:web
```

Agent 源码在 `apps/zody-cli/`，随仓库提供，不是 Git submodule。依赖由根 workspace 和根 lock 统一安装；`pnpm --dir apps/zody-cli …` 仍限定 CLI 任务入口。

```bash
pnpm --filter @zody/cli... build
pnpm --filter @zody/cli dev --help
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm --dir apps/zody-cli typecheck
pnpm --dir apps/zody-cli lint
pnpm --dir apps/zody-cli test
```

SSH / Windows WSL 工作区纳入 0.1.0。开发前执行 `pnpm bootstrap:with-remote`（已有依赖时可用 `pnpm prepare:remote-assets`）。连接时固定从本机上传运行时；缺件或校验失败直接报错，不访问 CDN。发行包通过 `pnpm --filter @zody/desktop stage:remote-runtime` 校验并暂存当前四平台 manifest 引用的组件归档，打包前再次校验；运行时从随包资源解包到本地缓存后上传。详见 [SSH/WSL 恢复规格](specs/ssh-wsl-local-runtime-restoration.md) 与 [远程部署](docs/remote/zcode-agent-remote-deployment.md)。Browser Use 保留；不可用的系统级 Computer Use 入口隐藏。

## 构建和发布

```bash
# 桌面：支持 --os mac|win|linux 和 --arch arm64|x64
pnpm bundle:desktop -- --os mac --arch arm64
# CLI/Web：单目标或 --all
pnpm build:zody --target darwin-arm64
# 复用已有构建和 SEA 输出
pnpm build:zody --skip-build --target darwin-arm64
```

CLI 产物默认写入 `dist/zody/`。目标名称为 `darwin-arm64`、`darwin-x64`、`win32-x64`、`linux-x64`；运行资源必须与目标匹配。构建环境、许可证门禁和 GitHub Actions 见 [构建说明](docs/fork/build.md)；Android 构建、签名和自配 gateway 见 [Android 远控](docs/mobile-remote-control-android.md)。

版本 tag 触发检查、矩阵构建和草稿 Release，人工验收后再公开为 Pre-release。缺少 Android Secrets 或第三方许可材料时，发布门禁会失败；本地验证包不等于已批准发行。

## 仓库结构

| 目录                                                 | 职责                                 |
| ---------------------------------------------------- | ------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 和打包 |
| `packages/web`、`packages/android`                   | Web 客户端与 Android 远控壳          |
| `packages/server`、`packages/zody-server-cli`       | HTTP/WebSocket 服务和远端运行        |
| `packages/ui`、`packages/services`                   | 共享 UI、状态与业务服务              |
| `packages/shared`、`packages/rpc`、`packages/client` | 协议、类型、RPC 和 Agent SDK         |
| `apps/zody-cli`                                     | Agent CLI、TUI、运行时和工具         |

第一方代码沿用 [Apache-2.0 LICENSE](LICENSE)，保留原作者与第三方版权。参见 [使用与隐私说明](NOTICE.md)、[第三方声明](THIRD-PARTY-NOTICES.md) 和 [首发规格](specs/zody-0.1.0-release.md)。
