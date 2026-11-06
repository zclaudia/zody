# R20.4 basename 只读预检（未达可应用门槛）

基线 `6720cfe22b8e16e6abcc4abbeee0d084f17594cb`。本轮只写 `output/zody-rename-r20-basenames/` 和本报告，未修改产品源码、锁或生成声明。198 个候选中 `zcodeAgentProcessManager.ts` 及其测试已由前批迁移；其余 196 个路径在基线存在，目标不存在、无 casefold 碰撞。

逐项清单位于 `per-candidate.json`：86 个内部源码、107 个内部测试、3 个语义复核候选。经阅读，`conversation-session-workspace-zcodeignore.test.ts` 主要验证 `.zodyignore`，可归内部测试；`legacyZCodeConfigProviderReader.ts` 和对应测试涉及上游 legacy 语义，basename 是否应保留需主控裁决，不能根据拼写断言。151 个 `manualReviewPaths` 仍排除；受保护文件和 native 冻结树未授权内容一律不作为写目标。

`inventory.json` 列出 3317 条原文命中及候选映射；`safe-module-edits.json` 是保守解析出的 139 个文件、265 处精确 import/export/require/mock 字面量旧→新路径预览。它不是完整补丁：`unresolved.json` 仍有 3052 条需要分类的命中（1934 条位于保护/历史/文档/范围外，1118 条位于其它上下文；粗分 666 标识符或其它、349 含引号、103 注释）。名称相同不意味着可改：如运行时字段 `zcodeAgentService` 应保留；`packages/desktop/scripts/desktop-main-entrypoints.mjs` 的 worker 源文件路径与输出键须分别裁决；CLI `package.json` 测试 runner 和 dev-docs source 展示也必须按具体路径审查。

`dynamic-candidates.json` 列出 3730 条含动态路径构造、import/require、join/resolve 或文件操作的候选行供人工确认；它是过量搜索结果，不表示每项都引用待迁移文件，也不能证明动态引用已闭合。二进制及非 UTF-8 跟踪文件 237 项列在 inventory，不能据文本扫描声称零引用。`inventory.py`、`plan.py`、`dynamic-audit.py` 可重现当前只读预览。`apply-reviewed.py` 只做基线、哈希、写范围和碰撞预检，缺少审定的 `reviewed-plan.json` 时明确拒绝；它故意不执行任何写入。当前没有经过审定的完整补丁，不应启动一批自动移动。

建议后续唯一写者先逐条核销 349 条引号命中及真实动态消费者、静态导出/runner/配置与当前文档引用，明确 worker 路径和对象/协议值边界；对其余标识符和历史来源记录保留理由，然后生成逐文件 SHA 和精确行列补丁，再重新检查目标碰撞。验证需覆盖根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，目标服务/UI/shared/CLI 测试及 E2E runner 路径；生成声明须由真实构建工具重建并交相应所有者，不能编辑 `.d.ts` 或引用旧 dist 充当证明。该预检未运行产品构建或测试，也不声称 R20.4 闭合。

## 追加：可应用的安全子集

- `output/zody-rename-r20-basenames/source-batch.patch`：25 个源码文件改名、34 个消费者文件中的 54 处已解析相对模块引用更新。只替换经原位置解析到具体目标文件的 import/export/require/mock 字面量；不修改同名符号或运行时值。移动详情在 `source-batch-moves.json`。
- `output/zody-rename-r20-basenames/test-batch.patch`：74 个测试/测试 helper 改名，其中 73 个没有除历史计划以外的同名路径命中；另一个 helper 的 10 个明确 import 已同步。包含经源码确认验证 `.zodyignore` 的测试。详情在 `test-batch-moves.json`。
- 两份 patch 在基线工作树分别 `git apply --check` 退出 0；另以基线 git archive 建立仅供验证的隔离副本，先实际应用源码 patch，再对测试 patch 执行 `git apply --check` 并实际应用，均退出 0，99 个目标均存在且原路径均消失。主工作树没有应用 patch。建议后续按此顺序应用。
- `remaining.json` 为 34 个测试、61 个源码及 2 个 legacy 身份复核候选，逐条包含当前扫描到的精确文件、行与原文证据；2 个先前已迁移候选另列在 inventory。部分证据是历史资料、feature graph（R21）或注释/运行时身份，不应机械替换。`dynamic-narrowed.json` 保留涉及相关目录或名称的 1470 条过量候选；对上述 25 个源码的完整 basename，在动态候选中未发现相同文本，但分段拼接等不可静态断言的路径仍须结合运行时和具体调用方审查。
- 两个 patch 均未运行产品测试，且仅验证其可应用性，不代表安全组已通过集成。应用后应运行目标包测试、根 typecheck/lint/changed architecture，并验证包含测试文件名的 runner 配置；全量剩余消费者、当前文档与动态引用仍待逐项闭合。

`remaining-owned.json` 对每条剩余证据列出初步责任：R21 protected graph、历史/来源保留、现行文档、runner/audit 路径、worker source/output 或具体身份待审；分类仍须唯一写者逐项核对。增加的四个安全源码只有 protected graph 或历史来源引用，图内容仍交 R21，不在 patch 中修改。
