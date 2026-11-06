# R21 compact E2E harness 修正

基线 `a3a0d9c93bc61289fcb32f6538ccaea326e0631c`。仅修改两个测试 harness 文件；修改前后 SHA-256：

- `apps/zody-cli/e2e/compact-microcompact/case-usage-anchor.mjs`：`a7a6cfabe63ef4efe6fd75e0f46054585d3bc897b220661c26f4218a7b1bc62d` → `95c1d9bbd317e9763a2d446e1e56816f86ea6ca9e3dd48b4b9d162db45b0e8f6`。三处等待异步 `createApp`，避免将 Promise 当成 app。
- `apps/zody-cli/e2e/compact-microcompact/case-background-bash.mjs`：`75546ff2df219508853af71a225e18fe4cfb7043e8ebd441f86ad72a1f229a1b` → `841909b9be10d179fcdbfdb3ee91404b6e75242f8285c70efa6558df766aad8a`。对完整安全来源前缀加原有完整 task-notification 执行精确等值校验；不改产品安全前缀，也不降低通知内容验证。

修正前真实 Docker 证据：`output/zody-rename-r21/docker-correction/compact-fake-tsx.log` fake 5 通过、background-bash 和 usage-anchor 失败，分别为未包含前缀的断言和对 Promise 调用 `submitPrompt`；`compact-background-tsx.log` 的单项亦失败。此前 Docker 构建/原生入口结果另见 `R21-docker-correction-verification.md`。

修正后本地真实验证，cwd `apps/zody-cli`，Node 24.14.0、根现有安装的 `tsx`，以仅含 PATH、HOME、USERPROFILE、TMPDIR、LANG 的隔离环境执行，临时 HOME/TMPDIR 与完整 argv/退出码见 `output/zody-rename-r21/docker-correction/harness-local-results.json`；无 API key、无真实 HOME：

- `node --import tsx e2e/compact-microcompact/run.mjs --case=fake` 退出 0，7/7 场景通过（`harness-local-fake.log`）。
- `node --import tsx e2e/compact-microcompact/run.mjs --case=background-bash` 退出 0，1/1 通过（`harness-local-background-bash.log`）。

本地命令使用当前已存在的编译产物，未重新构建；此结果不证明修正后 Docker 容器全绿，最终完整候选的 clean build/runtime 仍须另验。根 cwd `pnpm typecheck`、`pnpm lint` 均退出 0（`harness-typecheck.log`、`harness-lint.log`）；两个目标文件 `pnpm exec oxfmt --check` 退出 0（`harness-format.log`）。未安装、运行 Docker 或提交。

主控独立复验：使用固定 Node 24.14.0 和同一已安装 tsx，在独立临时 HOME/TMPDIR、仅含 PATH/HOME/USERPROFILE/TMPDIR/LANG 的环境执行相同本地 fake 与 background-bash，两者均退出 0；完整 argv/退出码见 `output/zody-rename-validation/harness/commands.json`，输出见同目录日志。临时目录随后删除。主控复核三个 await 及独立完整前缀+原有完整通知等值断言，未改产品逻辑；这仍是本地已存在编译产物验证，不替代最终完整候选容器验证。
