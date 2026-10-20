# Bot channels 移除：任务拆分

依据 [bot-channels-removal.md](bot-channels-removal.md)。执行约定：波内任务文件集互不相交、可并行；每波后门禁（typecheck / lint / architecture:check --changed / test:unit:affected / check:official-refs，各最多 3 轮修复员）；每波 `git commit --no-verify` 快照（pathspec 排除 `.zcode/`）；删除边界处中文注释说明依据。行号为 2026-10-20 审计时点，以实际代码为准。

## 波 1（八任务并行）

### B1a services：bots 目录与注册链

- 删 `packages/services/src/bots/` 整目录（46 文件）。
- `node.ts`：删 import/export（L139、L273、L312-313）、bridge 创建（L1922-1926）、IBotsService 注册块（L1965-1978，**严防误删相邻的 L1963 ICuaPipSessionService、L1964 注释、L1979 IFileWatcherService——注册清单 diff 复核**）、三个 executor（channelReply L1697-1710、topicResource L1711-1725、validator L1726-1741，含向 zcodeAgentService 装配传递处）、dispose 项（L2108、L2145）。
- `accessor.ts`（L18、L66）删 botsService 字段；`services/src/index.ts`（L172-180）删导出。
- 删 `packages/services/test/` 全部 bots/bot* 测试（40 个清单见 removal spec）。

### B1b services：zcode-agent 适配层与 automation

- 删 `zcode-agent/` 六个 bot 辅助文件（botTopicAdmission、groupAttachmentUpload、groupRuntimeSnapshot、topicResourceUpload、topicResourceRelayChannel、topicResourceRelayClient）。
- `zcodeTaskServiceAdapter.ts`：删六个 bot 方法实现（L2047-2272）、botConnectionScopes/botAgent（L268-280、L3544-3559）、botDeliveryTarget 贯通（L407/458/480/2288）、`toZCodeDeliveryKind` 收窄（L3881-3884，保留 replayable 分支）；`bot_topic_context` 过滤（L2060）随方法删除。
- `session/zcodeTaskService.ts`：删六个 bot 方法接口（L248-304）、sendPrompt.botDeliveryTarget（L321-322）、deliveryKind 联合中的 `"bot-channel-continuous"`（L827）。
- `zcodeAgentService.ts`：删 topicResourceExecutor/channelReplyExecutor/topicResourceValidator 参数与消费（L1805-1830、L2109-2120）——与 B1a 的 node.ts 传递处同波落定。
- `session/automationRepo.ts`：删 bot_delivery_target 读写与 getBotDeliveryTarget（L70,339,348,371-372,430,437,824,901；**SQLite 列保留不读**，中文注释说明）；`zcodeAgent.ts` L303-304。
- 测试修改：`automationRepo.test.ts`（L241-259）、`zcodeLegacyTaskCompatTaskIndex.test.ts`（L4921,5002）。

### B2 shared 协议与 client 合同

- 删整文件：`shared/src/bots.ts`、`shared/src/channel-mention.ts`。
- `channels.ts`：删 L40 import、L164-165、L209-210、L614-619、L707-712、L789-790。
- `platform.ts`：删 L576-580、L770-773。
- `validation.ts`：删 L732-758、L915-917、L1242-1264、L1482-1484。
- `zcode-protocol/index.ts`：删 L37、L2070、L3770、L3998（channelReply；L3997-3999 topicResource 三方法一并删）、L4144-4154 re-export。
- `zcode-protocol-v4/command.ts`：删 L14、L119、L121；`automation-types.ts`：删 L2 import 与 L161-162 botDeliveryTarget 字段（注意先解除对 bots.ts schema 的依赖再删文件）。
- `shared/src/index.ts` L296 摘导出。
- `packages/client/src/remoteServiceAccess.ts`（L18,71,149-150）、`globals.d.ts` L156 删 botsService 代理与类型。
- shared 相关测试同步（validation/channel 测试中 bot 断言）。

### B3a ui：BotsDialog 族、i18n 与远控弹窗单列化

- 删：BotsDialog.tsx、BotsDialog/ 7 文件、botsUi.ts、WebRemoteControlBotsEntry.tsx、hooks/{useBotBoundGroups,useBotGroupTask,useBotGroupMemberNames,useBotPrivateDeliveryRetry}.ts、root/{useBotBroadcastEffects,botsTaskBroadcast,botsTaskStreamBroadcast}.ts。
- `WebRemoteControlDialog.tsx` 单列化：删 L19 import、L366-369 右列；L255-258 网格去双列模板（保留 `data-testid="web-remote-control-main-grid"`）；L93 注释去「Bot Channel 入口保留」；评估收窄 L225 `max-w-4xl` 与 L261 `min-h-[360px]`（原双列等高设计，按 DESIGN.md 单列居中调整）。
- i18n：两语言删 `bots.*` 291 键（zh 大块 309-586 + 散点 125-183；en 328-632 + 130-198）与 `webRemoteControl.botChannel.*` 12 键（zh 1569-1580、en 1665-1676）。
- 测试：删 13 个 bots 专属测试；改 `webRemoteControlDialogLayout.test.ts`（删 L64-73 mock、L147、L269-286、L288-300 两个 bots 用例，调 L262 宽度断言，main-grid 断言迁入保留用例）；`workspaceShellRemoteMobileLayout.test.ts` L61-62、`workspaceSidebarWebRemoteMobileLayout.test.ts` L80-81,225 的 BotsDialog mock 清理。

### B3b ui：Root/App/v4 摘除

- `Root.tsx`：删 L62 import、L595 调用、L396-399 syncAppRuntimePreferences bots 分支、L441 deps（`useRootPlatformEffects.ts` L274-281 保留，仅改注释去 Bot 措辞——注：该文件若与 B4a 无冲突由本任务改，B4a 不碰它）。
- `App.tsx` L819-824、L844；`test-actions.ts` L20-22；`useSettingService.ts` L109,159,174。
- v4 摘除：删 `ChannelMentionContent.tsx` 整文件；`ConversationRowView.tsx`（L4,137,1025,1308-1321,1372,1389,1464-1465,1647）、`ConversationTurnGroup.tsx`（L1-3,1362,1392）、`ConversationTimeline.tsx`（L1,400）、`ConversationQueuePanel.tsx`（L1,4,224-228）、`SessionPane.tsx`（L5,3956,4027）、`ConversationUserInputBubble.tsx`（L2,32）、`topicInputMessages.ts`、`topicPreparationRenderUnits.ts` L1、`conversationTurnRenderUnitTypes.ts` L2,21。
- 测试修改：`v4TopicInputMessages.test.ts`（随源删）、`v4ConversationRowViewUserEdit.test.ts`（L485,552）、`v4InteractionDialogs.test.ts`（bot elicitation 用例）、`useSettingServiceAutoResolution.test.ts`（L22,37,55-127）、`useSettingServiceEnvironmentIsolation.test.ts` L23、browser/manual-review/pending 的 channel-mention 与 topic-preparation 三文件。

### B4a desktop：Main/host 与 preload

- `index.ts`：删三个 handleBotRemoteWorkspace*（L1860-1929）。
- `desktopHostProcess.ts`：删依赖类型（L190-210）与三段分发（L577-708，注意 L568-575 与 L709 后结构完整）。
- `desktopRemoteSessions.ts`：删三个 bot 函数（L892-909、L973-1001、L1003-1028）与导出（L1033,1037,1038）；**共享函数一行不动**（createRemoteWorkspaceSession、attachRemoteWorkspaceSessionHost L911-971、bindRemoteWorkspaceSessionContext、routesBySessionId），中文注释防误删。
- `windowTopicResourceRelay.ts` 整文件删；挂载链摘除：`host/index.ts`（L20,1332-1337,1338,1348,1360,1363,1368,1493,2674,2684 topicResourceChannel 参数）、`botGroupTaskScope.ts` 删（host/index L1725-1733 四方法包装）、`cronBotDelivery.ts` 删（host/index L596-616 订阅）、parentPort 跳过分支（L2438-2446，L2448 起 AttachServicePort 处理不动）、`mirrorRemotePrompt` 仅改「Bot remote runtime」日志措辞（L970,L943-1163 内）。
- `remoteWorkspaceServiceCollection.ts`：删 L232-244 bots 注册（相邻 L245 IFileWatcherService 等保留）与 L310 透传。
- preload `index.ts` L361、`renderer/src/desktopPlatform.ts` L23；`ui/src/hooks/useRemoteWorkspaceHistory.ts` 的 onBotRemoteWorkspaceReconnected（L73-80,1215-1250,1304）。
- `tsup.config.ts` L228 external 与 `package.json` L54 删 `@larksuiteoapi/node-sdk`。
- 单测：删 botGroupTaskScope、cronBotDelivery、windowTopicResourceRelay 测试；改 hostRemoteWorkspaceServices（L481,501）、cronHostSessionCreateTelemetry（L37,42）、desktopRemoteSessions（L824,916）、tsupChunkIsolation 测试。

### B4b server/web 外围与全部 E2E

- `packages/server/src/http.ts`：删 `/api/bots` 端点（L388-432）与 topicResourcePeers relay 注册（L102,352；保留 ChannelClient/反向 attach 结构）；`entry-http.ts` L17-25；`zcode-server-cli` core.ts L45；`server/src/remote/connect.ts`（L29,225-229）、`desktop/src/host/serverRemoteConnection.ts`（L35,241-245）的 topicResourceChannel 参数。
- `packages/web/src/webPlatformService.ts` L72 空实现删；`mobile-remote/homeOnlyServices.ts` L187 bots 占位删（参照同文件 conversationShareService 先例注释）。
- `server/test/botsHttp.test.ts` 删。
- E2E：删 `test/e2e/bots/` 整目录（9 spec + harness + manual-review/pending 8）、`fixtures/bots/` 整目录（16 json）、3 个 conversation-session bot worker spec + `helpers/bot-worker-integration.ts`、`bot-platform-fixture.ts` + cases/upstream 两处 fixtures json + upstream feishu-group-runtime.json；改 `remote-control/remote-control-dialog-no-autostart.test.ts`（删 L12,23-24,40,74-85 bots 断言，保留本体）；改 `docs/testing/conversation-session-e2e-coverage-matrix.md`（L2833-2835 小节、L1173-1183,1293,1307,1870,2095,2480-2487 行）；删 `docs/testing/bots-e2e-coverage-matrix.md`。

### B5 apps/zcode-cli：协议与工具摘除

- 删 `core/src/tool/handlers/reply-to-channel.ts` 与其注册；`core/src/session-context/topic-resource.ts`；`bootstrap/src/zcode-protocol/topic-resource-port.ts`（L23,41,54）。
- `bootstrap/src/zcode-protocol-v4/commands/prompt-turn.ts`（L30-31,97-167）、`commands/types.ts`（L78-79）、`input-intent.ts`（L15-139 botGroupSource）、`event-normalizer.ts`（L52,294）、`server-operations.ts`（L2021,2393,2416,2475-2476）、`automation-port.ts` L137。
- contracts 中 bot 类型引用同步清理；跑 `pnpm --dir apps/zcode-cli/packages/bootstrap exec vitest run --reporter=dot --silent` 与 adapters 同命令自检（最终门禁也会跑）。

## 波 2（B6 收尾，串行）

### B6 文档、治理与依赖

- `pnpm install`（本任务明确要求）更新 lockfile 去 `@larksuiteoapi/node-sdk`；`node scripts/licenses.mjs notices` 重生成。
- 文档删除清单见 removal spec（12 个 bots 文档 + superpowers 2026-06-10 归档）；局部改写 `web-remote-control-architecture.md`（L75 表行、L281 Bot 绑定行为段）、`r1-single-window-host-refactor.md` 措辞。
- `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`（L3142-3145,4995-5020,6757 及 L487,L1220 措辞）；`zcode-domain-cross-products.md` 检查。
- `apps/dev-docs/src/data/productCapabilityMap.ts`（L154,226,380,420,529,605-606,660）删 bots 节点边；同步 capabilityMap{Complexity,Geometry,CurrentFeatures} 测试与 `docs/product-capability-map.md`（L188,196,297）。
- 全仓残留 grep（removal spec 验收第 2 条模式与白名单），漏网即修。
