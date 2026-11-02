# R20.4 符号报告

状态：首个候选已固化为 `6720cfe2`，并获 DeepSeek 限定 PASS；R20.4 全量改名尚未完成。当前候选基线 `854ddf60ac1be92428e3c32192ee325aab6acd25`；具体授权以 `r20-authorized-scope.json` 的 substep4 与 manualReviewPaths 为准。

## 历史准备记录

以下段落记录基线 `c62caae2a32fb369a1d5b3b8679d7310b320a5a5` 上应用前的只读准备；状态和验证以“当前首个稳定候选”章节为准。

首批提案 `output/zody-rename-r20-symbols/batch-01.patch` 涵盖 `ZCodeRuntimeEnv` 与 `ZCodeAgentCommand` 两个公开类型、10 个源码/测试文件、43 个语言服务引用；跨 shared/services、Desktop、Server 测试和 CLI 独立子包。排除 manualReviewPaths、生成 `.d.ts`、runtime 键、shorthand、env 和协议字符串。`git apply --check` 成功，未实际应用、编译或运行测试。引用依据和逐文件摘要在 `batch-01.json`、`ZCodeRuntimeEnv.semantic.json`、`ZCodeAgentCommand.semantic.json`。

工具通过 ts-morph 引用及词法命中文件比较，无法保证旧 dist 与源引用绑定一致；并非所有字符串、反射、动态 import 或文件路径可被语言服务发现。生成声明应核实生成器并由真实源码重建；manual skill/fixture 路径留给 R20.5 单独判定。后续符号在共享项目上下文按依赖组串行解析，shorthand 保留外部键，成员和无法绑定的内容进入人工复核，不能盲目替换。重验需真实根与 CLI 工作区 typecheck、相关测试及全部源码/生成引用检查。

后续准备：`batch-02.patch` 包含 ProcessManager 的五个纯 type/interface、8 文件、60 个语言服务引用；与首批一起执行 `git apply --check` 通过，均未应用或编译。`identifier-coverage.json` 对七个类型逐 identifier 位置核对无遗漏；class `ZCodeAgentProcessManager` 有 20 个未绑定的对象属性标识，抽样属于 `vi.doMock` 的模块导出键，应在改导出时同步，不能当普通持久属性自动保留。另发现同一 mock 的旧目录字符串，已交当前路径修复写者核对。生成声明、动态导入与 CLI/root 的真实编译验证仍未完成。

## 当前首个稳定候选（基线 854ddf60）

已应用 `process-manager-closure.patch`、源码/测试 basename 两个移动，以及 runtimeEnv 五个已解析函数的源码/引用改名；`candidate-file-list.json` 精确列出产品源码、测试及生成文件（旧/新路径分别列出）。`remaining-candidates.json` 是旧候选的粗核对：1602 个仍有词法命中的声明候选、196 个未处理 basename；它不是绑定引用覆盖或完整余量证明。pure `createLocalServices` 注入属性以及其测试 mock/反射应在后续组单独按声明、读写与序列化边界闭合，不以所有属性为由一概延迟。

声明生成：`output/zody-rename-r20-symbols/declaration-source/tsconfig.json` 继承 Desktop main tsconfig，以最小 files、DOM lib 和 shared reference 隔离输出；源码副本与项目 node_modules 链接均在 output 下。`pnpm exec tsc -p output/zody-rename-r20-symbols/declaration-source/tsconfig.json` 退出 0（`declaration-source.log`）；完整对照仅声明两处类型名及 source map 映射变化。真实输出复制到已授权的源码邻接 `.d.ts` 和 `.d.ts.map`，map 的 `sources` 为 `["armsRumShared.ts"]`。SHA256：源码 `f1f8e89e9d10ef116ddabea927f611426b521c6ab83d9936cdd9210bcc36c077`；声明 `9831f30089a00a29fd6203e2bcc9f6470093264e36134c8b7408041eac13cf3c`；map `4ee36c86cdcba1d57d7f8e27fb738695b6e76957a877b976922f95d40a7cd7bb`；隔离 config `e164b7f5d8097b9c2c99306c47f448c733b12f6110b4be0b1f2c5a3bbf610821`。

验证 cwd 均为实施工作区根：`pnpm typecheck`、`pnpm --dir apps/zody-cli/packages/cli exec tsc --noEmit`、`pnpm lint`、`pnpm architecture:check --changed` 均退出 0，lint 303 warnings；完整输出分别在 `typecheck.log`、`cli-typecheck.log`、`lint.log`、`architecture-check.log`。`pnpm exec vitest run packages/shared/test/runtimeEnv.test.ts packages/desktop/test/armsRumShared.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts` 三个文件共 47 通过（`runtime-tests.log`）。根 typecheck 覆盖根脚本列出的 TypeScript 项目；CLI 命令只检查 `apps/zody-cli/packages/cli` 包，不能称为整个 CLI workspace 的类型检查。首轮目标测试 9 文件 164 通过、2 个 ProcessManager 旧目录夹具失败；修正两个分段路径后单文件 66 通过（`initial-target-tests.log`、`process-manager-retest.log`，两份为工具输出摘要并注明，不冒充完整日志）。源码旁 `genUiOutputEnv.test.ts` 不被默认 Vitest 项目收集，以 `pnpm exec vitest run --config output/zody-rename-r20-symbols/vitest-source.config.mjs` 显式运行时原断言 `.zcode` 与实际 `.zody` 不一致；更新该路径断言后 1 项通过（失败及复跑完整日志 `source-test-explicit.log`、`source-test-retest.log`）。

额外 Desktop main tsc 退出 1，完整诊断保存在 `desktop-main-tsc.log`；独立 854 基线复核归一化后 85 条诊断相同（`output/zody-rename-main-baseline/`），只证明所比较快照无新增该配置诊断，不代替项目主线通过。R20.4 尚未完成；本组已由主控固化为 `6720cfe2`，不宣称全量符号/路径改名完成。

DeepSeek 对固定首组 `6720cfe2` 给出限定 PASS，见 R20-symbols-deepseek-review-1.md；不代表全量 R20.4 或 P2 通过。
