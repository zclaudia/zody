# 改名与复审修复合入 main（2026-11-06）

用户追加“合并”授权本地提交与合并；没有推送、发布、部署或重新签名。原修复报告的“未提交”描述保留为当时事实，由本记录更新当前交接状态。

## 范围与父版本

- main 合并前：`d5b2cc28e04a437a6e3b5fb44023cc08869cf691`，操作前工作区干净。
- 改名候选原最终提交：`277f9fb034e6485f4a998b22fb7c932185844e43`。
- 已复审修复分别提交：`12146d131b25`（spec）、`01826e369fb6`（F1）、`c4fa52a74bac`（F2）、`eda933f54ed6`（F3）、`8d6d197974eb`（F6）、`fcd56d017b1729db0831b6b9075f1628536f7468`（验收与既有问题登记）。
- 合并第二父版本：`fcd56d017b1729db0831b6b9075f1628536f7468`；共同祖先仍为 `033f91783901e6adaf968d3d4b8ca34c41d89442`。
- 改名工作树保留；F4 UTF-8 分块解码、F5 在途资源订阅继续按[既有问题登记](independent-review-deferred-existing-issues.md)延期。

## 冲突解决与组合复核

保留 main 后续手机薄壳、原生 bridge/envelope、刷新保护、设置直接按钮、browser 下载回调以及启动 `providerDigestSha256`/selection/network 行为，适配公开包、目录、符号与协议新名称。已删除的旧 settings menu 不恢复。

自动合并后通过类型检查、定向测试及原生 Terra 独立审查查出并修正：ServiceChannels 描述符/attachment 编码旧符号、刷新 guard 旧 store 路径、Windows UI/renderer/preload/IPC 命令链旧标识、重连 hello_ack 旧 fixture、刷新恢复测试的旧 service key。菜单测试按新私有协议更新 fixture，locale 文案 ID 沿用已有键；测试断言的功能与边界不减弱。回调 `onZCodeEndpointChanged`、`isZCodeBusy` 沿用两个父版本已有接口，避免只修改调用侧字段。固定外部 gateway kind/capability、`ZcodeMobileBridgeHost` 与既定兼容键保留。

当前交付链：UI → renderer 平台服务 → preload → Main IPC/command handler；手机刷新 → 原 Host replayable attachment → 同一 runtime owner，desktop-continuous attachment 保留。没有增加状态 owner 或 admission 写入路径。

[Terra 独立只读报告](merge-main-terra-2026-11-06.md)包含问题与修复复核，未独立运行测试或真实设备连接；其范围不等于整仓重新审查。

## 实际验证

固定 Node `24.14.0`，使用已有依赖，隔离 HOME/TMP/XDG，合成数据。类型检查在候选源码精确副本运行，以免写入产品生成物；CLI 类型检查的依赖 build 在同一副本完成，后续 CLI 回归使用该本轮生成物。未安装依赖、未使用旧主线 CLI dist 作为通过依据。

| 检查 | 结果 | 日志标签（output/zody-rename-main-merge/logs/） |
| --- | --- | --- |
| 根 `pnpm typecheck` | exit 0 | merge-typecheck-frozen |
| CLI `pnpm typecheck` | exit 0，34 tasks | merged-typecheck-cli |
| 根 `pnpm lint` | exit 0，312 warnings / 0 errors | merge-lint-frozen |
| CLI `pnpm lint` | exit 0，14 tasks，保留警告 | merge-lint-cli |
| `pnpm architecture:check --changed` | exit 0，0/0/0 | merge-architecture-final |
| 插件同步、三 consumer 与实际默认/affected runner 门禁 | 5 files / 50 tests pass | merge-regression-gate-final |
| official runtime / seed-lock | 2 files / 15 tests pass | merge-bootstrap-built-source |
| Hook lifecycle（含 F2） | 23 tests pass | merge-hook-lifecycle |
| seven-events / on-error | 22 tests pass | merge-core-built-source |
| 主线 send-message / git-snapshot-hardening | 10 / 2 tests pass | merge-contracts-main / merge-adapters-main |
| 手机 gateway/native/shell/settings | 5 files / 90 tests pass | merge-mobile-groups |
| 桌面菜单、命令、IPC、跨刷新 replay 恢复 | 4 files / 39 tests pass | merge-desktop-commands-final |
| 手机 bridge/refresh/file/entry 与 file watcher | 9 files / 104 tests pass | merge-mobile-additions-final |
| broker helper、CUA runtime、startup digest | 3 files / 18 tests pass | merge-extra-contracts |
| 手机 Web release 构建合同（合成产物） | 13 tests pass | merge-mobile-release |
| freshness / 冲突标记 | exit 0 / 0 markers | merge-freshness / conflict-marker-check.json |

表中组有重叠，不将其相加为独立覆盖总数。首次运行使用旧重连 fixture、旧 service key、旧 IPC 期待的失败日志保留，修复后对应回归重跑通过。CLI 首次直接从 main 运行时缺少新目录 dist，记录为依赖构建前解析失败；隔离副本的本轮类型检查及构建完成后回归通过。

## 未通过与限制

- 相对 main 的整个合并 diff 空白检查 exit 2：incoming 历史报告含 trailing whitespace/末尾空行，原记录保留；相对 incoming 的集成差异检查结果见 `integration-diff-check`，不以源码检查通过概括历史文档。
- 全量 architecture 仍 exit 1：`packages/services/src/gen-ui/contract.test.ts` 缺失，与前次验收一致；未修改 baseline。
- 额外 `pnpm exec tsc -b packages/desktop` exit 2。incoming 隔离基线 254 条诊断，合并后 255；对路径和行列归一化、按诊断首行保留重复次数比较，其余 254 相同。唯一增量为保留 main 的 browser download callback 后多一次 `window.zody` 全局类型声明缺失诊断（main 原 callback 为 `window.zcode`）；并非本轮完整桌面类型检查通过。原始日志及 `desktop-diagnostics-final-comparison.json` 保留，不扩大修复既有桌面检查配置/类型问题。
- 本地 `licenses.mjs check` exit 1：pnpm 已安装快照仍记录旧 `@zcode` workspace 图，身份门禁正确拒绝。仅复用依赖并移除失效旧 workspace alias 软链不足以更新 pnpm 安装图；未安装依赖或重写安装快照使其假通过。合并版许可新鲜度尚未验证，先前改名工作树的许可通过不能代替本次合并证据，strict 19 项材料阻塞也未解除。
- 未重跑全量单测；前次 PageManager 扩大收集暴露的 5 项失败、旧 bootstrap fault injection 失败继续按原报告保留，不声称当前全量通过。
- 未重建跨平台或签名产物；真实 Windows/Linux/Android、真实 SSH/手机/沙箱 E2E、CUA 信任根/pins/归档/签名证据与 R60/R61 发布阻塞未关闭。既有冻结产物不能代表本次合并源码。

## 证据位置

完整日志、初始冲突/解决记录、安装软链操作清单、父版本、诊断对照与候选源码 SHA-256 在 `output/zody-rename-main-merge/`。最终源码清单 `final-source-manifest.json` 摘要为 `4f51b45ab5bf559b670d072aa90ea9e861b1fd2645a2b6ccebb502fa0aaca0b8`，覆盖实际候选文件字节；命令记录中的 HEAD 为提交前第一父版本，不能单独用 HEAD 字段当作候选源码标识。合并回执另外记录最终 merge SHA/parents/tree。

实施阶段旧 `apps/zcode-cli` 未跟踪生成物保留，本地 Git exclude 隐藏其旧输出；没有清理实施归档或删除改名工作树。临时隔离编译副本由本次合并创建，完成后仅清理这些明确临时目录，日志及复现脚本保留。
