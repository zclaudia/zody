# R01 重命名契约映射

状态：目标规格，尚未实现。当前源码仍使用旧名称；各任务必须先补测试。共享常量、严格 schema 与错误类型由 R40 定义并经公开入口导出；下游不可另造兼容判断。

| 任务    | 边界与唯一 owner                                                                                  | 目标与验收                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R40–R43 | stdio、两套 HTTP、手机 channel；详见 [运行时契约](../../../specs/zody-rename-runtime-contract.md) | 代际 2 精确匹配；认证和授权仍独立；失败不注册业务、清理资源；R43 验证运行实例而非 marker。                                                                                        |
| R44     | shared channel 常量；Main 是原生操作 owner，preload 是桥，renderer 经 IPlatformService            | 主桥/IPC 名称由清单成组 zody 化，两端同批；iframe 插件桥不属于此批。                                                                                                              |
| R45     | artifact 生成与解析边界                                                                           | 只生成并解析 `zody-artifact://`；旧 URI 不迁移、不打开；历史会话其余内容仍加载。                                                                                                  |
| R46     | 事件产生者                                                                                        | 遥测名称 zody 化，仅发一份新事件/指标，历史看板断代；不双发。                                                                                                                     |
| R47     | 实际配置来源与 shared digest/trust store                                                          | 审批绑定实际来源路径、内容和原 schema 的摘要；改名不重新计算成新来源，不转移审批；未知记录 fail-closed。                                                                          |
| R50–R53 | shared 插件规则；各宿主/CLI 实际接收边界                                                          | 登记字段新旧键归一；双键规范化相等才接受，冲突或非法拒绝且不扩权。方法双 handler 指向同一 owner，发送端每次只发一个，不盲目重试。                                                 |
| R54     | 插件发现/安装 owner                                                                               | `.zody-plugin/plugin.json` 存在时优先，非法则报错不回退；缺失才尝试 `.zcode-plugin/plugin.json`，其余格式按各 owner 的既有相对顺序；不合并 manifest。seed、升级沿用同一发现规则。 |
| R55     | 权威插件上下文                                                                                    | ROOT、DATA、ID、NAME 的两套插件 env 从同一上下文注入；ROOT/DATA 模板两套前缀同源，外部环境不得分别覆盖。其他 ZCODE env 不获兼容。                                                 |

适配运行时旧插件名至 1.0；1.0 前一个 minor 发退役警告并验证官方插件。1.0 移除运行时别名和旧 manifest 发现，历史结果解析单独评估；`zcode-sandbox://` 与 `persist:plugin-sandbox-v2-*` 保留 origin 例外。市场 ID、来源和签名不重命名。

## R40–R42 原子 wire 变更表

以下文件均为 P2 前路径；R40 持有 shared schema/常量，R41/R42 各持有本表调用端，主控在合入前统一切换。RemoteServer stdio 和 Agent stdio 不共享 hello schema。

| 字段 / 方法                    | 旧 → 新                                                                                                              | 生产者 → 消费者；文件 owner                                                                                                                                                   | 顺序及原子集合                                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RemoteServer hello             | `{type:"zcode-hello",version,platform,arch,pid}` → 严格 `{type:"zody-hello",version,platform,arch,pid,generation:2}` | `packages/server/src/entry-stdio.ts` → `packages/server/src/remote/handshake.ts`；R41，schema R40                                                                             | server 首帧；client 识别旧类型立即拒绝，不写 ack；同代确认后写 ack，再移交剩余 bytes。                                                                                                                                       |
| RemoteServer ack               | `{type:"zcode-hello-ack",version,clientId}` → 严格 `{type:"zody-hello-ack",version,clientId,generation:2}`           | `remote/handshake.ts` → `entry-stdio.ts` 的 `waitForAck`；R41                                                                                                                 | server 验证完整帧及代际后创建 services/RPC；任何旧/缺失/额外字段或错误均拒绝。ack 后同 chunk 数据原样移交 RPC；EOF/取消移除监听并释放资源。hello、ack、schema 和双端在同一发行原子切换。                                     |
| HTTP `renameGeneration`        | 无 → `renameGeneration: 2`                                                                                           | 两个 `http.ts` `/api/server-info` → `packages/web/src/main.tsx`、`packages/desktop/src/host/serverRemoteConnection.ts`；R42，schema R40                                       | 鉴权后获取；普通 Web 与 remoteId 均无缓存读取并验证，再建立 WS；缺失/错误不继续。                                                                                                                                            |
| `x-zody-generation`            | 无 → 唯一值 `2`；旧 header 不等价                                                                                    | Desktop Host → 两个 HTTP 实现 `/api/rpc-host-capability` 与 `/ws/host`；R42                                                                                                   | 鉴权→检查代际→签发/消费一次性 capability→upgrade→注册 channel。generation 不是授权，不能消费无效代际请求的 capability。                                                                                                      |
| WS 子协议                      | 无 → `zody-generation-2`                                                                                             | `packages/client/src/websocket.ts` 发起 → 两个 HTTP 实现 `/ws`、主 server `/ws/remote/:id`；R42                                                                               | 浏览器先验证 server-info，再请求子协议；服务端选中后 upgrade，客户端验证 `socket.protocol` 后创建 ChannelClient/发送 RPC。拒绝 upgrade 用 HTTP 426 状态，不要求 body；客户端显示不兼容诊断并关闭。                           |
| 手机 channel `protocolVersion` | `1` → `2`                                                                                                            | `packages/web/src/mobile-remote/gatewayTerminalTransport.ts` 的 hello → `packages/desktop/src/main/remote-access/gatewayDeviceTransportHello.ts`；R42，shared 常量/schema R40 | 固定 2；数值与 `ZODY_RENAME_GENERATION=2` 相同但各自独立字段和含义，不由产品版本推导。hello 验证后协商 appProtocol、回复 hello_ack，才允许 data/replay；不兼容 `close{incompatible-version}`。gateway 只转发，本仓双端完成。 |

Agent stdio（`packages/services/src/zcode-agent/zcodeStdioTransport.ts` 与 CLI bootstrap 的 zcode-protocol server）承载 LF 分帧 JSON 消息并按 `zcodeProtocolMessageSchema` 校验，不发送上述 RemoteServer hello/ack。R41 将其登记的 wire 名称及 CLI 对端成组改名，保留请求/响应关联、顺序、UTF-8 分片、stderr 分离、EOF 与进程树清理；不要注入 RemoteServer 握手或改写 V4 连接层既有 hello/clientHello。该链路的原协议行为与 RemoteServer 双向代际门禁分别测试；不得以 Agent transport seed 代替 `waitForAck` 测试。

## R54 各发现 owner 格式顺序

新 `.zody-plugin/plugin.json` 放在每个入口最前；存在但非法即失败，不回退或合并。以下为其后保留的现有相对顺序（`Z` = `.zcode-plugin/plugin.json`，`C` = `.claude-plugin/plugin.json`，`X` = `.codex-plugin/plugin.json`，`U` = `.cursor-plugin/plugin.json`）：

| owner（P2 前路径）                                            | 新格式之后的现有顺序 / 职责                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts`       | Z → C → X；加载插件                                                       |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | Z → C → X；市场安装与元数据                                               |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`  | Z、C、X 为存在性探测；新格式也参与探测，不改变其他探测顺序                |
| `apps/zcode-cli/packages/adapters/src/skills/index.ts`        | Z → C → X → U；各祖先层级维持既有遍历顺序，新格式非法必须报错而非继续探测 |
| `packages/services/src/skills/skillsService.ts`               | Z → C → X                                                                 |
| `packages/services/src/commands/commandsService.ts`           | Z → C → X                                                                 |
| `packages/services/src/subagents/subagentsService.ts`         | Z → C → X                                                                 |
| `packages/services/src/settings-sync/settingsSyncService.ts`  | Z → C → X                                                                 |
| `packages/services/src/plugin-sync/pluginSyncService.ts`      | Z → C → X；同步时包含新格式                                               |

R54 同步 bootstrap seed/official runtime、打包及安装升级的调用者；每个 owner 新格式可发现，双文件及非法新文件均测试。Claude/Codex/Cursor 支持与顺序不因 1.0 旧 ZCode 退役而删除。

## R55 精确插件 env 与模板

权威上下文提供 root、data、id、name。构造子进程 env 时先继承宿主环境、合并 manifest 自定义 env（其他键保留既有行为），最后覆盖身份键：`ZODY_PLUGIN_ROOT/DATA/ID/NAME` 与 `ZCODE_PLUGIN_ROOT/DATA/ID/NAME` 分别取同一 root/data/id/name；`CLAUDE_PLUGIN_ROOT/DATA` 同取 root/data。上下文不存在时不凭外部值伪造身份；各消费者需保持缺失上下文的原错误语义。保留其他既有 Claude 环境及模板，不新增 `CLAUDE_PLUGIN_ID/NAME` 契约。`ZCODE_CUA_PLUGIN_ROOT` 是内置专用变量，由 R30 硬切为 `ZODY_CUA_PLUGIN_ROOT`，不属于 R55 的通用插件双注入。当前注入源为 `apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts` 的 CUA package root；真实消费者为 `apps/zcode-cli/packages/node-repl-host/src/node-repl-session-executor.ts`；`apps/zcode-cli/packages/zcode-cua-plugin/skills/computer-use/SKILL.md` 也引用该变量。R30 须同时切换这些生产、消费和 skill 引用，保持其现有 fallback 次序及 CUA 定向语义。

模板仅新增 `${ZODY_PLUGIN_ROOT}`、`${ZODY_PLUGIN_DATA}`，与既有 `${ZCODE_PLUGIN_ROOT}`、`${ZCODE_PLUGIN_DATA}`、`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 从同一上下文展开；不承诺 ID/NAME 模板。hook、MCP、shell expansion、official runtime 和 built-in node-repl 均覆盖各自支持的键；不改变其他 session/project/skill token 的既有规则。1.0 移除本节旧 ZCODE 插件 env/token，保留 CLAUDE 兼容；普通旧 `ZCODE_*` 不因此获得别名期。
