# 独立只读复审

范围：worktree `/Users/zhvala/SourceCode/zody/.worktrees/zody-full-rename`，基线 277f9fb034e6485f4a998b22fb7c932185844e43，针对未提交 diff；本报告不代替全量验证及真实 GUI E2E。

- F1：PASS（限定源码及现有回归）。`packages/services/src/plugin-sync/pluginSyncService.ts:945` 只在 canonical ENOENT 时继续探测，JSON/结构/name 失败返回 null；正则与 `apps/zody-cli/packages/adapters/src/plugins/index.ts:112,963` 一致；归档导入先校验再落目标（service:464-505），测试覆盖候选及导入失败。
- F2：PASS（限定源码及现有回归）。`configured-runner-input.ts:148` 拒绝六种无上下文 ROOT/DATA 模板；`configured-runner-callback.ts:25-75` 在 shell command、argv file 和 args 构造时展开，在 executionPort.run 调用前抛错。回归确认无执行。
- F3：PASS（限定有 launcher 产品入口及模拟权限错误）。`official-plugin-runtime.ts:31` 共用读取函数仅 ENOENT 读 legacy；`:79-84` 确保 MCP legacy 同字节也提交 canonical；`:119-129` 验证对象与官方身份。复审新增 EACCES 注入、非法对象和已渲染 MCP 旧清单的断言；独立隔离环境运行 runtime 测试 12/12 通过，见 `runtime.log`。非 SEA 且无 argv 入口的嵌入形态无 launcher，不承诺 MCP 升级与零锁。
- F6：PASS（限定指定三个文件）。根配置包含三个目录并排除桌面 E2E；最终门禁脚本自身经 Vitest list 确认属于 unit 默认集合（`gate-list.json`）。独立隔离 HOME/TMP/XDG 执行 `pnpm exec vitest run scripts/test/zody-rename-plugin-test-collection.test.mjs`，2/2 通过，内部实际运行 related 及验证 E2E 排除（`gate-vitest.log`）；旧版 Node 测试证据 `collection.log` 留作历史。该检查不证明真实 E2E 或整个 affected diff 入口已执行。affected 脚本仅识别 packages/ 变更，单独改 scripts 下门禁不会触发 affected；门禁自身由根默认集合持续准入。
- F4/F5：对应 transport 和 subscription 源码不在审查 diff，按要求保留既有问题，不评为通过。
- 文档：已指出的 test-map 旧 CLI 路径与变量已由主控更正。

复审结论：指定修复范围未发现剩余可操作问题；根默认扩大收集范围后的既有测试失败与全量检查结果由主控核实并报告，不在此独立测试通过结论内。
