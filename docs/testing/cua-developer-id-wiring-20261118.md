# Developer ID 分发身份接线（2026-11-18，第1步）

> 后续用户决策（2026-11-18）：当前采用现有私有签名，不注册Developer ID Application；该身份/私钥缺失、策略未配置及Apple公证未完成均不作为私有签名路径的blocker，不再要求申请。本文保留此前Developer ID准备与检查事实，下方“后续签名阶段首先需要Developer ID”等描述仅适用于以后显式选择Developer ID分支。现有local-self-signed信任根和验收证据继续使用；本次决定未执行任何签名、上传、发布或安装替换。

前一阶段状态：**Developer ID接线与离线检查完成；该身份未配置，尚不可按Developer ID分支签名分发。** 当前私有签名选择见顶部用户决定。 本轮不签名、公证、上传、发布或替换当前安装。R1/R2/R3证据复用，不重跑真机矩阵或人工输入；本轮没有CUA SDK调用。当前可用签名身份只有本地自签，尚无Developer ID Application身份。

## 缺失输入与恢复依据

开工时 `/Users/zhvala/SourceCode/zody` 实际解析为 `/Volumes/Data/SourceCode/zody`；23个跟踪的 `packages/desktop/build/` 文件均缺失，依赖目录也缺失。`clean.mjs` 仅删指定owner的node_modules/dist，`clean-output.mjs` 仅删output内部白名单，均不能删除build目录。没有删除回执或执行证据能确认具体删除来源，不将路径迁移或清理误断为已证实原因。

只补缺失静态构建输入并逐项比对跟踪字节；冻结pin按前轮正式本地验收复原，SHA256精确匹配 `445148433f0ebdcc23fec9be6cfbfb210c1ddcb14f7a5612c9c3660d539bfc98`，没有采用HEAD旧R1 pin。manifest仍为 `9bcea0ea2e21d81a7f4f930a24672839e14ad17b43f29cfaf33b5bf47371cfcd`，归档仍为 `2bd974c781ffcd4819a3ef4a9066d247d8f057b3b050f8a87594af248e250c77`；没有改成不存在的Developer ID冻结材料。恢复首次因防覆盖断言中止，发现的旧pin副本已保留，之后才按验收摘要复原；不隐去这次失败。

使用mise指定Node24.14.0/pnpm10.33.2恢复检查环境，`pnpm install --frozen-lockfile --ignore-scripts` 完成，不执行安装生命周期脚本。首次环境默认Node24.21及后续固定Node下的架构基线均因缺typescript失败，依赖恢复后架构检查通过。未清理/恢复整棵工作树，未操作旧候选。

## 唯一信任根与接口

`macos-cua-narrow-identity-profile.mjs` 是统一加载入口：local继续使用既有证书/DR/Node固定常量；developer-id仅从仓库固定 `packages/desktop/build/cua-narrow-developer-id.json` 读取受控发布策略。当前文件只含schemaVersion/kind/status=unconfigured，没有占位证书或伪造CDHash。

后续配置字段为 `teamIdentifier`、`leafSha256`、`leafSha1`、`nodeCdhash`，必须来自真实Developer ID证书与完成签名的Node。Helper/Node的固定identifier与Apple Developer ID链/Team DR由代码生成，leaf另行精确比较。原始pins必须与这组唯一期望值逐项一致，不接受自报profile、任意Team/证书或manifest建立信任。缺失、未知、畸形配置均类型化拒绝。

| 入口 | 显式接线与拒绝边界 |
| --- | --- |
| `build-cua-desktop-session.mjs` | `--identity-profile local-self-signed\|developer-id`，默认local；dev必须显式 `--identity-pins`，在Node执行/工具链之前校验配置，随后沿原编译头与build manifest记录精确身份 |
| `macos-cua-narrow-resources-prepare.mjs` | 同样显式profile/pins，未知或重复参数拒绝；对已有签名材料验证并复制，命令自身不签名 |
| `validateNarrowManifest` / 包后校验 | 显式profile或本次构建 `ZODY_CUA_NARROW_IDENTITY_PROFILE`；验证manifest、native编译pins、原始pins及真实代码身份一致；错误profile不能降级 |
| defaults / bundle / tsup | dev要求显式准备好的manifest，不用旧local默认或孤立runtime profile；从验证后manifest生成正常Host profile，并把身份选择贯穿子构建 |
| electron-builder | dev必须启用签名且signer匹配受控Team；只签外层、混装local Helper、关闭签名或错误Team/Installer证书均阻断；保留cua-narrow signIgnore和afterPack/afterSign复验 |

代码身份校验保留leaf SHA256/SHA1、DR、Node CDHash、hardened runtime与空entitlements；dev额外要求Developer ID Application Authority、精确Team及时间戳。native runtime仍消费编译pin并沿原audit-token/同二进制/资源摘要守卫工作，本轮未改其C++准入、authority、租约或窗口逻辑。

## 实际检查与复用边界

- 先红后绿：发布身份被忽略/降级的4项回归；新增策略模块缺失的初始红灯；数字Team类型与畸形pins拒绝回归。原日志均保留。
- 最终受影响Node离线套件 **79/79通过**，覆盖identity、prepare/validate/包后闭包、Host profile、原生builder选择和冻结fetch/restore。合成fixture与模拟系统输出只证明代码合同，不证明真实Developer ID签名或TCC授权。
- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。最终lint **320 warning / 0 error**；中途新增测试的unused import产生321 warning，补充实际使用该接口的类型回归后回到320，保留前一日志。架构策略未管理scripts/native运行时，不将0违规外推为原生安全证明。
- 没有E2E场景或fixture改动，未执行E2E/fixture重跑；根typecheck命令本身包括既有E2E TypeScript项目。主控复算旧验收记录、候选/安装asar仍为 `2e7a965f10eebff39af1c94b8bef60f45b591b40d24d0dfcb55bc7fdcd407ac7`，23个恢复输入均再核对一致。
- 独立Terra只读审阅无阻断；主控核对实际diff与退出证据，不将mock通过记作Developer ID实际验收。

执行中共享仓库HEAD由a7422b3dc推进为87e76a375，并吸纳部分在途文件。主控与两个实现Terra均确认没有执行git暂存、commit、restore或reset；提交来源未证实。保留该提交并按当前源码复核，不回退其他来源工作。本轮剩余修改保持未提交，最终freshness为ahead249/behind0。

## 后续边界

本轮没有需要操作员处理的系统权限。后续签名阶段首先需要可用Developer ID Application证书/私钥；实际签署Node后才能填入真实CDHash、配置发布策略并重建/签署Helper与外层App。旧本地冻结双pin仍保留；新签名/公证材料确定后再生成发布manifest、归档和新摘要。当前release workflow仍是unsigned，历史notarize脚本仍不存在，不能据本轮接线宣称流水线可发布。

公证意味着向Apple上传；草稿安装包/冻结材料上传和公开Release/更新渠道又是独立边界，均未执行。后续仅补新身份下最小受控读取/AXPress/截图与最终容器/Gatekeeper检查，继续复用R1/R2矩阵，不重复18笔或旧故障排列。

证据目录：[cua-developer-id-wiring-20261118](../../output/cua-developer-id-wiring-20261118/)。核心：[恢复回执](../../output/cua-developer-id-wiring-20261118/build-input-recovery.json)、[主控核验](../../output/cua-developer-id-wiring-20261118/controller-final-audit.json)、[最终定向测试](../../output/cua-developer-id-wiring-20261118/focused-tests-final.log)、[独立审阅](../../output/cua-developer-id-wiring-20261118/independent-review.json)。
