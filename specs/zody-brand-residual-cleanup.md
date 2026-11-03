# Zody 品牌与内部标识改名规格

状态：全面分叉目标已确认，实施与验证尚未完成。本文替代首发规格中不要求重命名内部标识的旧原则；历史首发材料只记录当时决定，不再约束本次改名。

内部 workspace 包名、源码路径、TypeScript 标识、stdio、RPC、主桥、header 和内部 URI 按清单全面改为 Zody。非插件 `ZCODE_*` 环境变量与构建 define 硬切到 `ZODY_*`；旧 artifact 不迁移，遥测断代，远端全量重部署且禁止新旧混布。具体门禁与验收见 [运行时契约](zody-rename-runtime-contract.md) 和 [契约映射](../docs/plans/zody-rename-execution/contract-map.md)。

## 明确保留与限期兼容

- `zcode-sandbox://` 和 `persist:plugin-sandbox-v2-*` 是永久 origin 与存储例外。
- `.zcode-plugin/plugin.json` 和登记的插件旧接口仅在 1.0 前兼容；1.0 前一个 minor 发警告，退役与历史结果分别验收。
- 官方插件市场 id `zcode-plugins-official` 与插件 id `zcode-guide` 保留；上游作者署名 `Z.ai` 保留。
- 项目级 `.zcode/` 只读兼容见路径契约；Android 原生安全存储文件名 `zcode_mobile_secure_store` 保留已有凭据。
- CUA 信任根 `io.github.zclaudia.zody.cua-helper`、证书 leaf/DR 和 Node CDHash 保持不变。历史文档、第三方来源与清单中的其他例外按各自规则处理。

## 已确认的改名决策

| 项目                                | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发往模型服务商与外部 HTTP 的 header | 品牌值与头名全部改为 Zody：`User-Agent: Zody/<ver>`、`X-Title: Zody@<source>`、`X-OpenRouter-Title: Zody`；`X-ZCode-App-Version`→`X-Zody-App-Version`、`X-ZCode-Agent`→`X-Zody-Agent`（值不变）、`x-zcode-trace-id`→`x-zody-trace-id`、`x-zcode-session-type`→`x-zody-session-type`、`x-zcode-query-source`→`x-zody-query-source`。已知代价：上游 Coding Plan 服务端按旧头名做的来源统计不再生效。开发期网络抓取同步识别新头名                                                               |
| 其他对外身份                        | WebFetch UA 为 `Zody-WebFetch/<ver> (+https://github.com/zclaudia/zody; coding-agent-cli)`；插件安装 UA `Zody-Plugin-Installer`；MCP `clientInfo.name` 为 `zody`，MCP OAuth 动态注册 `client_name` 为 `Zody <server>`，client-credentials 客户端名前缀 `zody-`；手机向 gateway 上报 `clientName: "Zody Mobile"`；自签 CA 为 `Zody Network CA` / `Zody`；Git 检查点作者 `Zody Checkpoint <checkpoint@zody.local>`；Headless/内嵌浏览器描述名 `Zody Headless Chromium` / `Zody In-app Browser` |
| MCP Apps 宿主标识                   | `MCP_APPS_HOST_NAME`、插件 UI `userAgent`/`hostVersion` 与 Gen UI 应用名改为 `zody` / `zody-gen-ui`；仓库内无插件依赖旧值                                                                                                                                                                                                                                                                                                                                                                    |
| 进程名                              | 前缀 `zcode`→`zody`（`zody-host-*`、`zody-renderer-*`、`zody-node-repl-mcp` 等）；主窗口识别按当前产品名标题（`Zody`、`Zody - `）；稳定性遥测的进程匹配同步更新                                                                                                                                                                                                                                                                                                                              |
| 工作区搜索忽略文件                  | 新增 `.zodyignore`：优先读取 `.zodyignore`，缺失时只读 `.zcodeignore`；设置页编辑写入 `.zodyignore`，不改写旧文件；默认规则 marker 改为 Zody 文案，同时识别旧 marker；缓存指纹以实际生效文件为准                                                                                                                                                                                                                                                                                             |
| gateway namespace 默认值            | `DEFAULT_REMOTE_ACCESS_NAMESPACE` 改为 `zody`，placeholder 与 i18n 提示同步；用户已保存的显式值不变                                                                                                                                                                                                                                                                                                                                                                                          |
| `restore-legacy-sessions` 插件      | 从 SEA 打包、官方插件定义、远程部署资源和内置 skill i18n 中移除，不再随发行提供；包源码暂留                                                                                                                                                                                                                                                                                                                                                                                                  |
| CLI beta 存储                       | `ZODY_BETA=1` 或以 `zody-beta` 名启动时，存储根为 `~/.zody/beta`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 本机可见的内部名称                  | 首发一并改为 zody：临时目录/文件前缀、SEA 资源缓存目录（`~/Library/Caches/zody` 等）、CLI 日志文件名 `zody-YYYY-MM-DD.jsonl`、localStorage 键、Electron 分区 `persist:zody-*`、cookie `zody_lite_token`、注入网页的 `__zody*` 全局变量与 isolated world 名、Windows 命名管道、Android 工程名/主题名/通知渠道 id/临时文件前缀、安装清单 `.zody-install-manifest`、`userData` 下的内部 JSON 文件名                                                                                             |
| 品牌草稿                            | `output/brand/` 移到 `docs/brand/`，`output/` 加入 `.gitignore`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 下载镜像                            | `mise.toml` 不再默认设置 `ELECTRON_MIRROR`；`prepare-prebuilds` 默认官方 Node 下载源，镜像通过环境变量显式启用                                                                                                                                                                                                                                                                                                                                                                               |

localStorage、分区和 cookie 改名不迁移旧值：0.1.0 无正式存量用户，首发规格已允许破坏性升级。

## 必须修复的缺陷

1. 记忆文件写入的敏感目录名单加入 `.zody`。
2. macOS Finder 快捷操作：名称、Bundle id、菜单文字按产品身份生成，唤起协议使用当前构建的 `zody://` 或 `zody-preview://`，不与上游 `Open in ZCode.workflow` 同名。
3. Windows 资源管理器右键菜单：注册表键名与文字按产品身份生成，Preview 不覆盖正式版。
4. 数据目录位于安装目录内的保护：NSIS 安装器检查 `.zody`；`paths.ts` 的默认安装目录候选按产品名（`Zody`）生成；提示文案改为 Zody。
5. 模型可见文案中的路径一律指向 `.zody/`（agent 定义、skill-creator、dynamic-workflows 示例）；项目 `.zcode/` 只能作为只读兼容来源出现。
6. 删除读取上游 `%APPDATA%\ZCode` 等目录的 MCP 旧数据导入链路（`mcpUserDirectory/legacy.ts` 及其 IPC、preload、store 入口），以及 `remoteCdn.ts` 中已不可达的上游 CDN 默认地址。

## 用户可见文案

所有用户界面、CLI 帮助/用法/报错、TUI、系统提示词与模型可见工具说明、安装器详情与日志名、导出文件名、商店展示文案、插件 manifest 描述、桌面原生菜单/托盘/关于窗口、窗口与页面标题、权限对话框、远程部署报错，统一使用 `Zody`（命令名 `zody`）。默认新建项目目录 `~/ZCodeProject` 改为 `~/ZodyProject`。不可用的系统级 Computer Use 相关文案同样改名，保持隐藏。内部日志消息不要求逐条改写，但面向用户的错误必须改。

## 文档与仓库

- `UI_PLUGIN.md` / `UI_PLUGIN.en.md`：指向 `zclaudia/zody`，命令改为 `zody`，开发数据目录示例使用 `.zody` 前缀；插件协议标识按兼容契约处理。
- 远程部署文档改名为 Zody，远端目录写为 `~/.zody/server/`。
- Android 远控文档链接公开的 `https://github.com/zclaudia/zclaudia-gateway`，不出现维护者本机路径。
- `packages/desktop/package.json` 的 `description`、`author`、`productName` 使用 Zody；Linux 包描述与快捷方式说明随之更新。
- 维护脚本（`doctor-macos-release-app.sh`、`dev-desktop-remote-prod.mjs`、dev Electron bundle 身份、`apps/dev-docs`）使用 Zody 名称与 `~/.zody` 路径。
- 注释中过时的 `~/.zcoder` 路径改为 `~/.zody`。

## 验收场景

- 全仓 `git grep` 中，除上述明确例外与 `docs/` 历史文档外，不再出现面向用户或外部的 `ZCode`、`zcode://`、`~/.zcode`、`~/.zcoder`、`zcode.ai`、上游 CDN 域名。
- 单测覆盖：请求头名称与值、MCP clientInfo/OAuth client_name、记忆敏感路径包含 `.zody`、`.zodyignore` 优先与 `.zcodeignore` 回退及写入目标、namespace 默认值、Finder workflow 与 Windows 右键菜单按 flavor 生成、进程名与主窗口识别、安装目录候选、beta 存储根、内置插件列表不含 `restore-legacy-sessions`。
- 修改断言旧值的既有测试，使其断言新值。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与受影响包的单测实际执行并如实记录；Windows 安装器、macOS Finder 服务等需要真机的场景标为待人工验收。

## 手工数据工具默认路径

大型任务 fixture 工具的默认任务索引和 CLI 会话数据库位于 `~/.zody/v2/tasks-index.sqlite` 与 `~/.zody/cli/db/db.sqlite`；备份和 manifest 位于同一 `.zody` 根。`--workspace` 仅指定任务工作区，不改变数据库目标。恢复旧会话工具默认从 `~/.zcode/v2/sessions` 扫描历史快照，目标使用上述 `.zody` 数据库；既有 `--legacy-dir`、`--snapshot`、`--task-index` 和 `--cli-db` 保持各自的覆盖语义。工具不自动迁移旧数据库。

验收：隔离 HOME 下生成、验证和删除仅影响新默认库及其备份；恢复默认读取旧快照、写入新目标，显式输入与数据库路径覆盖准确生效；历史源和旧数据库不被改变。E2E case 中 HOME 下的 model-io 和 image-cache fixture 描述与 `.zody/cli` 实际路径一致。
