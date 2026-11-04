# R40 Agent metadata：限定范围实施记录

基线 `fe99c9a4531aaeead982826c2be6c5cf3f929c89`。本批仅将已确认的 live `_meta.zcode.apiRetry` 和 `_meta.zcode.taskNotification` 写入与消费切到 `_meta.zody`。新对象只合并既有 zody 子对象；旧 zcode 及其他 raw 字段保持原样。`backgroundAgent.outputFile` 保留旧展示回退；nickname、agentType、color、toolName、parent 身份及外部 metadata 未因前缀改写。direct/runtime retry 保留现有优先级。R42 phone app5 段保留。

历史 projection 由用户正文 `<task-notification>` 按 toolUseId 独立派生新字段；old-only raw 不被作为 alias，legacy direct-return 不重投影。合成 SQLite 测试关闭并重开数据库，验证 raw JSON 原字节 SHA、旧 metadata、正文派生及无正文旧 raw；UI 测试覆盖旧通知不展示、原 backgroundAgent outputFile 回退和新通知优先。这不是实际用户数据库验证，也不声称旧数据真实存在 apiRetry。

规格与时序图先行，shared mixed raw 测试先红后绿。根 focused 5 文件 250 tests 通过；CLI `zody-protocol.test.ts` 加实际 mapper/NDJSON LF 输出组 116 tests 通过。其后独立 mapper LF 重跑 2 tests、RPC retry tracker 1 test 均通过，属于与上述或各自组重叠/独立的定向验证，不相加；实际 task adapter 的 ChannelServer/Client 往返位于既有 `zodyLegacyTaskCompatTaskIndex.test.ts` 并已包含于根 250，位置依据 controller addendum-1。测试以合成 Agent 上游驱动真实 adapter 和 retry tracker；不声称实机或完整端到端。

`rpc-priority` 对非空未知对象期待无更新而失败；基线 normalizer 事实上将非空对象归一为默认 retry，controller addendum-2 确认本批保留原语义。最终测试覆盖空对象、数组、标量不更新，null 清除，非空对象按既有默认处理，以及 direct 字段存在优先、runtime 无效时回退新 metadata。失败记录未删除。实际 RPC tracker 验证不同 workspaceIdentity 不共享状态；没有运行真实手机、远端 Host 或产品 GUI。

前置 freshness 和 changed architecture 通过；shared/services/ui/zcode-cli 在 architecture registry 均 `managed:false`，context 输出不证明其运行时语义。范围初始 formatter 检查 12 个现存文件中 7 个已有格式问题，未全文件重排；CLI session mapper 的基线也已有格式问题。完整 argv、合成 HOME/TMP/XDG 环境、退出码、原始日志和 SHA 见 `output/zody-rename-r40-agent-meta/implementation/`。根 typecheck/lint/architecture 由 controller 在冻结后执行；本报告不推断其结果。R47、ready FD 生命周期、真实发行与用户数据均未验证或修改。

追加的受控重连证据见 controller addendum-3：真实 task adapter 经 RPC 按 continuous/replayable 退订、重订阅，观察上游 identity、delivery 和 includeSnapshot；真实 retry tracker 在 RPC 断开重建后，对同路径/sessionId 的不同 workspaceIdentity 保持隔离。SQLite 合成历史写入后关闭重开，重复同一 toolUseId 正文经两次恢复及两种 delivery 投影仍得到一个工具结果，原始 JSON 不变；这里验证历史投影，不宣称 live 网络自动去重。实际 AgentService 使用两个受控 Node 子进程，输入各自不同 workspaceIdentity 和 remoteSessionId；每次订阅返回重复 eventId 时各 owner 各交付一次，一侧退订重订阅后只该侧新增一次，进程标识互异；实际 v4 subscribe 请求中两次 A、一次 B 的 workspaceIdentity 与 remoteSessionId 配对均符合输入。该证据覆盖受控 service owner 和重订阅，不证明真实网络断连或 remoteSessionId 单独作为隔离键，更不代表真实手机或远端 Host 通过。首次历史恢复测试错误地比较每次自动生成的 traceId 而失败，后改为比较业务 messages；失败日志保留。
