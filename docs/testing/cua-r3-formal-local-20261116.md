# R3 正式pin与正式身份最小本地验收（2026-11-16）

状态：**第1步正式pin更新与第2步正式身份最小本地验收完成**。主控与独立Terra复核通过，当前安装未替换；公证、上传、发布及自动提交均未启动。结论限于本地自签profile与独立目录候选，不代表Developer ID分发或新人审晋升。

后续第3步已获追加授权并完成安装切换，见[独立安装记录](cua-r3-install-20261116.md)。本文“未替换安装”等表述保留第1/2步完成时点，不改写原验收收据。

## 范围

复用R1/R2及R3-01/02证据，不重跑完整矩阵、120秒租约、Stop或18笔人工输入。仅对正式默认pin和应用身份差异执行CUA-AX-R3-03：受控目标读取、一次AXPress(none)、一次截图组合。截图接口保留必要的再次读取确认，读/控制/截图授权独立，失败或可能派发不重放。

## 正式pin与本地归档

- 原pin与defaults/constants原字节保存在 `output/cua-r3-formal-local-20261116/rollback/`。仅默认manifest双pin与归档metadata更新，证书leaf/DR/Node CDHash常量不变。回滚备份用于撤销配置更改；旧冻结材料原本缺失，本轮未为此下载旧包。
- 默认manifest：`output/cua-narrow-frozen/controller-prepared/manifest.json`，SHA256 `9bcea0ea2e21d81a7f4f930a24672839e14ad17b43f29cfaf33b5bf47371cfcd`；R2 prepared原字节整体复制，未重签Helper。
- 本地归档：`output/cua-r3-formal-local-20261116/cua-narrow-frozen.tar.gz`，SHA256 `2bd974c781ffcd4819a3ef4a9066d247d8f057b3b050f8a87594af248e250c77`。launcher仍为 `00c91110dfd0e10fe66c0c25fb7c8709fd19fb1b6bc3b49c3fa8c1cd134d61b2`。
- 已通过既有fetch的本地归档覆盖入口，在隔离repo-root真实restore，再走默认选择器、manifest树、codesign及12份Helper摘要核验；临时还原树已移除，证据见 `restore-proof.json`。
- 新releaseTag `cua-narrow-frozen-2026-11-16-r2-local` 仅为本地冻结版本标识，远程未上传、不可宣称可下载。异机需携带本地归档并显式设置 `ZODY_CUA_NARROW_FROZEN_ARCHIVE` 后走既有fetch入口；当前默认构建直接使用已还原冻结槽，不依赖显式manifest/profile覆盖。

## 唯一正式身份候选

独立路径：`output/cua-r3-formal-local-20261116/run-slot/mac-arm64/Zody.app`。Info.plist与代码签名为正式 `Zody / io.github.zclaudia.zody`。生产tsup/Vite与正式electron-builder钩子，只覆盖独立输出和禁止自动签名/公证/发布；构建前复用生产out清理器，未开启E2E store观察桥。仅构建一次：临时config最初把输出按desktop cwd解析，修正配置路径并在签名前搬迁同一个未签名输出，无第二份构建，详见 `build-output-relocation.json`。

默认选择及包内Host profile均绑定新pin，Helper12份与R2一致，正常utility Host/cua-narrow装配；依赖12根/39项闭包无缺失，native-policy违规0。随后使用已有本地自签证书签外层及Electron框架，deep/strict通过，Helper未重签；不冒称Developer ID或公证通过。

WDIO运行名仍为 `ZCode E2E`，仅用于隔离当前安装的单实例和系统集成；正式身份由实际Info.plist/codesign与运行exe路径证明，不把运行名当作TCC身份。使用独立HOME/userData及仓库外cwd，不读取真实用户配置。原安装 `/Applications/Zody.app` 的现有Info.plist/可执行文件摘要、inode和mtime已核对不变。

## 实际验收与失败保留

用户为准确候选路径开启录屏权限后，fresh v2/v3进程均返回granted；没有再次要求开关或重置TCC。原v1等待超过SDK外30分钟就绪预算，SDK请求0/写0，保留失败记录。v2首笔真实读取在 `cg_unique / element_unavailable` 安全拒绝，未出现读卡、未派发写动作；当时OptionAll预检只证明窗口ID仍存在。只读CG OnScreen诊断确认旧夹具列表为空，故不能把它归为授权成功或产品窗口守卫缺陷。

修复仅在新验收器：SDK前要求目标/兄弟的新鲜 `onscreen=true / layer=0 / 精确PID与window`，缺失则停止。新增3项回归，连同单写/possibly_sent不重试两项共5项通过；重新打开受控夹具，新的PID/窗口通过可见性预检。没有改产品守卫、重建App或放宽归属。

| v3验收点 | 真实结果 |
| --- | --- |
| 正式身份与隔离 | Main39490，bundle ID `io.github.zclaudia.zody` / CFBundleName `Zody`，准确独立exe/asar路径，仓库外cwd、独立HOME/userData；screen granted，store观察桥未暴露 |
| 实际链路 | Main39490→utility Host39508→固定cua-narrow cli-entry launcher39529；workspace-child39531被reparent到PID1，其sealed Node39534；不伪称仍为launcher直接OS子进程 |
| 独立授权 | 精确目标PID38157/window142976的read/control/read卡及独立截图请求；默认拒绝且无always/full access，不用TCC或截图许可升级控制许可 |
| 业务效果与收据 | 一次AXPress，目标requests/presses均0→1；同PID同标题兄弟142978计数/文本不变，前后两窗口身份一致；唯一 `action_sent=true / sent / not_requested` 收据与同attempt/scope原生admitted/completed审计匹配，截图前已写出受限动作收据 |
| 真实图像 | PNG620×404、31277字节，SHA256 `fb4241f0a7d6f11e283405dda33c9cdbedd79d1679cb9af1c707397fdc630be8`，provider实际图像与本轮native audit一致；相同夹具画面可产生相同摘要，不以摘要唯一性冒充时序证据 |
| 截图借锁 | `machineLeaseReleased=false`、`machineLeaseBorrowReturned=true`、`resourcesReleased=true`；本轮无capture rejection |
| 数量 | v3只提交一次，3个合成provider请求全部complete，WDIO单案1pass/退出0；本期实际写派发总数1。另有v1等待超时和v2读取安全拒绝，均保留，不计成功 |
| 复算与收尾 | 当前默认pin/本地归档及包内manifest一致，Helper完整树/签名、12资源、原生57源码及SDK2份复算一致；独立Terra只读复核无阻断；受控夹具退出、候选进程归零 |

正式候选当前asar SHA256：`2e7a965f10eebff39af1c94b8bef60f45b591b40d24d0dfcb55bc7fdcd407ac7`。R2 prepared、旧R3准备最终收据和身份常量保持原字节；已安装App关键文件摘要/inode/纳秒mtime复核未变。

## 检查与交付

已执行并通过：默认pin回归8项，冻结/restore/fetch相关30项，精确验收scope门禁11项，SDK模板/可见性离线5项，正式身份最小真机1个单案。最终根typecheck、lint、架构及E2E类型均工具确认退出0；lint保留320条warning，fixture检查保留2条marker warning。新增可见性修复后只重跑相关检查，没有重跑R1/R2完整矩阵、120秒、Stop或18笔人工轮。

主控最终审计初次将旧资源基线数组误按映射读取，发生ENOENT；修正验证器读取形状后通过。原错误日志保留，没有为此重放真机动作。其他构建warning及v1/v2原失败均保留。

- 实际收据：[formal-local-receipt.json](../../output/cua-r3-formal-local-20261116/evidence-v3/formal-local-receipt.json)。
- 主控复算：[controller-final-audit.json](../../output/cua-r3-formal-local-20261116/controller-final-audit.json)。
- 最终清单：[formal-local-acceptance.json](../../output/cua-r3-formal-local-20261116/formal-local-acceptance.json)。

当前正式pin仅保证本地冻结材料和本地默认构建可用；远程归档未上传。安装切换属于后续第3步，公证/对外分发属于独立阶段，均未执行。`liveAcceptance=false / humanReviewComplete=false`，本案仍pending入口，不自动晋升或Docker准入。
