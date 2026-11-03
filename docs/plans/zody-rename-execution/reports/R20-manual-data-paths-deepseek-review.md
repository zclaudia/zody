# R20.5 manual data paths: independent DeepSeek review

Fixed base f28dfddc → candidate 83680ddc; reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19cdb-5be9-73f3-9b21-930b5c45f36a`, read-only. Raw response below.

**结论**
`CHANGES_REQUIRED`（仅测试证据缺口；固定候选的产品实现和授权范围本身未发现产品代码错误）。

固定审查范围为 `f28dfddcbd4e646d7fa93d2e593b91a62063b2b6` → `83680ddc523fb95a06512ea43fc62c5a5b1ccb75`。

**审查证据**
- diff 共 19 个文件：9 个 `substep5ManualDataPaths` 写入文件、1 个 audit 修改、9 个计划/报告/ledger 等 bookkeeping；未发现 package/lock、env、wire、provider 键、冻结资源或本批之外的产品源码改动。
- 大型 fixture 的 DB、manifest、备份均改为 HOME 下 `.zody`；未新增配置探测、迁移或命令行选项。
- restore/scan 默认目标改为 `.zody`；scan 的旧快照默认源仍是 `~/.zcode/v2/sessions`；`--snapshot`、`--legacy-dir`、`--task-index`、`--cli-db` 的解析语义保持。
- `ZCODE_PROVIDER` 仅为局部变量改名为 `ZODY_PROVIDER`，值仍为 `"glm"`；序列化 agent/provider 键和值未变。
- 两份 E2E metadata 仅把 `.zcode/cli` 改为 `.zody/cli`，对应 spec 使用 `.zody` 路径；这是静态核对，未运行 WDIO。
- audit 改动精确为 `scripts/audit-zody-agent-remnants.mjs:99` 的 store 前缀；当前六个 store 文件名均为 `zodySessionStore*`，且原有宽泛 UI 规则仍先命中，分类不变，未增加旧名兼容分支。

**测试证据**
- `scripts/test/zody-manual-data-paths.test.mjs` 使用临时 HOME/USERPROFILE、旧 `.zcode` 库和源快照，实际覆盖默认生成/删除、dry-run、默认 restore、scan，以及 `--task-index`、`--cli-db`、`--legacy-dir` 显式覆盖；旧库哈希和旧 snapshot 内容保持断言。
- 只读证据：旧实现 red 日志为 0/2，失败于旧目标路径/新库未写入；green 和主控日志均为 2/2 通过。主控报告 typecheck 退出 0、lint 303 warnings/0 errors、changed architecture 0 violations。
- **阻断项：** `scripts/test/zody-manual-data-paths.test.mjs:142` 只执行 `access(output.manifestPath)`，没有断言 manifest 位于 `.zody/perf-task-manifests`。如果实现回退到 `.zcode/perf-task-manifests`，该测试仍可能通过；因此实现报告的“覆盖 manifest”与测试实际证据不完全相符，也不足以证明 manifest 的真实 HOME 路径隔离。
- 建议仅补测试断言，例如检查 `output.manifestPath` 以 `join(context.home, ".zody") + sep` 开头并包含 `perf-task-manifests`，然后重跑 2/2；不需要修改产品代码。

**我实际执行与仅读证据**
- 实际执行：固定 SHA 的 `git diff`/`git show`/`git grep`/`git diff --check`；Node 24.14.0 对相关脚本、测试和 audit 文件执行 `node --check`，均通过。
- 我尝试运行 `node --test scripts/test/zody-manual-data-paths.test.mjs`，但只读沙箱在测试 setup 的 `mkdtemp` 处返回 `EPERM`，未进入测试主体，不能作为 2/2 实测证据。
- 未独立运行 typecheck、lint 或 architecture；上述结果来自主控日志和报告。
- 未 install/build、未加载 WDIO、未运行原生或跨平台 E2E、未操作真实 HOME。

**剩余限制**
- 测试使用简化 SQLite schema 和临时 HOME，不证明完整应用 schema、Windows/Linux、原生 E2E 或真实发行行为。
- `.agents/skills/zody-large-task-fixture/SKILL.md:21` 仍有 “From the z-code repository root” 的旧品牌表述；这是当前文档残留，非本批行为阻断。`docs/performance/v4-conversation-cold-hydration.md:528` 的旧技能名也属于范围外文档残留。
