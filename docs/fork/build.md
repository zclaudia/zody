# Fork 构建说明：环境变量必填项与禁止项

本文面向在 fork 仓库从零构建（本机或 CI）的开发者：列出打包前必须配置的环境变量，以及 fork 构建中禁止配置的环境变量。fork 构建不依赖任何内网机器与官方基础设施，缺失必填项时构建链会 fail-fast 报错。

对应规划：`specs/fork-official-deps-removal-tasks.md` F1.3（本文）；`ZCODE_DOWNLOAD_PAGE_URL` 由 F2.2 引入；`.env.example` 由 F3.2 统一处理。

## 配置位置与加载顺序

- 在仓库根目录的 `.env` 中配置（不入库）；`.env.local` 也可作为覆盖层。
- 加载入口 `scripts/load-endpoint-env.mjs:8-17`：先读 `.env`，再读 `.env.local`，真实进程环境变量优先级最高。
- Desktop 构建链（`packages/desktop/tsup.config.ts:29-46`）额外读取 `.env.production`（`NODE_ENV=production` 时）或 `.env.development` / `.env.development.local`（否则），进程环境变量同样最高。
- `.env.example` 已由 F3.2 去掉官方地址，只保留中性占位示例；fork 自己的取值写在 `.env` / `.env.local`。

## 必填项

| 变量                      | 消费方                                              | 作用                                                    |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `ZCODE_ENV=production`    | desktop tsup / vite define、shared 运行时           | 按 production 形态构建桌面产物                          |
| `ZCODE_DEPS_BASE_URL`     | `scripts/download-glm.mjs`（desktop `prepare:glm`） | Agent 运行时二进制的 fork 自建下载源                    |
| `ZCODE_DIST_BASE_URL`     | `pnpm build:zcode`（`scripts/build-zcode.mjs`）     | CLI 发行包 `install.sh` 的下载根地址（fork 自有静态源） |
| `ZCODE_DOWNLOAD_PAGE_URL` | 构建期配置（F2.2 引入，尚未落地）                   | 架构不匹配弹框「前往下载」的目标地址                    |

### ZCODE_ENV=production

- 必须显式设置为 `production`。desktop 构建侧的判定方向是「显式 production 才按生产构建」（`packages/desktop/tsup.config.ts:24-26` 的 `resolveZCodeEnv`），未配置时按 `test` 形态打包；shared 运行时侧（`packages/shared/src/zcodeEndpoint.ts:199-202` 的 `resolveRuntimeZCodeEnv`）只有显式 `test` 才走 test。两个方向相反，fork 发行包一律显式写 `ZCODE_ENV=production`，不依赖任一侧的默认值。
- `test` 只用于桌面测试包（见 `packages/shared/src/e2e-test-bridge.ts:8`），fork 发行构建不使用。
- 验证：desktop 构建日志输出 `[tsup] ZCODE_ENV=production ...`（`packages/desktop/tsup.config.ts:73`）。

### ZCODE_DEPS_BASE_URL

- 指向 fork 自建的 Agent 运行时二进制静态源（任意静态文件服务、对象存储或 GitHub Releases），不要配置内网 `INTRANET_MACHINE_HOST` 通道。
- 解析逻辑 `scripts/intranetDefaults.mjs:18-31`：`ZCODE_DEPS_BASE_URL` 缺失且未配置 `INTRANET_MACHINE_HOST` 时抛错 `Configure ZCODE_DEPS_BASE_URL or INTRANET_MACHINE_HOST in .env before downloading internal dependencies`。
- 消费方 `scripts/download-glm.mjs`（desktop 的 `prepare:glm`，打包链 `prepare:runtime-assets` 的一部分）按 `{ZCODE_DEPS_BASE_URL}/zcode-cli-<version>` 下载：
  - `<version>` 取自 `packages/shared/src/zcode-agent-runtime.ts` 的 `version` 字段（脚本 `download-glm.mjs:23-31` 运行时读取），托管源上的目录名必须与它对齐；当前为 `0.13.3`，随 upstream 升级会变化。
  - 产物文件名（`download-glm.mjs` 的 `resolveGlmDownloadName`）：`zcode-<platform>-<arch>`（如 `zcode-darwin-arm64`、`zcode-linux-x64`），Windows 为 `zcode-windows-<arch>.exe`。
- 需要托管的完整文件清单见 F1.1（`specs/fork-official-deps-removal-tasks.md`「F1.1 自建依赖源」）。
- 验证：`pnpm --filter @zcode/desktop prepare:glm` 在只配置 `ZCODE_DEPS_BASE_URL` 的全新克隆上成功。

### ZCODE_DIST_BASE_URL

- `pnpm build:zcode`（`scripts/build-zcode.mjs`）产出 CLI 发行 tarball 与 `install.sh`，本变量是 `install.sh` 内置的默认下载根地址。保持脚本的 fail-fast 设计：缺失时抛错 `Configure ZCODE_DIST_BASE_URL in .env or pass --base-url`（`scripts/build-zcode.mjs:236`），单次构建也可用 `--base-url` 参数临时覆盖。
- 取值为 fork 自有的下载根地址（与 `ZCODE_DEPS_BASE_URL` 可以是同一静态源的根）。
- 验证：`pnpm build:zcode --skip-build`（复用已有构建产物）不报错，且产出的 `install.sh` 指向该地址。

### ZCODE_DOWNLOAD_PAGE_URL（F2.2 合入后生效）

- 规划中的构建期配置：桌面端检测到 CPU 架构与安装包不匹配时，「前往下载」按钮打开本地址。当前代码该按钮仍指向硬编码的 upstream 下载页（`packages/desktop/src/main/desktopArchitectureGuard.ts` 的 `resolveArchitectureDownloadUrl`），本变量在 F2.2（构建配置）合入、F2.5（弹框改读本变量）落地后才生效。
- 规则（F2.2）：必须为合法 https URL（本地 loopback 允许 http）。
- 在 F2.2 合入前，本项无需配置；合入后若不配置，「前往下载」按钮不显示（fail-closed，不回退到 upstream 下载页）。

### ZCODE_FEEDBACK_ISSUE_URL（可选，F2.9 起生效）

- fork 问题反馈地址：反馈中心已本地化（决策门 D7：停用官方工单提交），面板只提供「导出诊断日志」与本地址入口。
- 规则与 `ZCODE_DOWNLOAD_PAGE_URL` 相同：必须为合法 https URL（本地 loopback 允许 http）；未配置时「打开反馈地址」按钮不显示，反馈中心仅剩本地导出日志能力。
- 建议指向 fork 仓库的 Issues 页（如 `https://github.com/<org>/<repo>/issues`）。

## 禁止项（fork 构建不得配置）

以下变量配置后会向构建产物中注入官方上报或自动更新能力，fork 构建一律保持未配置状态。fork 仓库不存在 `config/private/build-defaults.json`（内部仓库文件），因此「不设置环境变量」即为关闭，无其他回落来源。

| 变量                                     | 配置后的效果                           | 关闭（不配置）时的行为                    |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------- |
| `ZCODE_AUTO_UPDATE`                      | 启用桌面自动更新检查与下载             | 不检查、不下载更新                        |
| `ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT`     | 将 OTLP 上报打进打包版 Agent           | Agent 不产生 OTLP 上报                    |
| `ZCODE_PACKAGED_AGENT_OTEL_HEADERS`      | 同上（必须与 ENDPOINT 成对配置）       | 同上                                      |
| `ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME` | 同上（可选，默认 `zcode-cli-agent`）   | 同上                                      |
| `ZCODE_ARMS_RUM_ENDPOINT`                | 启用 ARMS RUM 上报（主进程与渲染进程） | SDK 以 `enable: false` 初始化，不产生上报 |
| `ZCODE_TELEMETRY_REPORT_ENDPOINT`        | 启用遥测事件上报（数仓）               | 遥测事件在发送前直接返回                  |

依据：

- `ZCODE_AUTO_UPDATE`：`scripts/build-time-config.mjs:44-46`，`1`、`true`、`yes` 即启用。fork 采用手动更新（决策门 D1）；F2.2 起构建时配置为真值会直接报错，届时该项从「禁止」升级为「无法配置」。
- `ZCODE_PACKAGED_AGENT_OTEL_*`：`packages/desktop/tsup.config.ts:100-160`，`ENDPOINT` 与 `HEADERS` 成对配置即把 `OTEL_EXPORTER_OTLP_*` 注入打包版 Agent。注意其 release 强校验（`tsup.config.ts:108-114`）只在设置了 GitLab 变量 `CI_COMMIT_TAG` 或 `CI_COMMIT_BRANCH === "release/current"` 时触发，fork 的 CI 不会触发，因此只能靠「不配置」保证关闭。
- `ZCODE_ARMS_RUM_ENDPOINT` / `ZCODE_TELEMETRY_REPORT_ENDPOINT`：`packages/shared/src/env.ts:53-58` 默认空字符串；消费方分别见 `packages/desktop/src/main/appARMSBootstrap.ts:165` 与 `packages/services/src/telemetry/telemetryCore.ts:21`，为空即关闭。
- 三类能力统一由 `scripts/build-time-config.mjs` 解析，优先级为：构建进程环境变量 > `config/private/build-defaults.json`（仅内部仓库存在）> 关闭。完整机制见 `docs/desktop/build-time-optional-capabilities.md`。
- 单测中 `vitest.config.ts:49-52` 固定注入的 `__ZCODE_TELEMETRY_REPORT_ENDPOINT__` 只用于验证上报链路，不影响真实构建产物，不要据此在构建环境配置该变量。

## 快速自检

配置完成后，按顺序确认：

1. `ZCODE_ENV=production` 已写入 `.env`（或导出到构建进程环境）。
2. `pnpm --filter @zcode/desktop prepare:glm` 成功，产物落在 `packages/desktop/bundled-agents/<platform>-<arch>/glm`。
3. `pnpm build:zcode --skip-build` 成功，无 `Configure ZCODE_DIST_BASE_URL` 报错。
4. desktop 打包日志含 `ZCODE_ENV=production`。
5. 环境中无「禁止项」表格中的任何变量（`env | grep -E "ZCODE_(AUTO_UPDATE|PACKAGED_AGENT_OTEL|ARMS_RUM|TELEMETRY_REPORT)"` 应无输出）。

CI 出包流水线将这些检查固化前（F1.4），由构建者按上述步骤人工确认。
