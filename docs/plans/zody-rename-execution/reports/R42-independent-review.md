# R42 independent review

Broker reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a3fa-9ff5-7530-93dc-c253ccfcbfd1`; `deepseek-flash` / `magpie` / `group/deepseek`, read-only; baseline `71acf64f`, 2026-11-04.

**R42 限定范围复核结论：通过，未发现具体代码回归或阻断。**

范围仅限 `metadata.json` 的 17 个 R42 文件；其 SHA-256 全部与元数据一致，R41/R44 变更未纳入判断。

**已核关键路径**

- `packages/server/src/http.ts:48`、`packages/zody-server-cli/src/server-core/http.ts:36`：token/origin 中间件先于 generation gate；gate 先于 capability 签发/消费，`/ws/remote/*` 的旧代际请求不会消耗 remoteId。
- 两套 HTTP 的 `wss.options.handleProtocols`（`packages/server/src/http.ts:341`、`packages/zody-server-cli/src/server-core/http.ts:163`）会在其他协议排首项时仍选择 `zody-generation-2`；浏览器入口同时 fail-closed。
- `packages/client/src/websocket.ts:65`：构造 RPC 前核对选中的子协议，错误协议不会触发 `onOpenSocket`。
- `packages/web/src/renameCompatibility.ts:5`：普通与 `?remote=` 路径都先 no-store 校验 server-info，失败不返回可连接 URL。
- `packages/desktop/src/host/serverRemoteConnection.ts:165`：Host 先校验 info 代际，capability POST 和 `/ws/host` 均携带 generation header。
- 手机端 `gatewayDeviceTransportHello.ts:101`、`gatewayDeviceTransportInbound.ts:137` 与 `gatewayTerminalTransport.ts:670`：hello/ack 都验证 channel 2；旧、缺失、字符串和更高版本均返回 `incompatible-version`，错误 ack 不会提前 ready 或发送业务数据。
- attachment owner、identity、`remoteSessionId` 以及 continuous/replayable 语义未见 R42 diff 改变；既有 bridge/attachment focused tests 通过。

**证据**

- 原始 focused：9 文件 99/99，`red-websocket.log` 及 duplicate/remote-id 失败日志均保留。
- 主控固定 Node 24.14.0/pnpm 10.33.2 的 `focused-controller-01`：12 文件 162/162，exit 0，覆盖全部 9 个 R42 文件及 bridge/handshake 关联测试。
- 主控 root typecheck/lint/architecture 均 exit 0；lint 仅 303 个既有 warnings。
- 本轮未运行 install/build/test/services，未重审 675 文件。

**保留验证门禁**

R42 代码范围可进入后续验证，但不得宣称完整集成或 release 通过。Desktop 真实 smoke 仍由独立 owner 执行；真实手机、gateway、browser E2E 及 `mobile-host-identity-isolation` 仍按 R48/E2E 流程验收。
