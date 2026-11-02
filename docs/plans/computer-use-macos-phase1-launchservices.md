# macOS Computer Use：正式应用启动与 Helper 权限归属

2026-10-30。以同日 desktop-session 已冻结的真实截图、UI Stop 和 authority FD 修复为基线；旧归档只读。新输出 `output/cua-launchservices/`，新验收目录 `packages/desktop/native/macos-cua-driver-closure/reports/2026-10-30-launchservices/`。

## 问题与边界

此前真实截图及同 owner 的 UI Stop 已通过，但 raw Electron 从控制器终端启动，实际屏幕录制请求被 macOS 归属到 Codex，且未覆盖正式 `.app` 的 packaged 资源路径。本轮解决应用启动和权限归属，不重新实现授权状态，不开放默认功能。

只读预检：相同真实自签名证书、Helper identifier、strict HR/空 entitlements 的独立 probe 经系统入口启动；PID 38301、PPID 1，CGPreflightScreenCaptureAccess=true。tccd 请求 38301.2 的 subject 是 `io.github.zclaudia.zody.cua-helper`，authValue=2；无权限修改。证据在 `output/cua-launchservices/preflight-probe/`。这只证明方向可行，最终消费者必须实测。

## 实现顺序及所有权

1. spec 先明确公共 LaunchServices 启动、双向 peer/CDHash 校验、SCM_RIGHTS、cwd/env 与退出时序；授权及 lease 所有者保持不变。
2. DeepSeek native worker 修改 desktop-session `src/`、native 测试及 native build 的 `scripts/lib/cua-desktop-session-*`；排除 `entries/host-entry.ts`。先补真实 FD/失败/退出回归，再实现 relay 和 child，保留旧 direct 接口。禁止触碰 R8–R11 冻结源与 registry cache。
3. DeepSeek Host worker 修改 desktop main/common、services process launch 合同及其测试、`entries/host-entry.ts` 和独立 candidate 构建脚本；新增显式 relay mode，完整 `.app` 使用固定相对 Helper 路径、正常 resources/config 和独立 profile。不改 CLI 业务状态，不改产品默认开关。
4. controller 审查最终 diff、独立重建并验证固定签名，运行受影响测试及根 typecheck/lint/architecture；系统启动正式布局候选，实际 OS TCC subject、截图和 UI Stop 分别记账。

并行 writer 文件互斥；worker ID 与各自状态写入本轮验收。普通开发无 UI 授权；所有系统交互由 controller，逐次原生允许按钮由用户操作。

## 生命周期与风险

relay 保持存活直到 LS child 明确结束；原进程 EOF/退出触发 child 既有 requestStop，不创建授权状态。NSWorkspace completion 的 PID 必须与 peer token 一致；启动中断、协议畸形/超限/FD 截断、签名/代码不符必须关闭。LS child 环境不同，认证后保留必要 cwd/env 并继续阻止代码注入。无静默直接启动回退。

真实应用使用 Mach-O CFBundleExecutable，不用 shell 冒充 app；Helper 位于 asar 外、不被外层重签。不安装证书、不更改 TCC、不修改已安装应用。公共 API 只提供启动机制，权限归属以当前 OS 实测为准：[NSWorkspace createsNewApplicationInstance](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/createsnewapplicationinstance)。

必要验收结束即停止扩大检查。缺少真实 Helper subject、截图或 Stop 任一证据时仅报告部分完成；进程退出不能写成 native Fenced，probe 或编译成功不能写成正式产品通过。JS 许可欠项、完整 D06、Intel/最低 OS 等前轮阻断继续保留，不在本轮扩展。

## 执行结果（2026-10-30）

上述四步已完成。最终完整候选真实Helper TCC归属、单窗口截图、同submission lineage的UI Stop通过；必要检查均通过，lint301 warnings。两次打包/启动失败及确认超时已如实留档。验收与源/patch/许可/构建证据见[本轮报告](../../packages/desktop/native/macos-cua-driver-closure/reports/2026-10-30-launchservices/ACCEPTANCE.md)。功能默认禁用；下一步为正式发行装配与既有D06路径TOCTOU边界，不把本轮结果扩大为完整Host或输入能力验收。
