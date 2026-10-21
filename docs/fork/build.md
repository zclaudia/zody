# Zody 构建与发布

正式规则见 [0.1.0 规格](../../specs/zody-0.1.0-release.md)。Node.js / pnpm 版本由根 `mise.toml` 固定，对外版本由根 `package.json` 提供；内部 Agent workspace 的版本不等于 Zody 发行版本。

## 本地构建

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm test:unit
pnpm --dir apps/zcode-cli test
pnpm bundle:desktop -- --os mac --arch arm64
pnpm build:zody --target darwin-arm64
```

桌面支持 `--os mac|win|linux` 和 `--arch arm64|x64`；首发仅 macOS arm64/x64、Windows x64、Linux x64。CLI 使用 `darwin-arm64`、`darwin-x64`、`win32-x64`、`linux-x64`，`--all` 可构建全部目标，`--skip-build` 复用已有构建及 SEA。跨目标资源必须匹配，原生构建和安装验收优先在目标系统执行。

CLI 默认输出 `dist/zody/releases/<version>/zody-cli-<version>-<target>.tar.gz`，随包包含 Node.js、TUI、Agent、Web、原生工具和许可声明；无需 `ZCODE_DIST_BASE_URL` 或旧 install.sh。桌面 Agent 从本仓库源码构建，不依赖旧 `download-glm.mjs` 或内部下载服务。SSH/WSL 的本地运行时准备遵循 [远端部署说明](../remote/zcode-agent-remote-deployment.md)。

## 构建配置

实际进程环境优先于本地 `.env`/`.env.local`。`.env.example` 仅提供公开的中性示例；凭据和内部地址不得提交。

- 正式候选显式使用 `ZCODE_ENV=production`。
- `ZCODE_DOWNLOAD_PAGE_URL` / `ZCODE_FEEDBACK_ISSUE_URL` 可覆盖下载和问题入口；默认使用 Zody GitHub Releases / Issues。
- 自动更新、ARMS、遥测和打包 Agent OTEL 固定关闭；配置上报 endpoint 或启用自动更新会报错。不要配置 `ZCODE_AUTO_UPDATE` 真值、`ZCODE_ARMS_RUM_ENDPOINT`、`ZCODE_TELEMETRY_REPORT_ENDPOINT` 或 `ZCODE_PACKAGED_AGENT_OTEL_*` 上报值。详见 [可选能力构建护栏](../desktop/build-time-optional-capabilities.md)。
- `ZCODE_DATA_BASE_DIR` 是运行时数据父目录，不是构建资源下载地址。模型和 gateway 由用户运行时配置。

## 许可证门禁

```bash
node scripts/licenses.mjs notices
node scripts/licenses.mjs check
node scripts/licenses.mjs check --strict
```

生成器按当前锁文件、生产依赖图、原生资源及来源材料生成声明。严格检查要求材料无待复核项；不得伪造版权、版本或来源以绕过检查。本地验证归档可包含明确的 `verificationOnly` 标记，不能进入公开 Release；候选汇总和发布 helper 继续要求严格通过。详见 [third-party/README.md](../../third-party/README.md)。

## GitHub Actions

`.github/workflows/zody-release.yml` 在 `v*` tag 上执行版本一致性、检查、桌面/CLI 四目标矩阵及 Android 签名构建。制品以 SHA-256 汇总，创建草稿并标记 Pre-release；已有公开同版本不得覆盖。维护者下载验收后手动公开草稿。提交工作流不等于已运行或发布。

Android 必须配置 GitHub Secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。工作流把 keystore 解码到 runner 临时目录（`$RUNNER_TEMP/zody-release.keystore`），通过 `ZODY_ANDROID_KEYSTORE_FILE`、`ZODY_ANDROID_KEYSTORE_PASSWORD`、`ZODY_ANDROID_KEY_ALIAS`、`ZODY_ANDROID_KEY_PASSWORD` 传给 Gradle；工作流不显式删除该文件，依赖 GitHub 托管 runner 在作业结束后整体销毁。改用自托管 runner 时必须补充显式清理。专用 keystore 的离线备份由维护者持有，密钥及口令不进入源码、日志或制品。

预览版 macOS / Windows 不配置发行者签名。Android 不能使用 debug key 冒充 release key。Windows、Linux、Intel Mac 的安装与 CLI/Web 验收，以及真实 Android/gateway 连通和恢复，需要在相应设备执行并记录。
