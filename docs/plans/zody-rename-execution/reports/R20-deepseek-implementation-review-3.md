# R20.3 independent review 3

Candidate: `854ddf60ac1be92428e3c32192ee325aab6acd25`.
Reviewer: DeepSeek (`deepseek-flash`), read-only.

**结论：PASS**（仅限 R20.3 二审修复范围；不代表 R20/P2 整体完成）

**审查范围**
- 只读固定候选 `c62caae2..854ddf60`，全部内容来自 `git show`/固定 diff，未读取后续变动工作树作为候选，未写源码、未 install、未改锁/冻结资源。

**通过证据**
- `apps/zody-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:317-324,351-358` 已同时保留旧 staged 候选并加入 `packages/zody-*`、`../../../zody-*`。按实际 `candidateBaseDirs()`：`apps/zody-cli` cwd 命中 `packages/zody-*`，bootstrap `src/app`/`dist/app` 命中 `../../../zody-*`；旧 `resources/glm/packages/zcode-*` 仍保留。
- `apps/zody-cli/packages/bootstrap/tests/bundled-plugins-resilience.test.ts:162-183` 是实际 seed 集成测试：调用 `resolveOfficialPluginRoots()` 后检查 guide 与 computer-use 的缓存 manifest，不是只断言数组。当前源码目录确有对应 `.zcode-plugin/plugin.json`。
- 四个源树测试路径已改为新目录：`dynamic-workflow-skill.test.ts:51`、`zody-guide-path-contract.test.ts:15`、`computer-use-onboarding.test.ts:20`、`mcp-server.test.ts:338`。旧 staged 身份断言未被误改。
- `packages/ui/src/lib/builtinSkillI18n.ts:41-43` 已补 `/zody-guide-plugin/`，`skillsSection.test.ts:773-786` 覆盖无 `pluginName` 时新源码路径和旧 staged 路径两种 fallback。
- `apps/zody-cli/packages/cli/scripts/build-sea.mjs:60,190` 与 `build-sea.test.mjs:1030-1056` 已将 SEA blob 生产/参数路径统一为 `zody-${target}.sea.blob`；postject 消费者仍通过 `seaBlobForTarget()` 取得同一路径。
- 候选 diff 未触及 lock、third-party inventory、feature graph、native/frozen、trust 或外部 marketplace/MCP 身份。`R20.md` 已补充“全量架构仍有两项基线失败”，未冒充全量通过。

**未验证/剩余**
- 未运行真实 SEA 出包或跨平台产物验证；当前只有静态路径和参数测试证据。
- 全量 `architecture` 仍有两项基线失败；`--changed` 通过不等于全量通过。
- R20.4 内部符号/basename、ProcessManager 旧 mock 路径与模块导出 key、R21 bin links/生成 inventory/clean install 仍未完成；本候选未将它们判为完成。
- 新增 seed 测试实际验证的是新源码路径；旧 staged 候选只被断言为字符串，未在该用例中实际以 `resources/glm` 布局执行 seed。此项是覆盖缺口，不是当前阻断。
- 本轮未独立重跑测试；controller 记录的 71/71 CLI、12/12 UI、43/43 SEA 结果作为报告证据，未由我方再次声明为运行通过。

非阻断报告文字问题：`R20-3-review-fixes.md` 写“未提交/未触及任务账本”，但候选本身已提交且包含 `task-ledger.md` 变更；若这些变更来自 controller，建议注明作者，避免审阅记录歧义。
