# R10-deepseek-review-1

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cdb-5be9-73f3-9b21-930b5c45f36a`; route deepseek-flash, provider magpie, model group/deepseek, read-only.

**结论**
`CHANGES_REQUIRED`。17 项脚本迁移与代码、CI、package scripts 的接线基本正确，但 R10 的活跃 spec 仍有指向已删除脚本的引用，因此不能验收为完成。

**审查证据**

- `git diff --find-renames` 确认 17 项迁移：12 个 `scripts/zody-distribution/*` 加 5 个单文件；旧路径均不存在。
- `.github`、根 `package.json`、`packages`、`apps`、`scripts` 中没有残留的旧脚本路径引用；冻结证据和测试临时目录前缀除外。
- package/CI 引用的脚本存在性检查无缺失；全部 renamed scripts 通过 `node --check`；`build-zody.mjs --help` 与 `audit-zody-agent-remnants.mjs --help` 均 exit 0。
- 本 commit 未修改 `pnpm-lock.yaml`、`packages/shared`、`zcode-protocol`、scope/env/wire、native/frozen evidence；workflow 的 `ZCODE_ENV` 保持不变。
- 断言未被减少：旧 runner 测试为 6 tests/15 asserts，新文件仍为 6/15，仅 runner URL 改变；保留的 `scripts/zody-distribution.test.mjs` 为 11 tests/28 asserts，仅 5 个 import 改变；合计 17 项。
- **阻塞**：`specs/zody-cli-distribution-release.md:18` 和 `:28` 仍写 `scripts/build-zcode.mjs`。该文件是活跃 spec，且 `docs/plans/zody-rename-execution/file-assignments.json:222` 明确列为 R10 writeSet，应改为 `scripts/build-zody.mjs`。
- **追加检查**：`scripts/zody-distribution-smoke.mjs:17-18` 仍假设解包根为 `zcode`、runner 为 `bin/zcode.mjs`，而 `scripts/build-zody.mjs:26` 输出 `zody`、`:162` 安装 `bin/zody.mjs`。该脚本不在当前 CI/测试中；若保留为活跃入口需修正，否则应标历史或移除。
- **文档一致性**：`docs/desktop/dev-runtime.md:5-10` 仍写 `.zcode-runtime`/`ZCode Dev.app`，与本次 `docs/desktop/dev-deep-link.md:3` 冲突；Lite 文档改为历史说明后，`docs/architecture/unified-zcode-lite-server-multi-server-plan.md:34` 仍引用已删除的“当前普通 Web 支持边界”。

**测试证据**

- 我的独立 distribution 运行（Node 24.14.0）：11/17 通过；6 个 runner 测试在断言前因只读沙箱 `mkdtemp EPERM` 中止；Vitest 因 `.vite-temp` 写入 `EPERM` 无法启动。均为环境限制，不是断言失败。
- 主控复跑日志复核：distribution 17/17、Vitest 83/83、typecheck exit 0、lint 303 warnings/0 errors。
- Full `architecture:check` 为 exit 1；2 项违规与 `033f` 基线一致，不宣称 full gate 通过。
- 未执行真实出包、CI 上传、UI/E2E 或生产动作。只读环境未写 `docs/plans/zody-rename-execution/reports/R10.md` 或源码；现有 R10.md 为 Terra 报告。
