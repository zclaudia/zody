# R42 精确实施预检

基线：R30 产品提交 `be2f33cd`、文档基线 `b2c29bf6`；本次只读源码与计划，未运行测试/构建/安装。R40 正在共享接口/协议实现，**必须等其固定接口及提交后再实施**，消费其唯一 generation 检查、schema 和手机 channel 常量，不复制一套判断。`file-assignments.json` 的 R42 是 structural-seed-not-authorized、旧路径包含 `zcode-server-cli`；以下是真实当前 `zody-server-cli` 闭包，需主控依任务卡补充并锁定写集，不能把清单当已获得跨 owner 写权。

```mermaid
sequenceDiagram
  participant W as Web / Desktop Host
  participant H as HTTP server
  participant C as capability store
  participant G as gateway (relay only)
  participant D as existing Desktop attachment
  W->>H: authenticate + GET server-info (no-store)
  H-->>W: renameGeneration=2
  Note over W,H: Desktop Host only
  W->>H: authenticate + generation + POST capability
  H->>C: issue once after both checks
  W->>H: authenticate + generation + capability /ws/host
  H->>C: consume after both checks; upgrade; desktop-continuous
  Note over W,H: Browser /ws or /ws/remote/:id
  W->>H: authenticated upgrade with zody-generation-2
  H-->>W: select exact subprotocol before RPC
  W->>G: hello channel protocol 2 + appProtocol range
  G->>D: relay hello to existing Host attachment
  D-->>G: hello_ack channel protocol 2 + negotiated appProtocol
  G-->>W: relay ack; only then data / replay
```

## HTTP 与 Desktop Host

- `packages/server/src/http.ts:174–190,310–342` 由 `createServerInfo` 生产当前 info；现有 token/origin/Host 校验在路由前，保持它们的优先级和安全语义。`/api/rpc-host-capability` 的 generation 验证置于 issue 前；`/ws/host` 验证置于 `hostCapabilities.consume`（361–368）前，然后才 upgrade 和 `setupChannelServer`。不能先 consume 再返回 426。`/ws`、`/ws/remote/:id` 的浏览器协议在 upgrade 前检查；远端 Map 的 `get/delete` 仍只在有效升级后（398–422），无效请求不能偷走 remoteId。
- `packages/zody-server-cli/src/server-core/http.ts:125–180` 是另一套实现，保持 loopback-only fail-closed（未配置远程 token 认证，不要假造认证能力）；info 增字段、capability issue/consume 顺序和 `/ws` 规则与主 server 一致。当前无 `/ws/remote/:id` 路由，不增加未要求的远程 Host。失败 HTTP 为 426+约定 JSON，upgrade 为状态 426；auth/origin 错误仍先返回原错误，不因版本暴露受保护信息。
- `packages/desktop/src/host/serverRemoteConnection.ts:161–198,201–270` 先 info schema+R40 generation 确认再发 capability；在 capability POST 与 Node `/ws/host` 握手附 `x-zody-generation: 2`。info 设置 no-store；失败时不申请 capability、不建 ChannelClient，关闭 socket、移除 listener，任何日志/错误不含 token。应保持 URL 子路径和身份参数处理。
- 重复代际 header（包括 wire raw header 重复与逗号合并）、空/字符串/错值/旧 header 均需严格拒绝；注意 `Headers`/Hono 可能合并值，校验必须保留重复信息而不是只 `Number()` 后接受。可信单次 capability 未被错误代际请求消费，再以正确代际同一 token 成功，然后再次重放失败。

## 普通 Web、remoteId 与协议选择

- `packages/web/src/main.tsx:48–77` 现有 remoteId 提前返回且普通路径对 fetch 失败返回 wsUrl；两者都会绕过门禁。改为两分支均无缓存取 `/api/server-info`、严格调用 R40 接口，异常/缺失/旧值终止并显示兼容错误，不能 catch 后继续。remoteId 仍原样用于 `/ws/remote/:id`，不得丢失 workspace identity。
- `packages/client/src/websocket.ts:57–104` 当前 `new WebSocket(wsUrl)`、open 即 `ChannelClient`。发起时显式请求 shared 定义的 `zody-generation-2`，open 后核实 `ws.protocol` 精确一致再触发 onOpen/创建 SocketProtocol/业务 RPC；未选中则关闭与拒绝、清理监听，不发生业务消息。
- 两个 HTTP 实现需要 upgrade 前拒绝缺失/错误协议，且服务器**实际选中**要求协议；不能只检查请求包含目标。当前本地 `@hono/node-ws/dist/index.js` 在 `createNodeWebSocket` 创建 `WebSocketServer({noServer:true})`，未配置 `handleProtocols`，默认 ws 选择首个提议；如果客户端提议 `other, zody-generation-2`，仅检查包含会选错。R42 须以当前依赖可行方式显式选中，避免影响仅用 header 的 `/ws/host`；真实 HTTP upgrade 测试覆盖单个、顺序反转、无协议/错误值及拒绝 426，不能只用 mock 检查 header。若 ws 客户端未选择协议/旧服务端握手失败，浏览器不一定暴露 HTTP status/body；用户可见兼容诊断依赖 info 检查及连接失败处理，不能假设读取 WS 426 body。

## 手机双向握手与现有 Host

- 主控已明确：R40 先更新 runtime-contract 并将 **hello_ack 的 `protocolVersion: 2` 加入严格 type/schema**；此版本是独立 channel 版本，与 renameGeneration 和 appProtocol 不混同。`packages/shared/src/web-remote-control-channel.ts` 为 R40 唯一 owner；R42 在 `packages/desktop/src/main/remote-access/gatewayDeviceTransportHello.ts:55–114` 使用 R40 常量/类型，仅在 hello 的版本与 appProtocol 均通过后送含 channel 2 的 ack；`packages/web/src/mobile-remote/gatewayTerminalTransport.ts:621–749` 校验 ack 的相同字段及 appProtocol 后才 ready/onSendReady。不能将 appProtocol 的范围值当代际字段，也不能添加第二份 shared 判断。
- 现有共享 schema 的 hello 做正整数形状校验、hello_ack 无 protocolVersion；当前 gateway inbound 在 `parse...` 返回 discarded 时直接丢弃。因此 R40 接口落地后须针对可识别 hello/ack 的缺失、1、其他数字、字符串、多余/非法字段按合同发/进入 `close{incompatible-version}`，不能默默 timeout 或在 malformed 时放过。保持严格 schema，不把未验证的帧交业务；普通不相关 malformed 帧仍按既有安全规则处理。新手机↔旧桌面/旧手机↔新桌面均无 ack 前 data、订阅、恢复。
- `gatewayDeviceTransportInbound.ts:50–66` 和手机 `gatewayTerminalTransport.ts:750+` 已以 ready/appProtocol 阻断 data；保留既有 close、superseded、心跳和清理。`packages/desktop/src/main/webRemoteControlManager.ts:1020–1065` 通过 `attachWorkspaceHost` 取得现有 window-scoped Host attachment，携带 workspacePath、workspaceIdentity、remoteSessionId；`packages/web/src/mobile-remote/bootstrap.tsx:1530–1617` 释放旧 owned RPC client/relay 再替换。改门禁不要调用启动 Host/Agent 的新路径；断线只清理 attachment，重握手完成后恢复 replayable，远程身份及 session 不按 path 单独匹配。Desktop `/ws/host` 保持 `desktop-continuous`，普通 `/ws`/remote 与手机 attachment 保持 `web-remote-replayable`；不可将任一实时流替换为另一种恢复语义。

## 现有测试与最小补充

1. `packages/server/test/serverInfoHttp.test.ts` 已测 info、token、origin/host；新增主 server 与 `packages/zody-server-cli/test/coreHttp.test.ts` 对称的 generation/重复 header/严格 issue-consume 顺序、HTTP 426 和 real WS upgrade 方案；前者同时测 `/ws/remote/:id` 拒绝后 remoteId 不被消耗。两套的旧浏览器、新浏览器、旧 Node Host、新 Node Host 双向失败不得注册 RPC/消耗 capability；同代路径保留两种 clientMode。
2. `packages/desktop/test/serverRemoteConnection.test.ts` 加旧/缺失/错误 info 在 POST/WS 前失败、请求头与 token、一次性 capability 和 socket 清理；`packages/client/test/zodyRenameWebsocket.test.ts` 新增真实/受控 server 的协议选择、错误选择/旧 server 不发送 RPC；`packages/web/test/zodyRenameBootstrap.test.ts` 覆盖普通/remoteId 两种 no-store 校验、错误可见、不连接，以及目标变化后的二次协议防护。若测试需要提取 `main.tsx` 私有函数，应在 R42 明确列入可写文件，避免通过挂载整应用隐式覆盖。
3. `packages/desktop/test/gatewayDeviceTransport.test.ts` 已测版本不等、appProtocol 协商和替换；`packages/web/test/mobileRemoteGatewayTerminalTransport.test.ts` 已测 ack 前断开、协商失败和重连。补两方向 channel 2/1、缺失、非法、额外字段、ack 未到的 data/订阅/重放、成功 ack 后正常恢复及 listener/attachment 计数；配合 `packages/desktop/test/remoteWorkspaceServicePortBridge.test.ts` 和 `packages/web/test/webRemoteControlWorkspaceBridgeSession.test.ts` 验证两个独立 Host 同路径 identity、remoteSessionId 以及旧 attachment 清理。现有 `packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-host-identity-isolation.test.ts` 的真实移动设备/浏览器场景提供无新 Host/Agent 的最终证据，unit/mock 不代替实际 E2E。

测试执行及完整路径授权由主控在 R40 固定后安排；本报告不宣称任何 R42 实现或验证通过。

## 附录：现装 Hono/ws 的指定子协议选择

只读检查现装 `@hono/node-ws` **1.3.0** 的 `dist/index.d.ts`、完整 `dist/index.js` 及现装 `ws` **8.20.0** 的 `lib/websocket-server.js` 和 `@types/ws/index.d.ts`；未运行握手测试。`createNodeWebSocket({app, baseUrl?})` 的公开 init 无 WebSocketServer 构造选项；其 `upgradeWebSocket` 的 options 只有 `onError`，也无选择协议 hook。但返回对象公开了 `wss: WebSocketServer`；`@types/ws` 声明实例 `options: ServerOptions` 可写，`ServerOptions.handleProtocols` 的类型为 `(protocols: Set<string>, request: IncomingMessage) => string | false`。适配器内部创建 `new WebSocketServer({noServer:true})`，每个 HTTP server 得到独立实例；`ws` 在每次 `handleUpgrade` 的 completeUpgrade 中动态读取 `this.options.handleProtocols`，没有 hook 时选 `protocols.values().next().value`。

可在现有两套 HTTP 布局里，各自获取返回的 `wss`，在 `injectWebSocket(server)` 前为**该实例**配置其公开 `wss.options.handleProtocols`：以原始 `request.url` 的 pathname 区分 `/ws` 和 `/ws/remote/:id`，对这两类在合法 offer 集合中明确返回 R40 的目标子协议；因此实际 offer `[other, zody-generation-2]` 也会选择目标。对 `/ws/host` 保持现有 Node Host 行为，若它提出协议则沿用原首项选择；未提出协议时 `ws` 不调用 hook。这个配置不更改全局、不覆盖 `handleUpgrade`，不需要新 transport 或修改依赖；它依赖当前 `ws` 暴露且在类型中可写的实例 options，既有类型和实现支持，但不能声称未来版本未经验证也必然保持相同动态读取行为。

**hook 不负责 426 拒绝**：当前 `ws` 实现中 hook 返回 `false` 仅不追加 `Sec-WebSocket-Protocol`，仍继续 101 upgrade。因此在调用 Hono 的 `upgradeWebSocket` 前先在对应路由执行 origin/token 后的严格 offer 校验，缺失、错误或格式非法直接返回 426；合法才建立 waiter/upgrade。返回列表中目标前后出现其他合法协议均应选择目标，不能只检查 contains 后留给默认首项。显式 hook 只返回真实 offer 中的目标，绝不凭空回一个未请求值。对 `/ws/host` 不强制该浏览器协议；其 generation/capability 校验独立。header 及原始请求处理需维持各路由的认证先后与现有 upgrade 清理。

若不采用实例 options 配置，仅用当前默认选择器的最小安全替代是路由**严格只接受单个目标协议**（或至少要求目标为首项），其他在前即 426，而不是接入后才发现选错；这会拒绝本来包含目标的多协议客户端，缩小互通范围，不满足本次所需“其他协议在前仍选目标”的期望。新 transport helper 仅在主控不接受实例级公开 options 配置、或后续依赖版本不再支持上述动态读取时才有必要：它至少须保留 Hono 鉴权/路由先行、正确 426 和资源清理、按路径选择协议、原有 raw WS 的 onOpen/close/error 及 `desktop-continuous`/`web-remote-replayable` 连接所有权；不能简单替换成另一个独立 upgrade listener 绕过中间件。实施测试应实际建立两套 server，发 `other, zody-generation-2` 及反序 offer、缺失/错误 offer，断言服务端 101 响应选中目标或 426，且 `/ws/host` 正常，仅在正确选择后创建 RPC；本预检没有执行这些测试。
