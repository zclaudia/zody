# Chrome Extension Browser Backend 实施计划

日期：2026-10-31
状态：已完成，macOS 主代理验收通过；Windows/Linux 未实机验证
设计依据：`2026-10-31-chrome-extension-debugger-backend-design.md`

## 1. 实施策略

按 P0 → P3 顺序交付，每个阶段由 Sonnet 子代理实现，主代理独立审查和验收。P0 的真实 Chrome 两分钟空闲验证是硬门禁；未证明 offscreen 连接和 attachment 可持续使用，不进入 P1。

所有阶段共同约束：

- 先读根 `AGENTS.md`、目标包 `AGENTS.md`、架构治理 skill 和本设计；行为实现前保持 spec 与代码一致。
- 保留工作区已有本地修改，尤其是 `packages/desktop/src/host/index.ts`、`packages/desktop/src/main/index.ts` 和设置页；只做增量接入，不格式化或回退无关文件。
- 不提交、不推送、不更新架构 baseline，不用超时或自动重试掩盖状态同步问题。
- 跨进程消息使用 shared 叶模块的严格 Zod schema；扩展不得从 shared barrel 导入。
- Main 只持有连接、凭据、持久 generation 和窗口绑定；Host 持有 session/tab/claim/lease；扩展不接收 session/workspace。
- 每阶段补充可执行测试并实际运行。真实 Chrome 使用独立测试 Profile，不读取开发者日常 Profile。
- 验证使用仓库要求的 Node 24；环境只能提供 Node 22 时如实记录，不能声称满足 Node 24 验证。

## 2. P0：协议、配对与 offscreen 保活

验收状态：2026-10-31 主代理验收通过。34 项相关测试、根/扩展 typecheck、lint、architecture check 均通过；最终在 headed Chrome for Testing 153 的独立临时 Profile 中完成配对、attach、120.5 秒无 CDP 命令空闲、再次 `Runtime.evaluate` 和 detach。品牌版 Chrome 156 的自动加载 unpacked 扩展未证明，Windows/Linux 未实机验证。

### 实现

1. `packages/shared/src/browser-use/`：定义协议版本、hello/nonce、pairing/proof、resume/proof、welcome、fatalError、单 tab attach/detach、`cdp.request/result`、target 事件的严格 schema；禁止 CDP `sessionId`。
2. `packages/browser-extension/`：建立可构建的 MV3 包，包含固定 manifest `key`、offscreen document、service worker 和 Popup。
   - Offscreen 唯一持有 WebSocket，负责配对和重连证明。
   - Service worker 只负责 `chrome.tabs` / `chrome.debugger` 与消息转发。
   - Popup 支持配对码输入、pairingSessionId 核对和连接状态。
3. `packages/desktop/src/main/`：实现可注入依赖的 `ExtensionBridgeServer`。
   - 仅监听 `127.0.0.1`，固定配置端口，端口占用明确失败。
   - 高熵一次性配对码、TTL/尝试次数、HMAC 配对证明、双向 resume challenge。
   - 同 Profile 单条已认证 socket；新握手关闭旧 socket。
   - 凭据与 generation 存储接口可注入，日志不得输出密钥/证明。
4. 提供真实 Chrome P0 smoke：加载扩展、完成配对、attach 一个测试 tab，空闲两分钟后执行 `Runtime.evaluate`。

### 验收

- schema round-trip、额外字段/sessionId 拒绝。
- 无证明、错误证明、重放、伪造 Origin、端口占用均失败。
- socket 超时/迟到消息不会完成新连接请求；pending compare-and-delete。
- 真实 headed Chrome 空闲两分钟后连接和 attachment 仍可用。
- `pnpm architecture:check --changed`、相关测试、typecheck、lint 实际执行。

## 3. P1：Backend 骨架与核心导航

### 前置

P0 主代理验收通过。

### 实现状态

2026-10-31 主代理验收通过。已落地 Main 持久 generation/凭据与窗口绑定、Host extension
backend 与 router、无 Electron 依赖的 CDP transport 与 target 映射、P1 命令集及 CLI
选择规则。主代理复核 217 项 Desktop/IAB 测试和 40 项 CLI browser 测试通过；根与 CLI
typecheck/lint、扩展 typecheck/build、architecture check 通过；最终真实 headed Chrome
for Testing P1 smoke 通过，覆盖后台新建 tab、navigate/getState/viewport screenshot、close
（active tab 未变化）和 Main 重启后 generation 1→2。验收中修复了 stale disconnect、单
backend 默认回退及 dispatch 前副作用误标问题。Windows/Linux 未实机验证。

### 实现

1. Main 持久化 `profileInstanceId → generation/windowId/credential`，Host 重启和新握手领取更大 generation。
2. Host 新增 `ExtensionBrowserBackend` 与 router 聚合，按 `browserId + generation` 路由；mobile replay discovery 不返回 extension。
3. 建立无 Electron 依赖的 CDP transport 和 `targetId ↔ Host sessionId` 映射；扩展只接受 tabId/targetId。
4. 实现 agent tabs.new/list/get/close、navigate/back/forward/reload/getState、viewport screenshot；fullPage 与坐标能力 fail closed。
5. 更新 CLI browser 选择规则：IAB 默认不变，URL 命中不自动迁到 extension，多 Profile 时 `get("extension")` 失败。
6. 更新 `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` 及相关 browser-client 测试。

### 验收

- 持久 generation、跨窗口隔离、stale target/result、重复 requestId、pending settle。
- 每 tab 串行、多 tab 并行；副作用失败不自动重试。
- Agent 在真实 Chrome 后台新建 tab，导航/状态/截图成功，不激活 Chrome。
- 子 target 映射单测和 IAB 回归通过。

## 4. P2：已有 tab、locator 与授权

### 实现状态

2026-10-31 主代理验收通过。已落地两阶段 claim、一次性 denial/dismissed 拒绝事实、
Popup/badge 授权、openTabs 脱敏、受限页面 fail closed、backend-neutral 共用
Playwright/locator/domSnapshot/evaluate、跨域 iframe targetId 映射、JS dialog 默认拒绝与
撤销、control-browser skill 和 extension 文档。主代理复核 325 项 Desktop/IAB 测试、58 项
CLI browser 测试及 35 项授权/dialog 定向测试通过；根与 CLI typecheck/lint、架构检查通过；
最终真实 Chrome P2 smoke 和 P1 回归通过。验收中修复了 Deny/dismissed 后重复提示的问题。
隐藏 tab 输入使用规格记录的页面内事件兜底，可见页面仍为 trusted input。Windows/Linux
未实机验证。

### 实现

1. 两阶段 claim：首次立即 `authorization_required`，badge/Popup 授权，第二次同 session claim 才 attach；2 分钟 TTL 和晚到决策失效。
2. openTabs 只返回标题和去 userinfo/query/hash 的 URL；受限页面和 DevTools 占用返回 `target_unavailable`。
3. 抽取并复用 backend-neutral Playwright/locator 执行器，覆盖跨域 iframe targetId，不复制第二套算法。
4. 支持 locator click/fill/press/select/check、非坐标键盘输入、domSnapshot/evaluate、JS dialog 默认拒绝超时清理。
5. 更新 control-browser skill：显式 browserId、授权后仅重试一次、denied/target_unavailable 不重试、用户 tab 禁止坐标 CUA。

### 验收

- claim 不占 30 秒命令预算，同窗口 pending 互斥，同 session/tab 合并，跨 session 不泄漏。
- 真实 Chrome 已打开页面完成授权、locator 操作、iframe 操作和撤销。
- dialog 超时解除页面阻塞且不默认接受提交。
- IAB locator 回归通过。

## 5. P3：生命周期与产品化

实施拆分：P3a 先完成 cancel/timeout/disconnect/Host 退出清理和跨窗口转移，由主代理验收；P3b 再接 Settings、安装入口和默认 backend 设置，避免生命周期与 UI 集成问题混杂。

### 实现状态（P3a）

2026-10-31 主代理验收通过。

- Host request tracker、定向 cancel/timeout、副作用判定和断连 settle 已完成。
- 扩展 attachment 记录 `tabClass`，socket/Host 退出/窗口转移统一清理：agent tab 关闭、
  user tab 仅 detach 保留；`LifecycleBarrier` 保证旧 cleanup 先于新 create/attach。
- Host 退出保留 socket 但立即持久递增 generation；新 Host 等待作废完成后注册，旧 CLI
  generation 失效。跨窗口转移先失效旧窗口，再向新窗口发放更大 generation。
- `finalize`/`finalizeTabs`/`turnEnded`/`closeSession` 已对齐现有契约；finalizeTabs omission
  不关闭、deliverable 释放 debugger、跨 session keep 失败。
- 主代理复核生命周期测试及最终真实 Chrome P3 smoke 通过，覆盖 cancel/timeout、disconnect、
  Host exit、窗口转移、offscreen 重启和 agent/user 清理。验收中修复了 detachAll 竞态和
  finalizeTabs 缺口。Windows/Linux 未实机验证。

### 实现

1. cancel/timeout/disconnect/Host 退出清理；agent tab 关闭，user tab 仅 detach 并保留。
2. 跨窗口显式转移：旧 generation/claim/lease 全部失效，再绑定新窗口并发放新 generation。
3. Settings → Browser：安装入口、端口、Profile、绑定窗口、默认 browserId、撤销配对；桌面与手机展示边界符合设计。
4. 完善真实 Chrome 生命周期、8 MiB frame/4 MiB result 限制和三平台发布验证。

### 实现状态（P3b）

2026-11-01 主代理验收通过。Settings → Browser 已提供手动安装指引与真实构建产物目录、
当前窗口配对、端口配置（Main 先重启再持久化，占用时回滚）、当前窗口/孤儿 Profile、撤销
与显式转移。默认 backend 的唯一 owner 是 Main 当前窗口，经窗口 Host 和
`interaction/browserDefault` 接入 CLI `defaultBrowserId`；renderer reload 保持，app restart
安全回落 IAB，旧全局字段安全忽略，手机 replay 不继承 extension 默认。手机 Web 仅只读提示，
桌面扩展构建产物进入 `resources/browser-extension`。

主代理复核 167 项窗口/设置/协议测试、65 项 CLI/broker 测试、真实 Desktop 设置 E2E 和最终
真实 Chrome P3 smoke 通过；根与 CLI typecheck/lint、架构检查通过。验收中将默认 backend
从全局 AppSettings 修正为 window-scoped owner。Windows/Linux 未实机验证；全仓 fmt:check
仍被既有 vendored Electron HTML fixture 阻断，相关改动通过 diff/format 定向检查。

### 验收

- WebSocket/offscreen/service worker/Host 重启、用户 Cancel、窗口转移均按 spec 清理。
- 大帧不排队、不持续增长内存；手机无 extension descriptor/配对操作。
- 根与 CLI 的 typecheck、lint、受影响测试、architecture check 全部执行。
- macOS 实机验收；Windows/Linux 未实机部分明确保留，不写成已通过。

## 6. 主代理验收方式

每个阶段主代理独立执行：

1. 审查实际 diff，核对状态所有者、事件顺序、鉴权和已有本地修改未被覆盖。
2. 运行新增/受影响单测与集成测试，再运行根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
3. 涉及 CLI tool/selection/skill 时运行 `pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint` 和受影响包测试。
4. 运行真实 Chrome smoke/E2E；不能执行的验证明确列出，不能用 mock 结果替代真实 Chrome 结论。
5. 验收问题交回子代理修复或由主代理做小范围修正，之后重跑失败项及回归项。
