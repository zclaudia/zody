# R20 runtime A + CUA 实施记录

源码基线 `2d9e7d398037df3c42ad7b97fe1eed8713196701`；实施期间 HEAD 前进到 `cc19c32b91bb1ea80e9a7018d3b87b48f8e3d3e6`，该提交由主控独立处理 Docker 和元数据，不包含本批 TS/JS 改动。本批未提交；未安装、使用 Docker、新建 worktree、修改冻结 native 材料或发布。

先补充 `specs/zody-brand-residual-cleanup.md` 的内部绑定与外部契约规则，再补 CUA 动态导出行为测试；该测试在旧导出上失败，在新 JS、d.ts 和 services 消费者同步后通过。按照现有 TypeScript 绑定重基 491 项，并对 47 个手工分诊项同步其绑定、真实动态导入、mock、schema receiver 和内部依赖注入消费者。`RunDependencies` 和 endpoint resolver 是内部依赖注入属性，调用方和测试一并改名。三个短名 `zcode` 仅更改所绑定的局部变量，保留 `meta.zcode` 等外部字段；保留 `Error.name` 字符串及其断言、ServiceChannels、环境变量、wire、持久化和插件外部身份。未把其他组的独立声明并入本批。

538 条每条的新声明、原绑定引用计数和当前同名声明检查见 `output/zody-rename-r20-runtime-next/runtime-closure/538-record-audit.json`；538 条均可在原声明文件找到新声明。101/104/611 有同文件其他 `zcode` 属性或声明，逐项记录且未做全局替换。47 项动态与字符串分诊见 `manual47-audit.json`，初始绑定和 491/47 应用明细分别见 `plan.json`、`applied-base.json`、`applied-47-bindings.json`；`unresolved-current.json` 记录额外消费者补齐前的定位，不是剩余错误清单。扫描中 native 冻结副本与无关独立声明未改。初始 `dep-refs-service.json` 保存代表性引用查询。

图谱仅改 7 个实际已改声明的 symbol 叶子；解析比较保持 372 nodes、726 edges，其他叶子相同。完整 leaf 路径和值见 `graph-leaf-diff.json`。dev-docs 协议说明的 21 个实际源锚点同步；清单为 `static-consumers.json`。未修既有失效 seeds。所有 288 个 tracked 变更文件对源码基线的 before/after SHA-256 见 `file-hashes.json`；此清单不含本新报告与主控的独立提交。测试标签的 17 个精确变化见 `test-titles.json`。

真实命令、参数、退出码与日志路径见 `commands.json`。根 `pnpm typecheck` 通过；`pnpm lint` 退出 0、303 warnings；changed architecture 0 violations。CLI `build --force` 23/23、0 cached，CLI typecheck 34/34。根目标回归 7 文件 120 测试通过，CLI 正确的 node:test runner 212 测试通过，dev-docs graph 4 测试通过。bootstrap 动态工厂测试在混合调用中 5/5 通过，但单独调用两次均有同一测试在既有 5000 ms 限制超时（各 4/5 通过），原因未归因，不能宣称稳定通过。混合调用时误将两份 node:test 文件交给 Vitest，Vitest 报无套件；随后用包脚本相同 runner 实际通过，原日志保留。未运行全量 CLI 测试、桌面 E2E 或发布流程；本批需由主控审查冻结并处理该超时证据。

补充固定祖先对照：在独立 clean 树 `7c4ff9113680a38e273032b09bee32ee6ba399af` 的 `apps/zody-cli`，使用同一 Node 24.14.0、pnpm 和 `pnpm exec vitest run packages/bootstrap/tests/provider-runtime-headers-cancel.test.ts` 单次运行退出 0，5/5 通过（整套 tests 用时 5.59s，transform 4.84s）；日志 `bootstrap-baseline-7c.log`。它是祖先而非 2d 同源码基线。测试直接链为测试动态导入 `workspace-model-runtime.ts`，调用 `createWorkspaceZodyApp`，注入 mock `createZCodeApp`，并通过 `createProviderRuntimeHeadersPort` 校验请求；该模块还静态导入 shared schema、storage、slash-commands 和 model-config 等，故动态导入会加载较大依赖链。7c→2d 的测试及两个直接模块 diff 见 `bootstrap-7c-to-2d-direct.diff`，这些直接文件上的差异为 TypeScript 类型名称；锁、CLI vitest 配置和 bootstrap package manifest 在两个固定提交间无差异。2d→候选直接 diff 见 `bootstrap-2d-to-candidate-direct.diff`，包括同源 schema 标识符以及动态工厂、server 和消费者的同步重命名，工厂函数体逻辑未改。候选单独运行两次 transform 分别约 5.91s、6.68s，并在测试 5s 限额超时；混合运行中候选该文件通过。该对照不能排除改名影响导入/转换耗时，也不能证明回归或既有问题，需后续固定候选同环境复核；未更改超时阈值。

R10 阶段诊断将首项内动态导入计为 4877.75ms，工厂调用约 0.40ms，两次 mock refresh 约 1.17ms，证据位于 `runtime-closure/bootstrap-diagnosis/`。该文件无 `vi.mock`、`vi.doMock`、`vi.resetModules` 或模块重置边界，首项的 `vi.fn` 和 Date spy 都在调用阶段创建，因此将固定工厂导入移到测试文件模块加载阶段；保留业务调用、断言及 5000ms 限制。修改后同一 CLI-root runner 单次退出 0、5/5；模块 import 5.70s、测试 973ms，日志 `target-bootstrap-static-import.log`。此前两次超时和祖先结果仍保留，未把新结果写成旧运行通过。

主控扩大根测试发现 `agentProxyEnv.test.ts` 的源码结构断言仍使用旧的内部 `resolveCurrentZCodeEndpointOrigin`，本批将断言及其说明改为现有 `resolveCurrentZodyEndpointOrigin`，同时把反例注释中的 `resolveRuntimeZCodeEndpointOrigin` 改为当前函数名，反例与验证意义不变。对 538 条 A 名称扫描当前 TS 测试字符串，剩余 3 处均为应保留的外部 `Error.name` 断言，见 `test-string-audit.json`；另检视包含旧名的源码式断言，`mobileRemoteDialogSurface.test.ts` 的 `services.zcodeTaskService` 与现行源码一致，不能改。该单项测试等待主控串行 wrapper 结束后复跑；已有全量测试失败记录保持原样。

主控串行 wrapper 完成后，`pnpm exec vitest run packages/services/test/agentProxyEnv.test.ts` 实际退出 0、21/21；日志 `agent-proxy-source-assertion.log`。hash 清单排除主控并行登记的 `r20-authorized-scope.json` 和 `r20-symbol-migrations.json`，仍为本批 288 个 tracked 文件。
