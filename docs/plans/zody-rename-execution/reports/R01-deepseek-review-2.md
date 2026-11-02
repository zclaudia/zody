# R01-deepseek-review-2

Reviewer: `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a19ccf-8092-7d11-9010-8010e395f2a5`; route deepseek-flash, provider magpie, model group/deepseek, read-only.

**结论：PASS**

五项阻断在 `40cae940` 中均已解决；本次仅做静态契约复核，未运行产品行为、E2E、typecheck 或 lint。

**五项核对**

- **接口 owner/原子集合**：已补 `contract-map.md:18-31` 的逐字段表，覆盖 RemoteServer hello/ack、`renameGeneration`、`x-zody-generation`、WS 子协议、手机 `protocolVersion`，并列出旧→新、生产者→消费者、owner 与顺序。
- **RemoteServer 与 Agent stdio 分离**：`contract-map.md:31` 明确 Agent LF JSON 不发送 RemoteServer hello/ack；R41 新增 planned `packages/server/test/stdioHandshake.test.ts`（`execution-plan.md:183`），覆盖 strict ack、新旧、EOF/取消、剩余缓冲。
- **Web/client/remoteId 与手机双端**：`contract-map.md:24-29` 已列 `packages/client/src/websocket.ts`、`packages/web/src/main.tsx`、手机 Web transport、Desktop gateway receiver；R42 写范围与测试 seed 同步（`execution-plan.md:189-191`），test-map 明确普通与 remoteId 都校验 server-info 和子协议。
- **手机版本同步**：运行时契约 `:11` 与 gateway spec `:162` 均明确 `protocolVersion` 从 1 硬切到 2，并说明与 `ZODY_RENAME_GENERATION=2` 同值但语义独立；示例、双端 owner 和测试已同步。
- **manifest/env**：`contract-map.md:33-49` 已按 reader 列出 Z→C→X、skills 的 Z→C→X→U，并补 services 的 skills/commands/subagents/settings-sync/plugin-sync；R54 写范围同步。`contract-map.md:51-55` 已明确 ZODY/ZCODE 的 ROOT/DATA/ID/NAME、CLAUDE 的 ROOT/DATA、manifest env 合并顺序、模板 token 与 1.0 退役边界。

**派发前非阻断清理**

- `test-map.md:10` 仍把 `packages/server/test/remoteConnect.test.ts` 归在 `RENAME-REMOTE-CONTINUOUS`（R42）。执行计划 `:183` 明确该文件在 R41 后交 R43，`:199` 也是 R43 seed。建议从 R42 行移除或改标 R43，避免 R42 并发编辑。
- `test-map.md:9` 仍把 `packages/services/test/zcodeStdioTransport.test.ts` 列为 `RENAME-REMOTE-STDIO` 的实际 seed；它测的是 Agent stdio，而 `contract-map.md:31` 已说明不能用它代替 `waitForAck`。建议拆成 Agent-only 行或加“非 RemoteServer 证据”标注。
- `docs/plugin-hooks-compat.md:59-73` 的插件变量列表仍只列 ZCODE/CLAUDE。建议补 `ZODY_PLUGIN_*` 目标键并标注 ZCODE 1.0 前兼容，避免与 `contract-map.md:51-55` 不一致。
- `contract-map.md:53` 的 `ZCODE_CUA_PLUGIN_ROOT → ZODY_CUA_PLUGIN_ROOT` 还需确认实际 consumer 已列入 R30/R55 清单：`apps/zcode-cli/packages/node-repl-host/src/node-repl-session-executor.ts:22` 仍读取旧键，CUA skill/docs 也有引用。
- `test-map.md:19` 的 RENAME-CUA 只列两个 node test，执行计划 `:332` 还列了 `cua-desktop-session-candidate-fetch.test.mjs`；确认它是否属于 RENAME-CUA 证据即可。
