# macOS R3 最小发布前准备收尾（2026-11-16）

状态：**用户授权的R3最小发布前准备完成**。规格门槛收敛、无E2E store观察桥的生产renderer单案、最终本地候选闭包及主控/独立Terra复核均完成。正式pin、正式身份分发验收、公证、上传和发布仍未启动；未自动提交。

## 当前门槛与复用

用户已明确授权按实际差异处理，spec的“R3按实际差异收敛门槛”取代旧固定每组合20次及完整真机故障矩阵的必执行要求。安全产品合同不变；旧矩阵记为未执行/被方案取代，不记通过，不换算稳定率。

| 门槛 | 证据与结果 |
| --- | --- |
| R1读取、撤销、系统资格、不透明边界、人审及四项晋升 | 复用已核对的归档最终收据；单用户正常桌面范围不扩大，Electron三次未证明保留 |
| R2原生/SDK安全、Stop、租约、截图借锁和18条路径 | 复用R2最终收据与用户人审，18合格/19真实写尝试中的1失败保留；不重跑120秒、输入或系统故障 |
| 正常生产Host接线 | 复用[CUA-AX-R3-01](cua-r3-normal-host-20261115.md)：2次AXPress、真实PNG/借锁、兄弟不变；此前cwd入口缺口修复及68项回归继续有效，本轮未重跑 |
| 无观察桥生产renderer | CUA-AX-R3-02：本轮新单案通过，仓库外冷启动、普通DOM单次提交、精确读取确认及真实目标交付；零写动作 |
| 最终本地候选闭包 | 同槽只换renderer；主控重新核对非renderer24214文件、Helper12份、原生57份及SDK2份，均与基线相同；正式pin3份、R2/R3-01收据和配对输入不变 |
| 最终独立复核 | 原生Terra只读审阅规格/驱动/真实收据及日志，无阻断；主控独立核验实际diff、摘要与命令退出状态 |

跨用户切换、长时间休眠等原未验证范围不变。没有追加付费真人模型、完整重复矩阵或新的人工输入轮。

## 最终候选与真实差异

唯一运行槽仍为 `output/cua-r3-normal-host-20261115/run-slot/mac-arm64/Zody CUA Normal Host Candidate.app`，独立bundle ID仍为 `io.github.zclaudia.zody.cua-r3-normal-host-candidate`。当前asar SHA256：`0d2c486e1743a4fc43e793bb970aa7e2bb15d6809c3a7b7a1ccbb18aaa5a289c`。

本轮仅以生产Vite配置、显式取消 `VITE_ZODY_E2E_STORE_BRIDGE` 重建renderer，沿用既有asar重装及integrity所有者；Main/Host/scheduler、配对profile、manifest、签名Helper及依赖均保留。刷新integrity后仅本地重签外层，deep/strict通过。没有新建第二个App或热改R2封存包。

本轮“无桥”明确指session store观察桥 `__zcodeSessionStoreE2E` 不存在。现有产品中的Lexical输入辅助属性未被本轮修改，也未被驱动调用。普通WebDriver键入执行真实编辑器输入，未直接更改store、Lexical state或注入测试桥。

## CUA-AX-R3-02 机器结果

- 本轮实际验收Main PID42459，cwd `/private/tmp/zody-r3-production-xt_i7isr`，packaged=true、准确exe/asar路径、录屏权限granted；session store观察桥不存在。复用退出屏障完成provider seed后，以新的冷启动进程执行单案。
- 只提交一次 `E2E_CUA_R3_PRODUCTION_READ`，由实际用户消息/输入框清空证明接收；会话生成真实session ID且最终完成。3个合成provider请求全部complete。
- 读取卡默认拒绝、无always/full access，PID39669/window142670精确对应受控目标；独立允许一次读取。真实SDK `list_windows/get_app_state` 结果进入provider tool_result，`targetSeen=true / siblingLeak=false`。不是用源码中的预期文字代替实际返回。
- 目标142670和同PID同标题兄弟142672的业务模型、计数、文本及OS窗口身份前后相等，requests/presses均0，实际写动作0；未请求截图或借锁重验。
- 当前Host42485日志与launcher42514的PPID对应，固定 `cua-narrow` / `cli-entry.mjs`，workspace-child42545及sealed Node42564与本轮对应。PS采样未抓到Host自身的完整utility行；以当前Main转发日志/launcher父PID和未变的R3-01生产Host装配证据联合核验，不伪造缺失的进程行。LaunchServices child被reparent到PID1，不能声称是launcher的直接OS子进程。
- WDIO单案1 passed、退出0。受控夹具已停止，候选进程归零；本轮无需用户操作。

收据：[production-renderer-receipt.json](../../output/cua-r3-normal-host-20261115/production-renderer-evidence-v2/production-renderer-receipt.json)。主控复算：[production-renderer-controller-audit.json](../../output/cua-r3-normal-host-20261115/production-renderer-controller-audit.json)。最终候选清单：[r3-prepublish-acceptance.json](../../output/cua-r3-normal-host-20261115/r3-prepublish-acceptance.json)。

## 失败、检查与结论边界

1. 首次运行在root hook阶段把WDIO的file URL当作路径比较，误拒绝精确spec；SDK0/写0。补回归复现后改用标准fileURLToPath，完整canonical spec及realpath后仓库外cwd约束保留。原失败和红灯日志保留，不改记通过。新门禁9项单测通过。
2. 原生日志有两条 `ax_unique / element_unavailable` 观察拒绝，随后精确目标授权读取成功；均保留，不宣称整个过程零拒绝。setup的首进程42332在受控reload退出后记录storage `transport_closed`，验收进程42459实际storage为ready；不把前者当成成功冷启动。
3. 根 `pnpm typecheck`、`pnpm lint`、架构、E2E类型检查均退出0；lint保留320条warning，架构0违规。fixture检查通过，保留3条marker warning；覆盖审计及差异检查另记收尾结果。未重跑68项或既有真机用例。
4. 此案使用合成provider验证真实工具链，`liveModel=false`；`humanReviewComplete=false`，未作新的人工体验确认或用例晋升/Docker准入。技术准备完成不等于正式分发身份、最终pin、公证或发布验收完成。

实际构建、签名、类型及验收命令和证据摘要统一保存在本轮output目录；R1/R2原始收据和失败不改写。
