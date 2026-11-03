# R20.4 完整类型批：主控复核

基线 `3cb3a0050fb47771305fe084852fc6aed994eb92`。600 条历史清单记录中，本批处理 565 条绑定记录和 27 条人工闭合记录，8 条此前已迁移。主控逐项核对 695 个文件的基线与最终 SHA，全部与候选审计一致。694 文件等于联合补丁结果；dev-docs 另有两处明确授权的 source fragment 修正，指向实际声明所在文件。

主控审阅三个 interface/const 描述符及注入键、动态导入解构、缺失 public type re-export，保留现有 ServiceChannels 与外部值。Terra R10 前置只读审查发现的两个文档路径问题已经修正，未改历史 native 材料。清单按声明记录，不把 type/value 合并条目重复数解释为独立公共契约数。

主控独立实际验证（绝对 Node 24.14.0 / pnpm 10.33.2 工具链）：

- 根 168 文件、1,914 项断言全部通过；首次整体命令退出 1，因为 `localServicesRemoteAuthority.test.ts` 结束时发生 Vitest `EnvironmentTeardownError: Closing rpc while onUserConsoleLog was pending`。随后单独运行该文件 9/9、再单独运行完整 168 文件 1,914/1,914，均退出 0。没有为重跑修改源码或延时吞错；原失败日志保留，具体触发异步任务尚未确认。
- CLI bootstrap 6 文件 45 项、CLI Node 2 文件 176 项、dev-docs 7 文件 18 项全部通过。
- 根 `pnpm typecheck`、`pnpm lint` 退出 0；lint 303 warnings。CLI 全包强制 build 23/23、强制 typecheck 34/34、零缓存的实际记录来自 Terra 报告。
- 主控实际单独运行 Desktop Main 类型检查，退出 1、85 条诊断。整份诊断文本仅归一已登记类型名及 quoted/ArrayBuffer union 顺序后，与此前主控基线完全一致；不把它当成通过。
- 主控实际运行增量架构检查，退出 1，触达原有 `pluginUiBridgeService.ts` 404 行超限。该文件按本批类型名归一后与基线逐字节相同；保留原布局，不删空行掩盖违规。

独立日志为 `output/zody-rename-validation/controller-batch04-{root,teardown-target,root-retry,cli,node,docs,types,lint,main,architecture}.log`；根测试精确 argv/退出码在 `controller-batch04-root-command.json` 和 `controller-batch04-retry-commands.json`。Main 全文比较在 `controller-batch04-main-comparison.json`。根 Vitest 4.1.4 与其 importer 一致；CLI Vitest 4.1.7 和 patch 属 CLI importer，未为了复验更换依赖。

根目录测试退出竞态仍是一项测试稳定性限制；现有异步 provider 启动/日志链只是有源码依据的候选原因，不能写成已证实根因。后续运行时符号、现行注释/文字残留、完整 R21/R22 及发布门禁仍未完成。本批冻结后交独立 DeepSeek 审查，不代表全仓改名验收完成。

审查收口：DeepSeek 对固定3cb→677返回 scoped PASS。`architecture-retest.log` 是曾临时删除四个空行时的中间结果；主控已拒绝该处理并要求恢复，最终候选与基线布局一致，实际采用 `architecture-final.log` 和主控退出1记录。保留原始中间日志用于审计，不把它作为最终通过证据。Main 比较的原始基线仍为此前独立构建记录；本批没有重新构建3cb独立快照，严格复现时需按其已记录命令重新生成。当前错误文案/注释中的旧类型名另入后续文字清理。
