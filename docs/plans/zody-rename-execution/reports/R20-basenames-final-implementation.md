# R20.4 剩余 basename 实施记录

基线 `d49aecefa7d1c3571bfae69fe4817950654b9298`；应用经主控核对的 98 个移动和 244 个消费者修改，精确文件、移动映射与内容见 `output/zody-rename-r20-basenames/remaining-plan/final-d49/candidate-files.json`、`consumer-plan.json` 和 `candidate-d49.patch`。patch SHA-256 为 `b25066c2fe4662ecf301bb18604a7e47a303f44837b535872488f6148fd80786`。342 个候选文件与独立 d49 加 patch 的预期逐字节一致，98 个旧路径均不存在，证据见 `live-candidate-verify.json`。保留当前符号、协议、环境变量与外部身份；feature graph 未在本批修改。

以下日志均在 `output/zody-rename-r20-basenames/remaining-plan/final-d49/`。所有命令使用该工作树的绝对 Node 24.14.0 PATH；CLI 实际 cwd 的版本记录在 `cli-node-version.log`。目标测试的精确 cwd、完整 argv、文件集合和退出码分别见 `test-{root,cli,cliNode,devdocs}-actual.json`；收集命令见 `collection-actual.json` 和 `collection-devdocs-command.json`，收集结果使用 `--json=/绝对输出路径`，详见 `collection-summary.json`。

- 根目标 Vitest：119 个文件，118 通过、1 失败；1815 测试通过、1 失败、1 跳过，退出 1（`test-root.log`）。唯一失败是 `packages/provider/test/m2-completion-boundary.test.ts` 对 `providerRevision` 的全文检查匹配 4 处 `providerRevisionSha256`；d49 的对应源码已含这些文本。未改断言。
- CLI Vitest：4 文件、126 测试通过，退出 0（`test-cli.log`）；CLI Node 测试 2 项通过，退出 0（`test-cliNode.log`）。
- dev-docs 独立配置：4 测试中 3 通过、1 失败，退出 1（`test-devdocs.log`）。失败为图 seed 中 `packages/shared/src/zcode-agent-model-state.ts` 仍是旧路径；图归 R21，未修改。
- 根目录 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均退出 0，分别为 `gate-0.log`、`gate-1.log`、`gate-2.log`；lint 有 303 warnings。架构通过仅指 changed-only；全量架构两项既有失败未在本批解决。
- `node scripts/audit-zody-agent-remnants.mjs --json --root=packages/shared/src,packages/server/src/remote,packages/ui/src/lib` 和输出目录中的独立分类检查完成，5 项精确分类断言通过，见 `audit-remnants.json`、`audit-classifier-check.log`。

在保全 5 个生成树及 buildinfo 的 9645 文件并校验其哈希后，从空输出重建 `pnpm exec tsc -b --force packages/shared packages/services packages/server packages/ui`、`pnpm --filter @zody/bootstrap build`、`pnpm --filter @zody/server build`、`pnpm exec turbo --cwd apps/zody-cli run build --filter=@zody/cli^...` 和 `pnpm --filter @zody/cli build` 均退出 0；日志分别为 `build-tsc.log`、`build-0.log`、`build-1.log`、`turbo-cli-deps.log`、`cli-build.log`。新 CLI 与 server bundle 的 `--version` 均退出 0。`clean-output-audit.json` 核查五个干净生成树中的 59 个迁移源码模块：新输出存在，旧输出不存在。Desktop main 共享输出未清理；该目录仍有旧新输出并存，已知 main 85 个基线诊断及缺 CUA manifest 阻断干净构建，交 R22/R60，不能将当前 Desktop 输出视为最终包。

WDIO ConfigParser 的实际发现结果经离线 `file://` 转换后包含新的 zodyignore spec（`wdio-discovery-analysis.json`）；resolver 的 strict/capture 回归包含在根目标集。这只是发现及解析证据，未执行原生 E2E。

**安装副作用**：从 `packages/desktop` 调用 `node --import tsx ../../output/zody-rename-r20-basenames/remaining-plan/final-d49/wdio-discovery.mjs` 时，加载实际 `wdio.conf.ts` 自动触发 `node_modules/electron/install.js`；日志 `wdio-discovery.log` 显示安装脚本执行并报告 Electron 可执行文件就绪。原 discovery 命令因未将返回的 file URL 转为路径而退出 1，后续只离线分析已保存结果，未再次加载配置或执行安装。检查时无该安装进程；342 个候选文件与预期一致，649 个包清单及锁文件与预期一致（`electron-install-incident.json`）。没有 node_modules 前后完整哈希，故无法证明安装脚本实际改变范围，也未删除或回滚未知文件。

本批未提交，测试失败、图更新及 Desktop 构建限制均保留待后续处理；不得据此宣称整个 P2 通过。

## providerRevision 基线复核

在未打 patch 的 d49 源码快照 `output/zody-rename-r20-basenames/remaining-plan/final-d49/snapshot` 中，以当前已安装 Vitest 可执行文件运行原始 `packages/provider/test/m2-completion-boundary.test.ts`，退出 1（38 通过、1 失败），四个命中与当前测试完全相同。原始扫描根由测试文件 `import.meta.url` 解析到快照；生产根列表和扫描函数与当前一致，快照扫描树的 tracked 字节及文件清单均与 d49 一致，未借用当前 dist。测试仅导入 Node fs/path/url 与 Vitest。精确 cwd、argv、文件清单核验和四路径对照见 `provider-baseline-proof.json`，实际输出见 `provider-baseline-proof.log`。首次在快照中以 `pnpm exec vitest` 尝试因快照无本地可执行文件退出 254；随后使用主工作树已安装 Vitest 的绝对路径完成复现。

## 格式化补丁

主控预提交发现 `packages/desktop/test/upstreamReplayFixtureResolution.test.ts` 未通过 oxfmt；仅对该文件执行 `pnpm exec oxfmt`，随后 `pnpm exec oxfmt --check packages/desktop/test/upstreamReplayFixtureResolution.test.ts` 退出 0。格式化除换行空白外还移除了两个多行调用中合法的尾随逗号；因此忽略空白的 diff 和 token 比较均退出 1。TypeScript 解析后的标准打印结果一致（`resolver-format-ast-check.json`），人工核对补丁未发现行为变化；前后 SHA-256、补丁与命令输出分别在 `final-d49/resolver-format-hashes.txt`、`resolver-format.patch`、`resolver-format*.log`。上文 342 文件逐字节核验发生在这一格式化 overlay 之前；该文件当前内容以 overlay 后哈希为准。未重跑测试或构建。

## Audit store 路径后续修正

`scripts/audit-zody-agent-remnants.mjs` 中 store 前缀从已消失的 `zcodeSessionStore` 改为现行 `zodySessionStore`，未添加旧新兼容。前面的 `packages/ui/src/` 规则已覆盖该路径；对现存 6 个对应 store 文件，修改前后直接分类均为 `compat-type`（`final-d49/audit-prefix-followup.classification.json`）。执行 `node scripts/audit-zody-agent-remnants.mjs --json --root=packages/ui/src/store` 前后均退出 0，JSON 相同，但该 root 实际扫描文件数为 0，不能单凭此结果证明分类；额外路径分类核验补足此局限。`node --check scripts/audit-zody-agent-remnants.mjs` 退出 0。
