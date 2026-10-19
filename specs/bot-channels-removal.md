# Bot channels 功能整体移除

状态：已确认（2026-10-20），实施中。

## 背景与决策

用户决策（2026-10-20）：**删除 zcode 原生的第三方 IM bot 接入方式**（飞书/Lark、微信、Telegram、webhook 四类 bot channel，含二维码扫码建应用流程），因为专用安卓远控端（zclaudia-gateway 链路）对其是上位替代。官方二维码配对 relay 体系已于 2026-10-17 的 gateway 改造（T5.1）删除，本次不再涉及。

**完整保留（这是远程访问的基础，一行不动功能语义）**：

- 手机远控 gateway 链路：桌面 `remote-access/`（RemoteGatewayBackend/GatewayDeviceTransport/RemoteWorkspaceDirectory）、`webRemoteControlManager`、`@zclaudia` 依赖与 tsup 内联、设置页「远程访问」分区、侧边栏远控按钮与状态弹窗（仅做单列化改造，见下）、`packages/web/src/mobile-remote`、`packages/android`。
- 通用基础设施：`broadcastService`（跨窗口主题/语言/设置广播，bot 只是搭便车者）、`settings.lastWorkspaceSession`（远端 workspace 唯一持久化来源，桌面启动恢复/tab 持久化/SSH 重连依赖）、`attachRemoteWorkspaceSessionHost` 与 `desktopRemoteSessions` 共享机制、`remoteWorkspaceServiceCollection`（除 bots 注册行）、权限审批管线（PermissionDialog/permission_request 协议）、SSH/WSL/Docker/Server 远程 workspace、`web-remote-replayable`/`desktop-continuous` 交付语义二分。

## 产品规则

1. **Bot channels 全量移除**：BotsService 与 46 个实现文件、全部 provider（飞书/微信/Telegram/webhook）与扫码建应用流程、BotsDialog 配置 UI（含子组件）、远控弹窗右侧 Bots 入口卡、bot 任务广播与群投递 UI（v4 组件中的 bot 渲染）、`bot/channel/reply` 与 `topic/resource/*` 协议方法、`/api/bots` webhook 回调端点、全部 bots E2E 与文档。webhook provider 一并删除（同属第三方接入方式，同被安卓端替代）。
2. **远控弹窗单列化**：`WebRemoteControlDialog` 删除右列 `WebRemoteControlBotsEntry` 与双列网格模板，回归单列；同步收窄 `max-w-4xl` 与左列 `min-h-[360px]`（原为双列等高设计），更新布局测试与 e2e 断言（`web-remote-control-open-bots` testid 消失）。
3. **automation/cron 的 bot 回推链删除**：`botDeliveryTarget` 全链（schema、task/agent 字段、CLI turn 保存恢复、cron 回推订阅 `cronBotDelivery`）移除；automation 功能本身保留，投递目标仅剩原路径。SQLite `automationRepo` 的 `bot_delivery_target` 列保留不读（历史库兼容，参照 off_peak_tasks 表先例）。
4. **存量数据不迁移**：`bot-config.v3.json`、`bot-state.v3.json`、`bots-model-cache.v2.json` 等文件与 `bot:{botId}:credential`、`bot:{botId}:webhook-secret` 凭证键不再读取、不删除用户磁盘文件；代码路径消失即可。
5. **wire 兼容**：本 fork 与官方是完全独立的两个产品（既有原则），v4 协议中的 bot 字段（`botDeliveryTarget`、`botGroupSource`、bot schema re-export）直接删除，CLI 同步删，不做兼容层。
6. `deliveryKind` 联合类型收窄：删 `"bot-channel-continuous"`，`"replayable" → "web-remote-replayable"` 映射保留。
7. 依赖清理：`@larksuiteoapi/node-sdk` 从 `packages/services` 与 `packages/desktop` 移除（含 tsup external、tsupChunkIsolation 测试引用）；THIRD-PARTY-NOTICES 重生成。

## 删除边界

### 删除面（三路审计 2026-10-20 确认）

| 层 | 内容 |
| --- | --- |
| services/bots | `packages/services/src/bots/` 整目录 46 文件 ~19,942 行（botsService、providers/ 11 文件、群投递/话题/格式化/存储迁移全家族） |
| services 其他 | `zcode-agent/` 的 botTopicAdmission、groupAttachmentUpload、groupRuntimeSnapshot、topicResourceUpload、topicResourceRelayChannel/Client；`zcodeTaskServiceAdapter.ts` 六个 bot 方法（L2047-2272）与 botConnectionScopes（L268-280）；`session/zcodeTaskService.ts` bot 方法接口（L248-304）与 botDeliveryTarget（L321-322）；`session/automationRepo.ts` bot_delivery_target 读写；`zcodeAgent.ts` botDeliveryTarget（L303-304）；`node.ts` IBotsService 注册块（L1965-1978，相邻注册防误删）与 bridge（L1922-1926）、三个 executor（L1697-1741）、dispose 项（L2108/2145）；`accessor.ts` botsService 字段；`index.ts` 导出 |
| shared | `bots.ts`（930 行整文件）、`channel-mention.ts`（132 行整文件）、`channels.ts` Bot 条目（L164-165,209-210,614-619,707-712,789-790）、`platform.ts`（L576-580,770-773）、`validation.ts`（L732-758,915-917,1242-1264,1482-1484）、`zcode-protocol/index.ts`（L37,2070,3770,3998,4144-4154）、`zcode-protocol-v4/command.ts`（L14,119,121）、`automation-types.ts` botDeliveryTarget（L2,161-162）、`index.ts` L296 导出 |
| client/web | `client/remoteServiceAccess.ts` botsService 代理（L18,71,149-150）、`client/globals.d.ts` L156；`web/webPlatformService.ts` L72 空实现、`web/mobile-remote/homeOnlyServices.ts` L187 bots 占位 |
| desktop main/host | `index.ts` 三个 handleBotRemoteWorkspace*（L1860-1929）；`desktopHostProcess.ts`（L190-210,577-708）；`desktopRemoteSessions.ts` 三个 bot 函数（L892-909 hasRemoteWorkspaceSessionForTarget——唯一消费方即 bot handler、L973-1001、L1003-1028）与导出（L1033,1037,1038）；`windowTopicResourceRelay.ts` 整文件及挂载链（host/index.ts L20,1332-1337,2674,2684；serverRemoteConnection.ts；server/remote/connect.ts；server entry-http；zcode-server-cli core.ts topicResource 注册——保留 ChannelClient/反向 attach 结构仅摘 relay）；`botGroupTaskScope.ts`、`cronBotDelivery.ts`、host/index.ts cron 订阅（L596-616）与 bot 群四方法（L1725-1733）、parentPort 跳过分支（L2438-2446）；`remoteWorkspaceServiceCollection.ts` bots 注册（L232-244）与 server 透传（L310）；preload L361、desktopPlatform L23；`useRemoteWorkspaceHistory.ts` onBotRemoteWorkspaceReconnected（L73-80,1215-1250,1304） |
| server | `/api/bots/:provider(/:botId)` webhook 端点（http.ts L388-432）、topicResourcePeers relay 注册、`botsHttp.test.ts` |
| ui | BotsDialog.tsx + BotsDialog/ 7 文件 + botsUi.ts + WebRemoteControlBotsEntry.tsx；hooks：useBotBoundGroups、useBotGroupTask、useBotGroupMemberNames、useBotPrivateDeliveryRetry；root：useBotBroadcastEffects、botsTaskBroadcast、botsTaskStreamBroadcast；v4：BotTopicPreparation、BotGroupSourceLabel、BotGroupDeliveryAction、botGroupDeliveryContext、BotGroupMemberNamesContext、ChannelMentionContent（整文件）；v4 摘除点：ConversationRowView、ConversationTurnGroup、ConversationTimeline、ConversationQueuePanel、SessionPane、ConversationUserInputBubble、topicInputMessages、topicPreparationRenderUnits、conversationTurnRenderUnitTypes；Root.tsx（L62,396-399,441,595）、App.tsx（L819-824,844）、test-actions.ts、useSettingService.ts（L109,159,174）；WebRemoteControlDialog 单列化（L19,93,225,255-258,261,366-369） |
| CLI | `reply-to-channel` tool、`session-context/topic-resource.ts`、`zcode-protocol/topic-resource-port.ts`、`zcode-protocol-v4` 的 botDeliveryTarget（prompt-turn/types）与 botGroupSource（input-intent/event-normalizer）、server-operations turn 保存恢复（L2021,2393,2416,2475-2476）、automation-port L137、contracts 类型 |
| i18n | `bots.*` 291 键 ×2（zh 309-586 大块 + 125-183 散点；en 328-632 + 130-198）、`webRemoteControl.botChannel.*` 12 键 ×2（zh 1569-1580、en 1665-1676） |
| 测试 | services 40 个 bots 测试 + automationRepo/zcodeLegacyTaskCompatTaskIndex 断言；ui 13 个整删 + 布局/外围测试修改；desktop 单测（botGroupTaskScope、cronBotDelivery、windowTopicResourceRelay、hostRemoteWorkspaceServices、cronHostSessionCreateTelemetry、desktopRemoteSessions、tsupChunkIsolation）；e2e：`test/e2e/bots/` 整目录（16 文件）+ fixtures/bots/（16 json）+ 3 个 bot worker spec + helpers（bot-worker-integration、bot-platform-fixture）+ upstream fixtures + remote-control spec 的 bots 断言 + conversation-session/bots 两个 coverage matrix 文档条目；server botsHttp |
| 文档 | `docs/bots.md`、`bot-channel-runtime-split.md`、`bots-e2e-case-catalog.md`、`bots-feishu-group-collaboration.md`、`bots-feishu-streaming-card-reliability.md`、`bots-private-task-sync.md`、`bots-session-expired-callback.md`、`bots-topic-input-materials.md`、`bots-workspace-read-state-transport-race.md`、`docs/ui/bot-bind-command-guidance.md`、`docs/testing/bots-e2e-coverage-matrix.md`、`docs/web-remote-control/remote-control-bot-channel-entry.md`、superpowers 2026-06-10 bot-state-cache 归档；局部改写：`web-remote-control-architecture.md`（L75,281）、`r1-single-window-host-refactor.md`（措辞）；feature-boundary-planner references（zcode-feature-graph.yaml L3142-3145,4995-5020,6757 等）；dev-docs capability map（bots 节点/边 + 几何测试） |

### 保留面（名字/注释像 bot 但必须保留）

1. `broadcastService` 全链（含 broadcastHub、store/IntlProvider 消费）。
2. `settings.lastWorkspaceSession` 写入/读取链（useTabPersistence、remoteWorkspaceSessionPersistence、remoteWorkspaceHistory、startupWorkspace）。
3. `attachRemoteWorkspaceSessionHost`、`createRemoteWorkspaceSession`、`bindRemoteWorkspaceSessionContext`、`routesBySessionId`——手机远控 sharedHostAttachments（L128-135）与 SSH/WSL 建连共用。
4. `remoteWorkspaceServiceCollection` 其余 ~30 个注册（手机 replayable 直连 remote host 依赖）。
5. 权限审批管线与 manual-review 目录结构（本地/远控共用）。
6. `web-remote-replayable`/`desktop-continuous` 全部语义设施（server http、zcodeAgentConnectionScope 权限门、adapter 恢复语义、protocol-v4 transport、task-realtime、workbenchGroupStore、Root L643-646）；`mirrorRemotePrompt`（host/index.ts L943 起）服务手机 replayable mirror，仅改「Bot remote runtime」日志措辞。
7. `useRootPlatformEffects.ts` L274-281 的已连接远程 workspace 推送：保留调用（触发 `restorePreviouslyEnabled` 手机远控自启），仅改写注释去掉 Bot 措辞。
8. cron 派发主链（createTask→resumeTask→sendPrompt）；automation 功能本体。
9. lucide `Bot` 图标在 subagent mention 的使用（promptMentionNode）——与 bot channels 无关。

## 验收

1. 门禁全绿：`pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed`、`pnpm test:unit:affected`、`check:official-refs`，加 `apps/zcode-cli/packages/bootstrap` 与 `adapters` 两包全量（dot+silent）。
2. 残留 grep（白名单外零命中）：`botsService|IBotsService|createBotsService|BotsDialog|BotConfig\b|botChannel|botDeliveryTarget|BotRemoteWorkspace|bot-channel-continuous|BotTopic|BotGroup|botGroupSource|channel-mention|ChannelMention|larksuiteoapi`；白名单：`broadcastService` 链、`lastWorkspaceSession`、`web-remote-replayable`、`desktop-continuous`、lucide `Bot` 图标、docs/superpowers 历史归档、specs/ 本目录。
3. 远控链路行为抽查：设置页「远程访问」分区与侧边栏远控按钮、远控弹窗（单列、无 Bots 卡）完好；`@zclaudia` 依赖与 tsup noExternal 不变；`packages/android`、`packages/web/src/mobile-remote` 不变（除 homeOnlyServices 一行占位删除）。
4. `@larksuiteoapi/node-sdk` 从 lockfile 与两包 package.json 消失；THIRD-PARTY-NOTICES 重生成且 check 通过。
5. E2E：remote-control-dialog spec 改写后保留「打开弹窗不自动启动远控」断言；bots 相关 spec/fixtures/coverage matrix 条目清零（e2e-case-lifecycle 规则）；本机 wdio 受首启叠层限制未执行时如实登记。
