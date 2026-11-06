# Root workspace installation: DeepSeek review 1

Reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`; read-only, fixed83680ddc→7c4ff911. Raw response follows. Controller disposition: container fixes and accurate install-scope documentation are required; selecting the supported native-toolchain option retains hoisted layout and does not imply Electron is absent. Historical ledger notes remain historical; current summary must stay current.

**结论：CHANGES_REQUIRED**
固定候选 `7c4ff911` / tree `de2caf21` 的根 workspace、锁与安装所有权子范围未发现产品阻断；但 compact Docker 的真实构建已失败，因此不能给整体 PASS。

**已核查范围**
- 独立核对固定 SHA/tree、29 文件 diff；26 项实现文件与 `file-hashes.json` 一致。
- 根 `pnpm-lock.yaml` 字节不变，SHA-256 仍为 `12e11b834269bada1625ea6b086eabab1234881e2038adb2a3cac21eb345a63f`。
- 嵌套 `apps/zody-cli/pnpm-lock.yaml`、`pnpm-workspace.yaml`、`turbo.json` 已删除；根 workspace 记录 50 成员/92 links。
- 根 Turbo 承接 10 个任务，`ZCODE_ENV`/`NODE_ENV` 保留；CLI 8 个入口仍选 30 个 CLI 子包，SEA 选 29 个并排除自身，保留 6 个根依赖；防护 env 未见改动。
- 读取的日志显示：clean install、23/23 `--force` 构建 0 cached、CLI typecheck/lint、root typecheck/lint（303 warnings）和 47 tests 已执行；`cleanbundle --version` 为 `0.1.0`。这些是记录证据，我没有复跑。
- CLI 全 suite 仍为 exit 1：core 两失败（缺 `invalidateCuaSubmissionTurnScopeForForeground`、`internal-methods.ts` 407>400）；你提供的 836 隔离复现为 2 failed/10 passed，故不归因本候选。adapters 被中断，未完成。

**阻断：compact Docker 真实构建失败**
- 证据：`output/zody-rename-r21/root-owner-implementation/clean-docker-compact.log:364` 为 `ELIFECYCLE Command failed with exit code 1`；`:280` 实际执行 `node_modules/electron postinstall`，`:283-316` 执行 `node_modules/node-pty` 并因缺少 Python 失败，`koffi` 缺 CMake、`cpu-features` 缺编译器。
- 根因：`apps/zody-cli/e2e/compact-microcompact/Dockerfile:26` 的 `COPY . .` 带入根 `.npmrc` 的 `node-linker=hoisted`；`:34-35` 虽然只 filter 38 个包且列表无 `@zody/desktop`，hoisted 安装仍实际拉入 Desktop 的 `electron` 和 `node-pty` 等原生依赖。因此“38 包无 Desktop”只对静态包列表成立，实际安装闭包不成立。
- 最小修正：在 Docker 安装前覆盖 `node-linker=isolated`（如 `pnpm config set node-linker isolated` 或 `--config.node-linker=isolated`），或改用 `pnpm deploy --filter @zody/cli`/`--ignore-scripts` 后显式执行所需 postinstall；若保留 `node-pty`/`koffi`/`cpu-features`，补 `apk add --no-cache python3 make g++ cmake`。修后重跑 compact build，确认退出 0 且不存在 `node_modules/electron`，并更新 R21 报告中的“Docker 未执行/pending”记录。
- 附带说明：`clean-docker-browser.log:1117` 的 EACCES 失败来自 base 836 已存在的 `headless-linux.Dockerfile`，该文件在本候选字节未变，我不把它计作 R21 回归；但该 Docker 路径同样未验证。

**非阻断文档/授权问题**
- `docs/plans/zody-rename-execution/file-assignments.json:15184/15196`：R21 `readSet`/`writeSet` 仍列已删除的嵌套 `apps/zody-cli/pnpm-lock.yaml`，`plannedPaths` 未标 removed。建议移除或标 `removed/currentPath:null`，避免后续 writer 重新创建嵌套锁，破坏根唯一 owner。
- `docs/cli-ci-packaging.md:15`：仍写“不能只使用 CLI 子 workspace 的 Turbo 图”；嵌套 workspace 已删除，建议改为“根 Turbo 的 CLI 入口范围/根 workspace”。
- `docs/plans/zody-rename-execution/task-ledger.md:3` 仍以 `83680ddc` 为最新候选；`:106/:113/:121/:159` 的“nested workspace pending/no change”已被 `:208/:215` 取代。建议更新到 7c 并删除过期 pending 描述。
- `docs/plans/zody-rename-execution/r20-authorized-scope.json:690/5806` 仍保留已删除嵌套 CLI lock/turbo 的保护/映射引用；不是当前写入授权，但应在 R21 收口时清理。

**限制**
本次仅为固定 SHA 的静态审查加既有日志读取，未 install/build/复跑 Docker/WDIO；不声称完整 R21、P2 或发行通过。Main 的 85 诊断仍不是通过，CLI 全 suite 和 adapters 仍未绿。
