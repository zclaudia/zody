# R20.4 basename 第二批 DeepSeek 独立审查

固定候选：`e79eab7d35ba576140ff57698ca0fff122629366` → `1b042046c373fa91c5ed80b1501bcf0677f2eb39`。路由 `deepseek-flash`，read-only；以下保留审查原文。

**结论：CHANGES_REQUIRED**（仅 1 条阻断，修复面一行）

**阻断问题**
- `scripts/audit-zody-agent-remnants.mjs:89` 的 `compat-type` 白名单仍写 `zcode-agent-policy`，但本批已把该文件移到 `packages/shared/src/zody-agent-policy.ts`。该脚本按“当前相对路径”分类（`classifyFile`），且新文件含 `claude/opencode/gemini/codex` 关键词（`packages/shared/src/zody-agent-policy.ts:15`），所以移动后会从 `compat-type` 掉入 `unclassified`。脚本由 `package.json:23` 的 `audit:agent-remnants` 实际使用；默认调用不带 ratchet 不会非零退出，但分类契约已失真，任何 `--max-unclassified` 门槛都会因此新增 1 个未分类。
- 最小修复：把该行 `zcode-agent-policy` 改为 `zody-agent-policy`（`zcode-agent-model-state` 仍需保留，该文件尚未移动），将 `scripts/audit-zody-agent-remnants.mjs` 纳入原子候选，并在隔离环境复跑一次 `--json`，确认 `zody-agent-policy.ts` 重新归入 `compat-type`。修复后本批可复审 PASS。

**非阻断（记录，勿丢失 owner）**
- `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml:651,653,979` 仍指向本批 3 个旧路径。该文件属 R21 生成物（R21.1 在 `6c7bd1c` 已先于本批执行），应作为 R21 后续再生成项，不能算本批遗漏。
- `r20-basename-migrations.json` 第二批仍为 `candidate:null/review:null`，`R20-basenames-implementation.md` 仍写“尚未提交”，与 `1b042046` 已固化不符，属账本/报告收尾。
- 暂缓的 `conversation-session-workspace-zcodeignore.test.ts`（basename 派生 caseName）仍待命名解耦后回归；Desktop `out/main` 新旧并存、Main 85/85 基线、CUA manifest 缺失属 R22/R60，不作本批发行通过依据。

**静态核查范围（我实际执行）**
- 98 个旧路径在候选均不存在、新路径均存在；89 个字节相同，9 个仅改审定模块路径；25 source + 73 test/helper 与 diff 一致。
- 36 个修改的非文档产品文件逐行检查：所有变更行均为引号内相对模块路径/`#src`，未改符号、env/define、wire、telemetry、插件身份、锁、native/frozen、历史文档；`git diff --check` 通过。
- 我未重跑测试或构建；575/211/103、92 对产物、Main 85/85 归一化一致均为候选附带日志证据，不据此宣称运行或发行通过。
