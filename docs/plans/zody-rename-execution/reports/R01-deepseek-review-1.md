Reviewer: broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5
Route: deepseek-flash; model: group/deepseek; access: read-only.

**结论：CHANGES_REQUIRED**

R01 的边界描述基本可读，`R10` 可基于当前文档先行；但按 R01 任务卡的交付标准（`docs/plans/zody-full-divergence-rename-execution-plan.md:123`），接口表、真实 runner 映射和消费者 owner 仍不完整，`R40/R41/R42/R54/R55` 不应按现稿直接派发。

**阻断项**

1. **阻断：contract-map 缺少字段级接口表。**  
   `docs/plans/zody-rename-execution/contract-map.md:5` 只有任务级摘要，没有按 `zody-hello`/`zody-hello-ack`、`renameGeneration`、`x-zody-generation`、WS 子协议、channel `protocolVersion` 逐项列出生产者、消费者、文件 owner 和原子切换集合。执行计划 `:174-176` 明确要求 R40 的原子改名集合必须来自 contract-map；当前无法冻结 R40 接口。建议在 contract-map 增加字段/方法表，并标出旧实现、新实现、双端切换顺序与待决项。

2. **阻断：stdio 测试映射与真实两端不一致。**  
   `docs/plans/zody-rename-execution/test-map.md:9` 的 `RENAME-REMOTE-STDIO` 只列了 `stdioLifecycle`、客户端 `remoteConnect` 和 `zcodeStdioTransport`；其中 `packages/services/test/zcodeStdioTransport.test.ts:1` 测的是 Agent stdio transport，不是 `zcode-server` 的 hello/ack。服务端 `waitForAck`（`packages/server/src/entry-stdio.ts:90`）没有任何对应测试，而客户端握手在 `packages/server/src/remote/handshake.ts:20`。R41 卡还把 `services` Agent stdio 和 CLI stdio 对端列入写范围（`...execution-plan.md:181`），可能误改另一套协议。建议新增 `packages/server/test/stdioHandshake.test.ts` 或扩展 `remoteConnect.test.ts`，明确覆盖服务端严格 ack、新旧双向拒绝、EOF/取消清理和 remaining buffer；把 Agent transport 测试标为无关 seed。

3. **阻断：浏览器 `/ws` 子协议缺少客户端 owner，R42 无法在其声明 writeSet 内闭环。**  
   运行时契约要求浏览器验证 `zody-generation-2`（`specs/zody-rename-runtime-contract.md:10`），服务端入口在 `packages/server/src/http.ts:346` 和 `packages/zcode-server-cli/src/server-core/http.ts:156`。但浏览器客户端 `packages/client/src/websocket.ts:62-67` 仍是 `new WebSocket(wsUrl)`，没有 protocols；`packages/web/src/main.tsx:48-77` 的 `remoteId` 分支直接返回，不做 `server-info`/`renameGeneration` 校验，`:97` 连接时也不验证 `ws.protocol`。R42 写范围（`:189-192`）只列了 server 端和 Desktop host，未把这两个文件列入 owner。建议把 `packages/client/src/websocket.ts`、`packages/web/src/main.tsx` 及其测试纳入 R42/R40，连接前校验 `renameGeneration`，open 后校验 `ws.protocol` 再发 RPC。  
   非阻断提醒：`@hono/node-ws` 在 upgrade 被拒时只写裸状态行和 `Content-Length: 0`（`node_modules/@hono/node-ws/dist/index.js:69-78`），`/ws/host` 的 426 JSON body 不会送达 WebSocket 客户端；需明确接受 status-only，或自管 upgrade 响应。

4. **阻断：手机 channel 可仅 repo 内实施，但版本值和 consumer/test owner 未钉死。**  
   `specs/zody-rename-runtime-contract.md:11` 只说“增至新代际”，没有写死 2，也没有说明是否等于 `ZODY_RENAME_GENERATION`；现有 `specs/mobile-remote-control-via-gateway.md:162` 仍写 `protocolVersion: 1`，共享常量 `packages/shared/src/web-remote-control-channel.ts:32` 也是 1。真正的手机端在 `packages/web/src/mobile-remote/gatewayTerminalTransport.ts:626-633`，其测试 `packages/web/test/mobileRemoteGatewayTerminalTransport.test.ts:511-517` 会硬编码版本；桌面接收端在 `packages/desktop/src/main/remote-access/gatewayDeviceTransportHello.ts:57`。`test-map.md:11` 只列了桌面 gateway transport 和 E2E，漏了手机 Web 单测与 `packages/web` owner。建议明确 `protocolVersion = 2`（或独立字段）并同步 gateway spec，把手机 Web transport 和测试加入 R42；repo 内实施本身可行，因为 gateway 只转发且手机 Web bundle 在本仓。

5. **阻断：插件 manifest/env 接口仍有格式与顺序缺口。**  
   `contract-map.md:13` 的优先级只写到 `.zody-plugin` > `.zcode-plugin` > Claude > Codex，但现有 skills 发现还支持 `.cursor-plugin`（`apps/zcode-cli/packages/adapters/src/skills/index.ts:30-35`）；同时多个 manifest 读取器各有自己的顺序：`packages/services/src/skills/skillsService.ts:63-65`、`commands/commandsService.ts:50-52`、`subagents/subagentsService.ts:89-92`、`settings-sync/settingsSyncService.ts:416-418`、`plugin-sync/pluginSyncService.ts:78-82`。R54 写范围只点名了 adapters/bootstap/plugin-sync，未覆盖这些 services 入口；只改前者会让仅含 `.zody-plugin` 的插件在 skills/commands/subagents/settings 中消失。  
   `contract-map.md:14` 也未点名“两套”具体是哪些键。现有代码同时注入 `ZCODE_PLUGIN_{ROOT,DATA,ID,NAME}` 和 `CLAUDE_PLUGIN_{ROOT,DATA}`（`apps/zcode-cli/packages/core/src/hooks/configured-runner-input.ts:89-96`，文档 `docs/plugin-hooks-compat.md:63-73`），没有列出 `ZODY_PLUGIN_*`。建议补一张 per-owner manifest 顺序表，并在 R55 明确 ZCODE/CLAUDE/ZODY 的确切键、模板 token、优先级和 1.0 退役项，避免误删 Claude 或提前删除 ZCODE 兼容。

**说明**

本次只做静态只读核对，未修改文件，未运行 typecheck/lint 或行为测试；R01 报告中的 `typecheck`/`lint` 通过结果未由本次复核重跑。

