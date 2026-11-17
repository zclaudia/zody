# R3 本机安装切换（2026-11-16）

状态：**第3步完成**。已备份旧App和本机数据，将 `/Applications/Zody.app` 切换为此前通过正式身份最小本地验收的候选；主控与独立Terra复核无阻断。应用保留正常运行。本轮只验证启动和默认装配，不重跑R1/R2/R3矩阵，不提交任务或CUA SDK调用；未公证、上传、发布或自动提交。

## 备份与切换

- 私有备份：`/Users/zhvala/Documents/Zody-Install-Backups/20261116-212733`，根权限0700。旧App完整副本 `old-app`、完整 `~/.zody` 的 `zody-data`（业务数据、SQLite伴随文件、配置与Electron profile）以及旧默认Electron目录分别保留。外部项目文件不在本次备份范围。
- 备份前无Zody进程、数据打开句柄或路径覆盖；源树备份前/副本/源树备份后，按文件内容摘要、权限、链接逐项完全一致。旧App4546项/4311文件、约1.10GB；业务数据23397项/19323文件、约431MB。私有清单不复制到仓库，不记录用户配置或对话正文。正常启动后允许当前数据发生正常变更，不能再要求它与备份一致。
- 使用 `ditto` 同卷暂存已验收候选；严格签名通过后，用macOS `renameatx_np(RENAME_SWAP)` 交换应用路径。没有重建、重签、热改候选、移除quarantine或重置TCC。已安装4561项完整树与原候选一致，asar仍为 `2e7a965f10eebff39af1c94b8bef60f45b591b40d24d0dfcb55bc7fdcd407ac7`。
- 独立复核旧App备份与交换后原App各4546项、零差异后，移除Applications中的冗余隐藏旧树；旧App备份和数据均保留。回退说明位于备份README：退出应用后恢复旧App，数据快照不自动回灌，避免覆盖切换后的新数据。

## 最小启动结果

使用 `open /Applications/Zody.app`，没有测试HOME/userData、E2E renderer桥或显式manifest/profile覆盖。实际bundle为 `Zody / io.github.zclaudia.zody`，本地自签 `Zody Local Computer Use`；deep/strict签名通过，不代表Developer ID或公证分发。

主控仅通过CUA只读观察确认Starting消失，正常页面包含输入区、New task/Settings/Send控件；未点击、键入或提交。固定字段脱敏启动证据显示：Main62545 → utilityHost63372 → 包内cli-entry launcher63430；workspace-child63466已reparent到PID1 → sealed Node63467。默认cua-narrow路由指向安装路径，spawn preflight确认command/cwd存在，随后process started与warmup ready/stdio成立。自动更新在本构建中disabled。

启动观察区间保留 **9条warning、0条error**（固定分类及原行摘要）；不称无warning。没有把route selected单独当作运行成功，也没有将本轮启动成功外推为新的AX/TCC动作验证。正式身份下的真实读取/一次AXPress/截图及权限证据直接复用[第1/2步](cua-r3-formal-local-20261116.md)，不重复动作或要求用户重新处理系统权限。

## 证据与边界

- [安装验收清单](../../output/cua-r3-install-20261116/installation-acceptance.json)
- [备份回执](../../output/cua-r3-install-20261116/backup-receipt.json)
- [主控完整树与启动复算](../../output/cua-r3-install-20261116/controller-final-audit.json)
- [脱敏启动事实](../../output/cua-r3-install-20261116/startup-observation.json)
- [独立Terra复核](../../output/cua-r3-install-20261116/independent-review.json)

本步无产品或测试源码变化，不新建E2E用例/晋升，不重新执行已通过根typecheck/lint/架构/E2E类型/fixture检查；复用前轮同一候选的真实退出0证据，lint320条warning和fixture2条marker warning继续保留。仅新增安装备份、签名、完整树、真实启动及文档差异检查。

本机已可正常启动默认装配；远程冻结归档仍未上传。本轮不构成公证/对外分发、live model验收或新人审晋升；R1/R2支持范围与失败记录保持原结论。
