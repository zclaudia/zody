# R20.4 第三批符号：主控验证

基线 `1b042046c373fa91c5ed80b1501bcf0677f2eb39`；25 个声明、27 个源码/测试文件，以及 DeepSeek 要求的一个审计脚本修复。精确文件 SHA 与声明映射分别见 `output/zody-rename-r20-symbols/batch-03/{candidate-file-list,batch-manifest}.json`。候选 SHA 在后续账本登记。

主控复核 28 个文件与实施者记录的 SHA 一致；对 27 个 TS/TSX 文件使用 TypeScript parser 获取 Identifier 范围，将登记的新名还原后与基线逐字节比较，全部相同。字符串、模板、注释、空白及其他源码均未改变；模块 mock 的导出键与其真实导出一起改名。证据 `output/zody-rename-validation/controller-symbols-03-ast-audit.json`。先前独立 scanner 校验无法正确重扫模板 token，结果已被 parser 检查替代，没有据此声称产品存在差异。

审计脚本恰好只有 `zcode-agent-policy` → `zody-agent-policy` 一处匹配值变化；未添加泛化白名单。主控实际执行 `node scripts/audit-zody-agent-remnants.mjs --json`（Node 24.14），退出 0，命中 `packages/shared/src/zody-agent-policy.ts` 的 category 为 `compat-type`；完整结果保留于 `controller-symbols-03-remnants.json`。此项修复 basename 候选的 DeepSeek 阻断问题，仍需审查新候选，不能将旧 CHANGES_REQUIRED 改写成 PASS。

主控在固定 Node 24.14.0、pnpm 10.33.2 下实际复验：

- 9 个目标测试文件，191 项通过，退出 0；实际 cwd/argv 见 `controller-symbols-03-test-argv.json`。
- `pnpm typecheck`：退出 0。
- `pnpm --dir apps/zody-cli/packages/cli exec tsc --noEmit`：退出 0；仅代表该 CLI 包检查范围。
- `pnpm lint`：退出 0，303 warnings、0 errors。

日志位于 `output/zody-rename-validation/controller-symbols-03-{tests,typecheck,cli-types,lint}.log`。Terra 另执行当前未提交 diff 的架构检查和真实 Server clean build，均退出 0；本轮主控未重复 Server 构建，不能写成主控独立产包。

Desktop Main 仍退出 1、85 条诊断。主控将完整日志与独立旧基线逐条比较，仅归一化准确 checkout/已登记 basename 路径、连续引号字面量 union 顺序以及实际工具链 banner/退出码记录，两份完整诊断文本一致；未用仅错误码或数量相同代替验证。证据 `controller-symbols-03-main-comparison.json`。Main、Desktop clean 输出和 CUA 冻结材料仍未通过相应阶段门禁。

同时审阅六份明确授权当前文档的修正：五份实际变化，一份历史测试记录保持原样。当前产品/包/源码引用与历史原生二进制、旧测试记录、未来 Lite/Hub 假设分开；对未实现构建文件不再提供现行入口暗示。主控在符号批冻结后，将 Electron runtime 文档两处 resolver 引用同步为本批真实新名。文档报告 `R20-current-docs.md` 保留其基线及后续同步说明。

R20.4 其余声明、剩余 basename、人工审查151路径及后续阶段仍未完成。本报告不作 P2 或发布通过结论。
