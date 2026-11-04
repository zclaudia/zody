# R22 暂停后验收：7089

固定候选 `7089ad3e095ec10727772107100d3e019b78d456`，tree `1ead5e111067d8f3ba284a566051030ddf927182`；复用 `output/zody-rename-r21/license-clean-9d135318` 安装及构建，执行前后 Git 状态为空，未安装或修改源码。原 `final-static-7089/user-interruption.json` 明确记载 unit 因用户暂停而中断，不能作为通过；原 typecheck、lint exit 0，全量 architecture exit 1（缺 gen-ui contract test、pluginUiBridgeService 404 行）及 knip exit 1 保留。两项 architecture 在 ad859 同样出现，但仍是实际失败。Knip 分类及非冻结 `packages/desktop/test/mcpZodyAgent.test.ts:5` 缺 `../src/mcp.js` 的旧问题见其他归因证据，不能把整份 knip 当作改名回归或通过。

本次实际运行使用 Node 24.14.0、pnpm 10.33.2 实二进制，cwd 为上述验证树；`resume-7089/results.json` 保存完整绝对 argv、退出码和时间，输出同目录。短隔离 `/tmp/z22r-0nujumo_` 的 HOME、USERPROFILE、TMPDIR、XDG 与安全环境快照见 `environment.json`；CI=1，禁用 pnpm 自动管理版本，未安装依赖。各任务串行，进程组超时 1800 秒（unit）或 300 秒（其他），实际均未超时。

| 命令 | exit | 实际结果 |
| --- | --- | --- |
| `pnpm test:unit --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=<evidence>/unit.vitest.json` | 1 | 1793 文件：1769 pass、21 fail、3 skip；15979 测试：15917 pass、42 fail、20 skip；525 秒。完整 JSON、stdout/stderr 保留。 |
| `node --test scripts/zody-distribution-runner.test.mjs scripts/zody-distribution.test.mjs scripts/zody-distribution-smoke.test.mjs` | 0 | 18/18 |
| `pnpm --dir packages/desktop test:macos-cua-narrow-resources` | 1 | 33/37；四项缺冻结 manifest 或 identity-pins。真实资源准备和签名留 R60，不能用旧资源冒充。 |
| `node --test packages/desktop/scripts/restore-cua-narrow-frozen.test.mjs packages/desktop/scripts/cua-desktop-session-bundle.test.mjs packages/desktop/scripts/cua-desktop-session-candidate-fetch.test.mjs` | 0 | 18/18；不证明真实签名或出包。 |
| `pnpm exec tsc -b packages/desktop/tsconfig.main.json` | 1 | 85 条 TS 诊断，与 ad859 原始 Main 日志规范化检出路径及连续引号 union 成员顺序后完整文本相同；有 11 行 union 顺序差异，不是原始输出字节相同，也不是 Main 通过。 |

21 个失败文件均出现在 ad859 的 34 个失败文件中，仅为文件级交集，不证明 42 条失败全同因。先前详细对照 `R22-failure-triage.md` 的 30 条完整归一化错误相同、其他未能对齐项与 `R22-watcher-single-case-diagnostics.md` 的波动仍保留原有边界。此次 stateStorage broadcast 及 watcher 15 项仍失败；`R22-resume-source-triage-7089.md` 对两条链路作有限源码比较，不能证明共同根因或排除所有改名影响。未确认改名回归不等于每条失败均已解释。真实 native 缺输入归 R60；其他未解释项需指定 owner 和处置，不能写成全量通过。

四目标真实构建及宿主 smoke 为 6fb 证据，不能称作 7089 重新构建；7089 的 server-cli 桥为独立构建/运行证据，构建关联和限制见 `R22-four-target-build-smoke-6fb.md`、`R22-server-cli-bridge-implementation.md`。strict 许可 19 项、其他平台执行和正式 Desktop 签名仍非发行通过。

首轮恢复 runner 错误继承用户 HOME，立即终止其进程组，保留 `unit.unisolated-partial.*`，无通过结论；其后重新以隔离环境完整运行。只读检查用户 `~/.zody` 与 `~/.zcode` 的近期路径/mtime/size 保存于 `user-home-recent-metadata.txt`，应用日志与图形缓存有近期变化，缺运行前快照且用户进程可能同时运行，不能归因；未读取内容或删除。停止后进程快照未见旧 runner/组或其可见测试后代，隔离任务完成后未见该临时根相关进程。

**建议：** R22 全量与架构仍为失败，不能标记全面通过。可由主控在登记 watcher/stateStorage 未解释边界、旧 knip/Main 问题和 R60 缺资源后，按计划明确接受有条件进入 R30 的实施风险；若计划要求所有失败先完全归因，则仍应暂停该阶段，不能用本报告自行改变门禁。严格许可与签名属于发行边界，不应冒充已完成。

逐项对照：`resume-7089/case-comparison.json` 列出 42 个失败断言的完整 case、当前 failureMessages、ad859 同文件同名失败标志。39 个同名在 ad859 首次全量也失败，名称相同不证明错误详情或因果相同；三个 watcher case 在 ad859 首次全量没有同名 FAIL：`user rename reaches both Hosts when the real directory is AGENTS`、`keeps user scans and native updates limited to direct files`、`keeps project scans and native updates limited to direct files`，保持未解释，不能由文件级重复自动归为旧故障。套件加载失败另在 `unit.vitest.json` 保留，不混为失败断言。具体同错误证据仅使用之前逐条比较，不从本次名称匹配扩张。

状态链路后续 owner：services/Gen UI state storage 与 subagent Host watcher 各自的维护者；在后续测试可靠性任务中分别按 `R22-resume-source-triage-7089.md` 建议的有界事件插桩验证，保留原 timeout，不合并假定根因。当前已核实 Gen UI 相关实现及 key 代码同 blob；watcher scope/runtime/test 同 blob，storage/service 经内部符号映射，配置路径保持 `.zody`，这是有限链路证据而非全部依赖的因果证明。Desktop native 输入 owner 为 R60；Main 85 与 knip 非冻结旧问题交各自 Desktop/依赖维护 owner，最终发行前核对，均不能掩盖当前红测。

在上述已登记边界下，建议主控将 R22 的**改名解析与真实启动**按现有 6fb 四目标构建/宿主 smoke、7089 独立 server-cli 真实 stage 和本次两组 Node 18/18 作限定范围验收，允许 R30 实施；明确保留 fullsuite、全量 architecture、knip 与 Desktop Main 的失败和上述未解释事项，R22 不标为完整全绿。该建议不替代独立最终审查，亦不放行发行。
