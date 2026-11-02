# R20.5 当前文档精确子批

源码依据固定 `1b042046c373fa91c5ed80b1501bcf0677f2eb39`，通过 `git show` / `git ls-tree` 核对；本批只改以下现行引用与本报告，没有修改源码、锁、生成物，也未运行构建、测试或安装。

- `docs/runtime-tools/agent-electron-node-runtime.md:14,20,28,33-34,47`：`@zcode/tui` → 当前 `@zody/tui`；process manager 文件名 → `zodyAgentProcessManager.ts`，保留实际存在的 `resolveElectronRuntimeZCodeAgentCommand`；当前远端 bundle 示例 `~/.zcode/server` / `$HOME/.zcode/server` → `.zody`，与 `packages/server/src/remote/zcodeAgentBundleWrapper.ts` 和 `packages/shared/src/dataDir.ts` 一致。
- `docs/windows-agent-process-cleanup-state-machine.md:13`：当前等待链类名 `ZCodeAgentProcessManager` → 已导出的 `ZodyAgentProcessManager`。`:159` 的旧测试文件名与 360/360 属 2026-08-24 验证历史，保留原样；当前测试文件为 `packages/services/test/zodyAgentProcessManager.test.ts`，不把现行文件名嫁接到历史记录。协议类 `ZCodeProtocolClient` / `ZCodeStdioTransport` 为当前真实类名，保留。
- `docs/workspace-project-removal-runtime-release.md:37`：内部示意调用 `zcodeAgentProcessManager.disposeWorkspace` → 实际 `processManager.disposeWorkspace`；`zcodeAgentService.ts` 中使用此实例名。其他 service 名及事件顺序未改。
- `docs/zcode-agent-app-integration.md:5,17-18,45,109,124-128,132-133`：CLI workspace 和 bin 改为 `apps/zody-cli`、`zody`；类名改为 `ZodyAgentProcessManager`；protocol 目录、五个 services 入口及两个 bootstrap 目录按固定树现存路径映射；desktop workspace 名改为 `@zody/desktop`。`zcode-protocol-entrypoint.ts` 和 `packages/shared/src/zcode-agent-runtime.ts` 是当前真实 basename，保留。
- `docs/architecture/federated-node-hub-state-and-migration-plan.md:316,1096,1099,1119`：已存在的 RPC 包名和三个 must-inspect 源码路径映射至 `@zody/rpc`、`zody-protocol`、`apps/zody-cli`、`zody-agent/zodyAgentProcessManager.ts`。未来命令和阶段规划未改。
- `docs/windows-test-compatibility.md` 经核对无本批必须更新的现行源码引用：保留原文件。旧 `@zcode/zcode-cua` 为历史 rebase 记录，旧测试名、计数、域名、环境变量为当时实测内容；不将现行名称冒充历史证据。

保留项与边界：六文档中的历史 ZCode 品牌和旧 native `zcode-agent` 记录保持原意；`zcode-agent` 当前仍为 runtime/wrapper 可执行名。`ZCODE_SERVER_RUNTIME_ROOT` 在当前 wrapper 中仍被读取，其他 `ZCODE_*` env 属 R30；V4/wire、schema、`IZCode*`、`zcodeProtocolClient`、`zcodeStdioTransport`、`zcodeSessionStore` 和 builtin 字段保留当前源码身份，后续各自 owner 负责。federated 文档 `zcode node/lite/hub` 是未实现的方案命令，不改名或宣称已实现；该文档中不存在的 `scripts/build-zcode-lite.mjs` 已移出 must-inspect 并明确为计划项；方案形成时的旧配置事实已标为历史假设，当前 `.zody` 默认及 App/CLI 各自覆盖已注明，迁移树中的 `.zcode` 明确为历史来源。其他方案形成时的事实尚未逐项复验，标题和提示明确其历史背景，不作为当前事实。外部协议、出处、历史时间和测试数据均未更改。

验证：`git diff --check` 针对六文档退出 0；逐个新路径通过固定提交 tree 查证；未执行测试（文档子批且任务明确禁止）。

补充收口：`docs/architecture/federated-node-hub-state-and-migration-plan.md` 的“当前事实”更名为方案形成时背景与待核实假设，旧模型配置陈述不再宣称当前权威；列明现行默认任务索引和 CLI 数据库 `.zody` 路径及分别覆盖，旧 `.zcode` 数据树保留为历史迁移来源。不存在的 Lite 构建文件移出 must-inspect，标为待实现计划项；未更改未来命令或产品规则。

品牌与路径措辞补充：当前产品标题和当前 App/Agent 叙述使用 Zody，历史 ZCode 二进制、历史测试、内部符号和未来方案名称保留。federated 文档明确 dataBaseDir 只替换计算应用数据根的基目录，不修改进程 HOME。固定提交证据：`packages/services/src/paths.ts` 的 `getDataBaseDir`、`getZCodeDataRootDir`、`getTasksIndexDatabasePath` 按设置 > `ZCODE_DATA_BASE_DIR` > HOME 构造 `.zody/v2/tasks-index.sqlite`；`apps/zody-cli/packages/contracts/src/config/index.ts` 的 `DefaultRuntimeConfig.storage.sessionDbPath` 默认 `~/.zody/cli/db/db.sqlite`，`apps/zody-cli/packages/adapters/src/config/env-config.adapter.ts` 的 `parseEnvConfig` 接受 `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` 覆盖。当前报告仍按固定提交记录 `resolveElectronRuntimeZCodeAgentCommand`；后续源码批次拟修改该符号，冻结后主控同步文档，不在本批预称验收。

主控后续同步：batch-03 源码停写并验证后，Electron runtime 文档两处 resolver 引用改为 `resolveElectronRuntimeZodyAgentCommand`，对应本批真实函数声明。其余来源仍为上列固定基线。
