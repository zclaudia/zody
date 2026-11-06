# R20 目录残留与手工路径测试修正

基线 `7c4ff9113680a38e273032b09bee32ee6ba399af`。六个目录消费者、手工路径测试和 skill 文案共八个文件，精确路径及修改前后 SHA-256 见 `output/zody-rename-r20-basenames/directory-residual-preflight/live-file-hashes.json`。未改运行时身份、冻结内容或根安装配置。

手工路径测试断言 manifest 精确位于临时 HOME 的 `.zody/perf-task-manifests/<sessionId>.json`。独立复制的 mutation 只将 manifest 指回 `.zcode`，`MANUAL_TEST_ROOT=<隔离副本> node --test scripts/test/zody-manual-data-paths.test.mjs` 退出 1，失败在该断言且实际 `.zcode`、期望 `.zody`；实际源码同一命令不带 mutation 退出 0，2 测试通过。日志 `manual-mutation.log`、`manual-real.log`。临时 HOME 和数据库由测试隔离，未操作用户数据。

bootstrap 的 v4 边界扫描和 legacy regex、模块 mock、shared mock、删除模块 ENOENT、services modelTrajectory 源码读取及 shadow-replay 两个 dist 导入均指向当前目录。v4 守卫验证扫描非空并覆盖现行旧协议与 v4 目录反例。CLI cwd `apps/zody-cli` 执行根 `node_modules/.bin/vitest run packages/bootstrap/tests/v4-native-boundary.test.ts packages/bootstrap/tests/v4-native-selection-side-chat.test.ts packages/bootstrap/tests/conversation-topic-publisher-hydration-bound.test.ts packages/bootstrap/tests/provider-m2-legacy-boundary.test.ts`，4 文件 26 测试通过（退出 0，格式化后 `live-cli-after-format.log`）；根 cwd `node_modules/.bin/vitest run packages/services/test/modelTrajectory.test.ts`，7 测试通过（退出 0，`live-services.log`）。

根 cwd 使用 pinned Node 24.14.0：`pnpm exec turbo run build --filter=@zody/bootstrap...` 退出 0；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均退出 0，lint 303 warnings。目标文件 `pnpm exec oxfmt --check` 首次 3 个文件不符，已格式化后复查退出 0，CLI 测试在格式化后重跑通过。日志 `live-bootstrap-build.log`、`live-typecheck.log`、`live-lint.log`、`live-architecture.log`、`live-fmt-after.log`；架构检查仅为 changed-only。

shadow-replay 使用输出目录专用空 SQLite、专用 HOME，且默认复制数据库：构建后 plain `node apps/zody-cli/scripts/shadow-replay.mjs --db <synthetic.sqlite> --limit 0` 退出 1，因 shared 导出 TS 源文件中 `core.js` 无法由 Node 解析（`shadow-synthetic/run.log`）。同一命令加 `--import tsx` 退出 0（`run-tsx.log`），只验证空库加载及初始化，未验证实际会话回放；未访问真实用户数据库。已将该脚本 usage 示例更正为验证过的 `node --import tsx`；该加载条件与实际会话回放仍交后续 runtime 门禁。

所有测试和构建命令使用工作树绝对路径的 pinned Node；未安装、运行 WDIO 或提交。
