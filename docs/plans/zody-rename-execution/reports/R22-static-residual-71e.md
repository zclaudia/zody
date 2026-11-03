# R22 解析相关残留：71e 源码有界核对

HEAD `1262e00c42bd8b4cc8f2e87aeeeb71438fa77b8b`；按任务提供的基线，其运行源码与 `71e21e4f` 一致。基于 `R22-static-ad859.md`、`ad859-static/knip-plain.log` 和当前源码核对；未重跑全量 knip、测试或构建。结构化逐项证据、owner 和限制见 `report.json`。本次检查不把 knip 的 676 unused files 或其余大类直接认定为 bug，也不声称 R22 已通过。

**已定位并按授权修正：** `.prettierignore` 的三条生效规则仍指向旧的 `apps/zcode-cli/`，未匹配当前目录。根 `package.json` 的 `fmt:check` 调用 `oxfmt --check`，`oxfmt-help.log` 确认默认读取当前目录 `.gitignore` 和 `.prettierignore`。修改前，仅对当前两份 `for await` 图 fixture 运行只读 `--check`，exit 2，均出现解析错误（`oxfmt-target.log`）。先补 spec 验收，再将原三条规则映射到 `apps/zody-cli/`；`ignore-parity.json` 证明其他行和规则未变。修改后只指定两份已忽略文件，oxfmt 0.41.0 以 exit 2 报 `Expected at least one target file`；加入已格式化的根 `package.json` 作为对照后 exit 0，显示仅检查 1 个文件，证明两份 fixture 被跳过（两个 green 日志均保留）。根 `pnpm typecheck`、`pnpm lint` 均 exit 0，lint 303 warnings；`git diff --check` 通过。精确 before/after SHA 在 `change-hashes.json`。`.prettierignore:2` 的旧目录注释未列入三条规则授权，仍需按当前文字处理。

**活跃旧模块与路径：** `literal-scan.json` 对 9429 个 Git 跟踪的 TS/TSX/JS/MJS/CJS/JSON 文件解析字符串，排除 docs、third-party 和 native 快照，但显式纳入两个活跃 native 入口；未发现字面量 import/export/require 引用 `@zcode/` 或 `apps/zcode-cli`。这不涵盖计算出的路径、生成文件、所有 markdown 或 native 历史证据，不是完整构建证明。Shell/YAML 的有界检索出现当前 feature graph 的旧包名说明和历史脚本注释，没有发现对应命令引用。`scripts/official-account-removed-paths.txt` 的旧路径供 `scripts/upstream-sync-resolve.mjs` 精确匹配旧 upstream 的删除冲突；是历史来源和特定输入合同，不能将其当作当前模块路径批量替换。

**原始 knip：** ad859 的 169 unlisted 项包含活跃测试引用和冻结历史源码，原始终端输出截断路径，不能按行面精确归类全部项。已核实的 `@zcode/contracts` 示例位于 `packages/desktop/native/macos-cua-driver-closure/reports/2026-10-30-desktop-session/frozen-candidate/source/apps/zcode-cli/packages/adapters/src/mcp/cua-native-authority-capture.ts:5`，是 Git 跟踪的历史快照，保留旧身份。当前 `adapters/tests/cua-native-authority.test.ts:16` 引用 `@zody/core` 而 adapters manifest 未直接声明该依赖；`core/tests/cua-submission-control-binding.test.ts:16` 为 `@zody/adapters/mcp` 类型引用，实际运行时另从 adapters package 的 exports 构造 `createRequire`；desktop 的 `browserControlMainBridge.test.ts:6` 使用 `@zody/contracts` 类型且 desktop manifest 未直接声明。后者在 ad859 根测试 12/12 通过。应由 R22 测试/依赖 owner 核验包级解析与依赖方向，不能仅凭 knip 报告断言它们是产品解析故障或盲加依赖。

**已修范围与剩余验收：** f0b8 修正 SEA TUI producer/consumer 和 Desktop 内部包路径；5bdc 同步五组 SEA key、消费端及测试，71e 刷新许可输入指纹；各自证据见 `R22-sea-and-desktop-path-fix.md` 和 `R20-sea-key-closure-implementation.md`。`R22-cli-prerequisites-edb.md` 记录从当前源构建 CLI 依赖并使此前缺 dist 的两文件 7/7 通过；该证据不等于 71e 全量测试或完整四目标构建通过。

**明确保留后续 owner：** telemetry 中 `@zcode/cli-agent-telemetry`、`@zcode/local-ttft`、`@zcode/desktop-renderer-action-trace` 是运行时 instrumentation 身份，归 R46 遥测断代，非模块导入。CUA scope audit 两个含旧 `require` 的字符串是负向测试样本，不可机械替换。当前 graph 内部说明 `.agents/skills/feature-boundary-planner/references/zody-feature-graph.yaml:440` 仍含 `@zcode/model-option-map`，受已接受 R21 graph 原字节移动合同约束，保留并不视作解析阻塞。其余当前文字登记 R20.5 待办，不在本批修改：

- `apps/zody-cli/packages/browser-use-plugin/package.json:6`：description 的 `@zcode/node-repl-host` → `@zody/node-repl-host`。
- `apps/zody-cli/packages/core/tests/cua-submission-control-binding.test.ts:32`：错误文本的 `@zcode/adapters` → `@zody/adapters`。
- `packages/desktop/test/macosCuaHelperRound11Authority.test.ts:209`：错误文本的 `@zcode/core` → `@zody/core`。
- `.prettierignore:2` 与 `apps/zody-cli/packages/cli/src/plugin-host-command.ts:110`：当前注释的 `apps/zcode-cli` → `apps/zody-cli`。

更多活跃注释未作全量语义审计。
