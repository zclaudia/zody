# macOS Computer Use 生产接线续作

2026-10-30。先更新 spec 后由 DeepSeek 实现，controller 审查和独立执行。保持默认禁用，R9/R10/R11 归档与签名候选只读。

范围：为已签名 R11 Helper 开启用户已批准的屏幕录制权限，并以 LaunchServices 独立运行确认；复用当前 AgentRuntime 的唯一 authority，使用真实 command execution/turn 生成窄 scope，接到同一次 launcher 与 bootstrap 显式可信入口；原生产品连接只在实际 peer/代码封装证据成立时放行。

单一状态 owner 及事件顺序见 spec“生产 owner 接线续作”。controller 已确认 bootstrap 身份与 CommandInbox ticket 已存在，不能重复造状态。安装的 Zody 本体目前 ad-hoc、无资源封口；不修改该应用，不以开发 FD 冒充可信产品链。相应原生正例若无法成立，明确保留此阻断，先完成全部可直接实施接线。

代码拆分为 core/contracts 的 runtime scope，以及 adapters/bootstrap 的 consumer 装配。并发 writer 文件互斥；controller拥有 spec/计划/验收，必要测试随实现先写。相关 scope/真实子进程测试和根 typecheck/lint/architecture执行一次，失败才针对修复重跑。不开新的验证矩阵。

使用 deepseek-flash / magpie / commandcode-plan/deepseek/deepseek-v4.1-flash；调查只读，无UI权限。调查worker：broker:deepseek-flash-ro-989625ff4f43c3ef:01a18ab7-538f-7580-b7d0-7839d80a1fef。写入worker按实际ID追加。新候选及证据：output/cua-helper-product-integration/。

实现 A（contracts/core scope）：broker:deepseek-flash-rw-c2d541bc0c4e8861:01a18abe-cff3-7d40-9959-1307981b2592。实现 B（adapters/bootstrap、仅core/tests/cua-submission-control-binding.test.ts）：broker:deepseek-flash-rw-c2d541bc0c4e8861:01a18abf-ebf8-7220-b3f3-b79dea5b4587。文件所有权互斥，均workspace-write、无UI grant。

权限结果：用户完成系统认证，controller通过系统设置精确添加原R11签名app并确认开关on；同产物LaunchServices独立启动返回 captured-and-revoked，生成2400×1600 PNG，tccd主体为Helper自身。截图留output，公开证据另归档。

续作：A 完成 core 后串行负责新 `adapters/src/mcp/cua-native-authority*.ts` 与同名前缀测试，把 R11 原生请求协议接至现有 scope（不实例化 authority）。与 B 的 control/bootstrap 文件互斥；公共 export 等 B 完成后再串行处理。controller 实跑固定签名 Node + 当前 CLI --help 成功；未把 lazy WASM/native 依赖风险当作已证实启动阻断。完整可信产品启动装配仍须实际证据，独立 Helper 正例不替代它。

接口阶段独立回归通过16文件131项。B在此前文件冻结后串行负责新的原生组合候选目录 `packages/desktop/native/macos-cua-helper-product-wiring/` 与独立构建脚本；只在output派生R11原生编译源，空bootstrap消费生产scope返回值。由签名资源内受控fixture驱动真实create-app/CommandInbox，同一owner进入真实Helper；controller负责签名、实拍与归档。fixture来源单列，不声称安装版UI或完整产品启动通过。没有新权限要求时继续执行，不重复请求屏幕录制确认。

组合候选首次真实运行已完成 bootstrap/peer 并进入 SCK，但 supervisor 统一返回 helper-exit-not-success、无 PNG。保留失败证据；B仅增加固定原生派生 patch 传递有界失败原因及 Node stderr 后重跑，查实原因再改，不把 open exit0 当 Helper 成功。

最终原生组合验收（2026-10-30 13:32 Asia/Shanghai）：用户解锁后将原Zody窗口Raise至前台，刷新实际窗口边界；同一签名候选返回captured-and-revoked，实际PNG2400×1600，现有runtime记录owner-revoked/真实撤销回执，controller重新获取机器锁成功。未改代码、签名或权限；保留锁屏及缩略窗口状态失败证据。此单窗口链已贯通，剩余产品工作是完整可信启动与真实Host输入装配，fixture不冒称安装版UI。最终证据见reports/2026-10-30-product-wiring/ACCEPTANCE.md。
