# R40 Agent metadata 独立验收

DeepSeek 经 Broker `deepseek-flash`、`magpie/group/deepseek` 只读审查，agent 为 `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a46c-fb33-7720-8cee-047c7ae90cb1`。最终结论：本批源码层面的改名、重订阅、身份传递与去重验收通过，可进入精确清理。最终源清单 SHA-256 为 `f3f9f99095f8ef8994bbe38aa9225130850e2a8c8f36619b0ecfd58c2cba2ca1`，18 可写与 6 只读路径共 24 项匹配。

产品变更限定于六个文件中的已确认 `apiRetry`、`taskNotification`。只读字段来源和外部合同未改变；direct/runtime 优先级、normalizer 默认值及 null 清除语义保持基线。历史 raw 不迁移，正文可重新派生新通知，旧-only metadata 不作为新字段 alias。既有 backgroundAgent 输出文件回退保留，不能据此把其他未知来源字段宣称为第三方或永久例外。

首轮产品代码未发现阻断，但缺少重连与隔离的直接证据。补测验证真实 adapter 的两种 delivery 重订阅、真实 RPC channel 重建下 tracker 的身份隔离、重复正文与重复 SQLite restore 的稳定派生，以及实际 AgentService 加两个受控 Node 对端的独立 owner 和每订阅重复 eventId admission。第二轮发现仅设 remoteSessionId 输入和比较 PID 不足以证明传递；最终从实际 `v4/conversation/subscribe` 请求日志断言 A 两次、B 一次的 workspacePath、workspaceIdentity、remoteSessionId 配对，补齐该缺口。生产文件在补测期间未改。

根定向 250、CLI 协议组 116 通过；其他定向组及重跑有重叠，不累计为唯一测试总数。新增 owner case 的 48 个 skip 来自 `-t` 选择，不代表完整文件已运行。最终根 typecheck、lint 均退出 0，Lint 303 条既有警告；架构检查 0。已有格式问题和原始红测、订阅屏障、normalizer 预期、traceId 比较失败日志均保留。三轮审查摘要在 `output/zody-rename-r40-agent-meta/controller/`，最终复核仅针对缺口修正，没有无谓重跑原已过检查。

上述结果证明受控源码边界中的请求传递、重订阅和状态行为，不证明 remoteSessionId 单独作为隔离键，也不代表真实网络掉线、手机、远端实际 Host、用户数据库、完整 GUI/E2E、R48 或发行通过。
