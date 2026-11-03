# R21 既有 workspace 同名许可覆盖缺口（待用户裁决）

固定生成候选 ad859 的两份文件相对4fac的变化本身获独立 scoped PASS；这不能证明完整生产覆盖。随后发现真实私有 workspace `apps/zody-cli/packages/debug`（debug@0.1.0）与 registry debug 同名，`scripts/third-party-npm.mjs`、`scripts/licenses.mjs` 仅按名称排除 workspace。实际及 lockfile-only 两套生产图均有21条 debug@4.4.3 链，而 inventory/notices 均无该项。debug@2.6.9 也从基本已安装检查排除，但两套当前生产图均未出现它，不能把其dev-only情况误写成生产遗漏。

033f已含相同workspace、过滤实现和旧清单缺项；旧锁明确记录CLI→proxy-agent8.0.1→debug4.4.3。未重跑033f完整实际生产图，不推断更大的历史状态。原1217条记录和143字段无漂移，只证明已记录部分的变化；双方都漏项时diff不会显示，基础check0也受相同过滤缺口影响。DeepSeek结论：生成对变更scoped PASS，但R21完整生产许可覆盖CHANGES_REQUIRED，R22/发行尚未通过。

独立 ad859 reinstall 出现 `-146`：没有重装前逐包/.modules快照，日志未列实际删除对象，原因与具体清单尚不能证明。当前146 skipped项及平台/WASM父链只是数量线索；不能直接认定就是被删的146，也不与debug缺口建立未经证实因果。当前锁固定、1217登记生产版本均可找到，不等于完整物理安装图逐项不变。

证据位于 `output/zody-rename-r21/final-confirmation-ad859/` 的 reinstall-pruning-audit、debug-workspace-name-collision-audit、debug-graph-readonly 及补充JSON。可审方案见 R21-license-collision-fix-proposal.md：只按路径/可验证link身份区分workspace与第三方，先补同名/alias/symlink回归，再重新生成并复审；不改版本/锁、来源、原文或应用运行时。

依AGENTS.md:48“发现设计缺陷时先与用户对齐”，已用异步问题请用户选择修复或暂缓。当前未获此新设计变更答复，未修改生成器或新建正式行为spec。其他独立R22测试/归因继续；不得把此缺口静默豁免或把19条既有strict义务当作已解决。
