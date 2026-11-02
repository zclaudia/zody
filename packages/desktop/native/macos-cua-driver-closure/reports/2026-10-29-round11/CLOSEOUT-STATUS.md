# 收尾判断：独立权限与产品接线

2026-10-29。用户问“今天可以一口气收尾吗”后，controller 重新核对当前源码，并委派 DeepSeek 只读调查。结论：不能将第十一轮开发链通过当作产品仅差一次权限开关；目前不能承诺今天整个 Phase 1 可用。默认禁用不变，本次没有实施代码修改或改变证书/TCC。

## 独立启动已取得的事实

同一已签名 Helper app 通过 LaunchServices（open -n -W -g）独立启动，指定当时实际 Zody 单窗口，返回 blocked/helper-exit-not-success，未生成 PNG。open 的 exit0 只说明启动命令完成，不是截图成功。

系统 tccd 日志明确本次 ScreenCapture preflight 的 subject/responsible 都是 `io.github.zclaudia.zody.cua-helper`；msgID 47543.1，结果记录 authValue=1。当前独立启动链未取得屏幕读取许可。未调用权限请求、未改 TCC；已向用户单独说明并请求为该固定 Helper 开启屏幕录制权限，尚待答复。

此前控制器启动链的 captured-and-revoked 和真实 PNG 仍成立，但不能覆盖此次独立启动失败；不能以借用控制器的既有权限替代 Helper 自己的许可。当前 supervisor 把非零子进程状态统一显示为 helper-exit-not-success，因此具体 TCC 主体与 preflight 证据来自本次系统日志，而非应用返回字符串。

## 实际代码缺口

Desktop Host 注入 `hostInstanceId`、Agent startup 固定 runtimeIdentity、bootstrap create-app 注入 cuaLaunchIdentity、CommandInbox 登记 live ticket 已存在，不应重复实现。core/runtime/cua/CONTRACT.md 中“尚未接 bootstrap/CommandInbox”的旧描述已落后于源码。

仍缺的是从真实 runtime 的唯一 authority 到原生消费者的可信连接：

- coordinator 的现有生产路径没有调用 bindTurn；现有 producer port 只 resolve/revoke，不能建立本次真实 turn 的绑定。
- R11 authority-entry 仍为独立开发调用创建 authority，orchestrator 自造开发身份；这些不能代替运行中 Desktop 的 ref。
- `packages/zcode-cua/broker-server.js` 的 createProductCuaHelperHost 仍返回 unavailable。缺少产品侧已封装代码与 Helper 之间可信、可复核的传输，不能给任意 Node 传一个 FD 就宣布生产接线完成。

最短正确顺序是确定 runtime 自有 turn/run 绑定及旧 binding 清理规则，用同一个 authority 接到可信 producer/Helper，再以真实 Desktop 提交驱动一次截图与撤销。不能直接采用调查建议中的任意 bindCurrentTurn(runId/turnId) 公共入口，也不能让旧清理操作按新的 currentRef 清理另一条 lineage；这些约束应先进入 spec，再由 DeepSeek 实现。当前尚未下发实现任务，不把端口草案当作已完成接线。

独立 TCC 权限和代码接线可以分别推进，但权限获批本身不能消除上述产品缺口。输入 Fenced、完整D06、Intel/最低系统与产品开放也不在本次开发链成功结论内。

## 来源

controller 已独立读源码复核；DeepSeek 调查 worker：`broker:deepseek-flash-ro-989625ff4f43c3ef:01a18852-7662-7fa1-826e-520bae3707f0`，路由 deepseek-flash / magpie / commandcode-plan/deepseek/deepseek-v4.1-flash，只读、无 UI grant，已结束。

实际启动参数、结果、当前窗口元数据和限定本 Helper 的 tccd 日志见 `evidence/independent-launch/`。同目录 DeepSeek 报告为调查建议，不是验收结论。R11 原签名候选、57文件源码及冻结归档未修改。

必要仓库检查：freshness ahead31/behind0；architecture 0 violations；root typecheck 通过，lint 301 warnings/0 errors。只读/文档工作没有新增行为测试。
