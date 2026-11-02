# App 内确认弹窗替代 Helper 原生 NSAlert（2026-10-31）

**本轮窄范围 PASS。** 用户批准把每次截图前 Helper 的原生 NSAlert 替换为 Zody App 内确认弹窗：Helper 经既有 authority 双工帧发送 `confirm` 请求，CLI 复用既有 permission 交互链路（反向 RPC + v4 pending interaction）在 App PermissionDialog 呈现，用户决定原路返回 Helper 采信。轮中用户再次修订策略：确认遵循标准权限选项（允许一次/总是允许（项目规则）/Full access/拒绝），规则命中免交互放行。Helper 仍执行截图；submission authority、lease、frame owner、Stop、迟到丢弃与资源释放语义不变；屏幕录制权限、证书与进程结构不变。整体 Phase 1 既有缺口全部保留。

## 实现与分工（完整台账见 [worker-ids.json](../../../output/cua-inapp-confirm/worker-ids.json)）

- 规格先行：spec 顶部新章节 + 计划轮次小节（含事件顺序图、6 条失效/幂等验收），后随用户策略修订同步更新。
- 实现 worker：W2（CLI confirm 协议/runtime 方法/bootstrap 接线）、W3（原生确认重构 + 审计枚举 app-confirm-failed）、W4（UI 弹窗块）、W5/W7/W9（重建 + pin v1/v2/v3）、W8（标准权限策略）。W6 修复轮 + DeepSeek 独立审查由 ds-worker（DeepSeek，new-provider-4/group/deepseek$enabled）执行；W1–W5 因本会话工具面缺陷运行于会话模型 GLM-5.3（subagent_model 参数无法发出、broker 插件缺失，8+ 次尝试与 5 次中止启动均如实登记）——这是与「仍由 DeepSeek 实现」要求的已知偏差，DeepSeek 审查与 W6 起的全部实现/构建由真实 DeepSeek 完成。
- DeepSeek 独立审查发现并（W6）修复 1 个阻断项：确认请求未合成 v4 PermissionRequested/Resolved 事件，真实 App 不会弹窗（fake-broker 测试掩盖）；同轮修复 v4 形状（optionId allowOnce、freeText、raw=detail）、failureReason→ok:false、坐标 double/空窗口名/UTF-8 目标名、resolveFromApp 唯一判定、native 测试注册。

## 检查与构建（Node 24.14.0；日志在 output/cua-inapp-confirm/independent-checks/）

| 层次 | 结果 |
| --- | --- |
| 单元/集成 | adapters 20/20、core 9/9、bootstrap 22/22、UI 15/15、services 87/87（controller 复跑确认）；native 11/11（含新注册 confirmation-app-decision） |
| 静态 | `pnpm typecheck` PASS；`pnpm lint` 301 warnings/0 errors（基线持平）；`pnpm architecture:check --changed` 0 violations；`git diff --check` PASS |
| 构建 | Helper 重建 v1/v2/v3（冻结工具链 + local-self-signed，identity pins 未变）；prepare-narrow v3 manifest SHA `656fd144…`；正式 electron-builder `--dir` v4 装配（afterPack/afterSign 断言通过，包内 manifest 与 pin 一致） |
| pin | macos-cua-demo-defaults.mjs：manifest `656fd144…`（controller-prepared-production-v3）；startup snapshot 按当前 provider 配置重测 `754d6722…`（用户轮前改过 provider 注册表，旧 pin 触发设计内 provider-revision-mismatch 回退，重测语义见文件内注释） |

## 实测（真实 darwin/arm64 macOS 26.6.2、真实 SCScreenshotManager one-shot）

- **App 内允许 → 真实单窗口截图**（generation 3/4/5 三次）：App 弹窗 `user-approved` → PNG 1172×976/65,887 bytes 交付 → `machine-lease-released:true`/`resourcesReleased:true`。
- **弹窗等待时 UI Stop**（generation 6）：弹窗持续等待 ≥5s → Stop → 弹窗即关，`confirmation-resolved allowed:false (authority-eof)`、`capture-rejected`、cell reaped（SIGKILL）、零交付。
- **工具超时 fail-close**（generations 1/2）：60s node_repl 工具超时 → 弹窗自动关闭、authority-eof、无交付。
- **Full access 免交互**（v4 generation 1）：会话 full access 模式 → confirm 帧照发但规则短路 → 无弹窗直接 `user-approved` + 交付。
- 迟到/重复确认由测试矩阵覆盖（native late/invalidate、CLI confirmSeenGenerations/invalidated 不写响应、bootstrap abort 级联）。
- 环境备注：实测前重新识别受控 TextEdit（PID 40077 / windowId 89774，新建 Untitled 文档）；实测期间临时将共享 lastWorkspaceSession 指向 zody 工作区，测后已恢复 zcharlie。

## 归档

- 源码/patch：[archive/](../../../output/cua-inapp-confirm/archive/)（28 文件 SHA 清单 + tracked diff + source-and-patch.tar.gz `c234f3c4…`）。
- 构建/验证日志：[independent-checks/](../../../output/cua-inapp-confirm/independent-checks/)（helper/prepare-narrow/validate/pack v1–v4、根检查、controller 复跑记录）。
- 实测证据：[live-evidence-*.log](../../../output/cua-inapp-confirm/)（allow-capture / stop-cancel / fullaccess-shortcircuit）。
- worker 任务规格：[worker-tasks/](../../../output/cua-inapp-confirm/worker-tasks/)（W2–W8）。旧冻结、旧 output、旧报告只读未动。

## 保留缺口

- 普通 Host 来源可信性缺口保留（本轮为 UX/交互链路变化，用户明确接受采信 App 决定，不新增可信性声明）。
- confirm 等待期间 authority wire 串行处理：迟到 revoke/close 帧延迟不丢失（spec 已注明，Stop 经 abort 立即解锁）。
- 「总是允许（项目规则）」选项的实机点击路径由 UI/core 测试覆盖（15+9 项）与 full access 实测旁证，未单独做用户点击实测（模式切换控件无法经 CDP 驱动）；用户日常使用即完成该验证。
- 既有整体 Phase 1 门槛（D06、native Fenced、Intel、完整 CLI 兼容等）不变。
