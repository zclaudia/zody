# 手机远控移除：任务拆分

依据 [mobile-remote-control-removal.md](mobile-remote-control-removal.md)。执行约定沿用 fork 系列运行：每波结束后门禁（typecheck / lint / architecture:check --changed / test:unit:affected / check:official-refs，每道最多 3 轮修复员），波内任务文件集互不相交可并行；每波 `git commit --no-verify` 快照（pathspec 排除 `.zcode/`）。所有删除处在保留边界上写中文注释说明依据（AGENTS.md 要求）。

波次与文件冲突：Root.tsx/App.tsx/root/* 只归 R1.1；index.ts（desktop main）只归 R2.1；shared 的 channels/platform/validation/protocol/index 只归 R3.1；vitest.config.ts 只归 R1.3。

## 波 1（R1.1 → R1.2 → R1.3 并行）

### R1.1 ui 包：远控组件、传导与设置分区清理，Bots 新入口

删除文件（packages/ui/src/）：
- 根级：`WebRemoteControlDialog.tsx`、`WorkspaceWebRemoteControlTrigger.tsx`、`WebRemoteControlFeatureProvider.tsx`、`WebRemoteControlBotsEntry.tsx`（由侧边栏 Bots 按钮替代）、`remoteAccessStatusUi.ts`、`webRemoteControlTerminalTransportState.ts`、`WebRemoteControlTaskIndex.tsx`、`WebRemoteControlTaskIndexRow.tsx`、`WebRemoteControlMobileTaskHome.tsx`、`WebRemoteControlMobileShell.tsx`、`WebRemoteControlMobileSettingsScreen.tsx`、`WebRemoteControlMobileBackendPicker.tsx`、`WebRemoteControlRecentProjects.tsx`、`WebRemoteControlThemeMenu.tsx`
- hooks：`useRemoteAccessStatus.ts`、`useWebRemoteControlStatus.ts`、`useWebRemoteControlTaskOpen.ts`
- lib：`webRemoteControlTaskIndex.ts`、`webRemoteControlTaskSync.ts`、`webRemoteControlMobileTaskHome.ts`；`app-shell/webRemoteNavigationLayout.ts`
- root：`root/rootPlatformWorkspaceSync.ts`
- settings：`settings/RemoteAccessSection.tsx`（SettingsPage.tsx:54,1570-1571、settingsPageConfig.ts:156-160,174,193、lib/settingsNavigation.ts:21,77 同步摘除）
- 测试：`packages/ui/test/` 中 19 个专属测试（remoteAccessSettingsSection、rootWebRemoteControlSyncCondition、rootWebRemoteTaskSyncBoundary、useRemoteAccessStatus、useWebRemoteControlTaskOpen、webRemoteControlDialogLayout、webRemoteControlMobileSetup、webRemoteControlMobileShell、webRemoteControlMobileTaskHome、webRemoteControlMobileTaskHomeRecentProjects、webRemoteControlTaskIndex、webRemoteControlTaskIndexLayout、webRemoteControlTaskIndexRowHoverActions、webRemoteControlTaskSync、webRemoteControlTriggerPresentation、workspaceShellRemoteMobileLayout、workspaceSidebarWebRemoteMobileLayout、workspaceWebRemoteControlTrigger、workspaceWebRemoteControlTriggerTelemetry）

修改文件：
- `WorkspaceSidebarFooter.tsx`（40,384-392）：删除远控 trigger 挂载，原位置新增 Bots 图标按钮（Bot 图标 + aria 标题，i18n `bots.entry.title`），点击打开 `BotsDialog`（`entryProvider` 传 null，workspacePath/workspaceIdentity footer 已有），`data-testid="bots-entry-open"`。
- `Root.tsx`：删 import（67-74,76）、`WebRemoteControlTaskSync` 组件（114-216）、`remoteAccessEnabled` 读取与开关条件（521-527）、`isWebRemoteControlRoot`（550,553,578）、`onWebRemoteControlReconnectWorkspace`（689-715）、taskSyncNode 构造与挂载（755-763,1112,1128,1148,1159）、`settingsLayerProps.isWebRemoteControl`（1098）、`useRootPlatformEffects` 的 `webRemoteAccessEnabled` 传参（809-839,838）、`WebRemoteControlFeatureProvider` 包裹（244-254）、`workbenchGroupClientMode`（643）与 `RootWorkspaceContent` 远控 props（1220-1225）按传导删除。
- `root/useRootPlatformEffects.ts`：删 `webRemoteAccessEnabled` 参数（43,76-77）与 workspace 同步 effect（265-306，含 274-281 的已连接远程 workspace 推送——T1.3 注释确认 Bot 不依赖；`syncWindowTabs` 保留，仅删 285-288 的 restore 触发）。
- `root/types.ts`（4-8,14-45,87-97）、`App.tsx`（117-120,1215-1218）、`root/RootWorkspaceContent.tsx`（47-50,89-92,178-184）：prune `webRemoteControlFeatureEnabled`、`webRemoteControlWorkspaceSwitcher`、`isWebRemoteControl` 等远控 props（注意 `isWebRemoteControl` 传导链上的 v4 组件条件分支一并收口：ConversationComposer:624-634、SessionPane、V4InteractionDialogs、ConversationStatusPanel、V4ComposerToolbar、followupModeSettings:30、PermissionDialog:450-481、settings/{PluginsSection:207,SkillsSection:276,McpSettingsSection:1296,PluginAddMenu,PluginStorePage}、hooks/{usePluginCreator,useCuaComposerEntry}、chat-input-toolbar/modelSelection.ts:8、lib/mobileTextInput:96、lib/rootStartupGate:52-58、v4/workbenchGroupStore、WorkspaceSidebar/Item/Header/HeaderSections/SortableWorkspaceSidebar 中 `isWebRemoteControl` prop）。
- `WorkspaceSidebar.tsx`：删 `WebRemoteControlTaskIndex` 挂载（1587）与 `useWebRemoteControlStatus`（693）。
- `index.ts`（6-33）：删除全部 `WebRemoteControl*` 导出（仅 web mobile-remote 消费的 SettingsScreen/BackendPicker/RecentProjects/FeatureProvider/terminalTransportState 等）。
- i18n：zh-CN.ts（1527-1718 区块 + settings 2404-2463）与 en-US.ts（1618-1817 + 2532-2599）删 `webRemoteControl.*` 与 `settings.remoteAccess.*`；新增 `bots.entry.title`（zh「Bot 频道」/ en「Bot channels」）；BotsDialog 自有键不动。
- 外围测试修正（删 mock/props，保留 `web-remote-replayable` clientMode 用法）：rootUpdateReadyOverlay、mobileInputZoom、useRootPlatformEffects、rootStartupGate、useZCodeTaskService、v4ConversationDraftSuggestedPromptsContainer、archivedTasksActionsMenu、messageChangeSummaryPanel、messageTelemetry、remoteSyncActions、rootNewTaskWorkbenchContext、sessionsIndexRegistry、settingsFrameContentLayout、taskListMetaSync、v4ConversationComposerAttachmentProgress、v4ConversationRuntimeRecycleSelfHeal、v4ConversationStatusPanel、v4SessionPaneLayoutParity、workbenchGroupStore、workspaceConnectionRegistry、workspaceSidebarTaskViewSwitcher、zcodeSessionProjection、zcodeSessionRestore、browser/manual-review/pending/*。

### R1.2 web 包：手机客户端清理，桌面 Web 失败页改名保留

- 删除：`mobile.html`；`src/mobile-remote/` 整目录（bootstrap/gatewayTerminalTransport/homeOnlyServices/mobileRemoteBackendDiscovery/mobileRemoteSetup/mobileRemoteSecureStore/mobileRemoteFileBridge/mobileRemoteConfigStore/payloadRequester/mobileRemoteNativeHost/gatewayBootstrapConfig/requestRecovery/main 共 13 文件）；手机专用 `src/webRemoteControl{TaskRead,BridgeTaskRead,DeviceInfo,Lifecycle,ThemeSeed,Version,VersionNotice,WorkspaceBridgeSession,LoadingScreen}.ts(x)`；`src/webRootServices.ts`（消费方仅 bridgeTaskRead 与 homeOnlyServices，均删）。
- **保留并改名**：`webRemoteControlFailureScreen.tsx` → `webEntryFailureScreen.tsx`、`webRemoteControlFailureView.tsx` → `webEntryFailureView.tsx`；其依赖的 `WebRemoteControlFailure` 类型本地化到该模块（或 `src/webEntryFailure.ts`），删除仅手机链路的失败原因（`gateway-unreachable`、`gateway-credential-invalid`、`backend-unsupported`、`session-conflict` 手语义按桌面 Web 实际映射保留必要项）；`main.tsx`（15-18,85-93,125-133）改 import；`webPlatformService.ts` 删 `externalWebRemoteControlProxy` 选项（7-106）。
- `vite.config.ts`：删 mobile 模式（25,86,88-90）；`package.json` 删 `@zclaudia/gateway-client`（:12）。
- 测试：删 mobileRemote* 9 个、webRemoteControl* 8 个、homeOnly* 2 个、externalRelayFrameGapRecovery；改 `viteConfigLoad.test.ts`（75-80 mobile 断言）、删 `mobileRemoteEntry.test.ts`；涉及失败页的测试改新名。

### R1.3 Android、根脚本与构建配置

- 删除 `packages/android/` 整目录（无签名/CI/发版牵连；磁盘上 `.gradle/`、`app/build/` 未跟踪产物一并删除）。
- 根 `package.json`：删 `dev:gateway`（:16）、`dev:mobile-remote`（:17）、`build:mobile-web`（:42）、`check:mobile-web-isolation`（:43）。**不得误删** `dev:desktop:remote-prod`（:15）、`test:docker:web-app-gateway`（:37）、`prepare:remote-assets`（:60）、`bootstrap:with-remote`（:66）。
- 删 `scripts/dev-gateway.mjs`、`scripts/dev-gateway.test.mjs`、`scripts/dev-mobile-remote.mjs`、`scripts/check-mobile-web-bundle-isolation.mjs`。
- `mise.toml`：删 `[tasks.dev-remote]`（31-33）。
- `vitest.config.ts`：删 :23（desktop webRemoteControlTransport.test.ts 条目，若该测试文件已不存在）与 :109-110（dev-gateway.test）。
- `knip.json`：删 web 的 `@zclaudia/gateway-client` ignore 与 `src/mobile-remote/main.tsx` entry（17-22）。

## 波 2（R2.1 → R2.2 并行）

### R2.1 desktop：Main/preload/renderer 与测试

- 删除 `src/main/remote-access/` 整目录（13 文件）与根级 `webRemoteControlManager.ts`、`webRemoteControlSharedHostAttachments.ts`、`webRemoteControlRendererReconnect.ts`、`webRemoteControlStatusEvents.ts`、`webRemoteControlFeatureGate.ts`、`desktopWebRemoteControlIpc.ts`、`desktopRemoteAccessIpc.ts`。
- `src/main/index.ts` 摘除（行号为审计时点，以实际为准）：import（120-127,210）；`webRemoteControlManagerRef`（688-690）；专属 credentialService 与 credentialStore（698-702）；transport/backend 创建与 channel 挂接（710-737）；`remoteSessionManager` 的注入参数（799-808）；sharedHostAttachments（810-814）；directory/manager 创建（873-974，含 remoteAccessSettings 读写 881-903）；设置联动（1056-1063 applyRemoteAccessEnabled/reloadConfig、1065-1068 recentProjects 通知——注意 recentProjects 设置项本体保留，仅删通知调用）；退出屏障（1172-1177 backend dispose）；endpoint-changed suspend（1501-1505）；createWindow 依赖注入（1956）；启动恢复 reloadConfig（2120-2122）；platform 选项（2358-2360,2368-2373）；`registerRemoteIpcHandlers` 中 webRemoteControlManager 与 remoteAccessIpc（2401-2439）；`handleBotRemoteWorkspace*`（1861-1929）**保留**。
- `desktopRemoteSessions.ts`：仅删 `webRemoteControlManagerRef` 依赖参数（162-166）与 `failRemoteSession` 回调（573-580），其余全部保留（bot 三函数、attach、reconnect）。
- `desktopWindowLifecycle.ts`：删 manager 依赖类型（44）与 `disposeWindow` 调用（273）。
- `desktopMainIpcPlatform.ts`：删 SyncWebRemoteControlWorkspaces/Tasks handler（292-326）与 SyncWindowTabs 内 restore 触发（285-288）。
- preload `index.ts`（78-86,279-303,376-402）与 `renderer/src/desktopPlatform.ts`（33-61,114-118）：删远控方法桥接。
- `tsup.config.ts`：删 main `noExternal` 三个 `@zclaudia/*`（276-281）；`package.json`：删 dependencies `@zclaudia/gateway-backend`/`gateway-protocol`（66-67）与 devDependencies `gateway-client`（111）。
- 测试删除：单测 gatewayDeviceTransport、remoteGatewayBackend、remoteAccessCredentialStore、remoteWorkspaceDirectory、mobileRemoteGatewayIntegration、webRemoteControlFeatureGate、webRemoteControlManagerExternalRelay、webRemoteControlManagerRecentProjects、webRemoteControlManagerWorkspaceDirectory、webRemoteControlSharedHostAttachments、webRemoteControlStatusEvents、desktopWebRemoteControlIpc、desktopRemoteAccessIpc；e2e `remote-control/` 整目录、`settings/remote-access-settings.test.ts`、`helpers/mobile-remote-gateway.ts`、`manual-review/pending/mobile-remote-onboarding.mjs`；连带清理 e2e fixtures 中孤立用例 fixture 与 coverage matrix 条目（e2e-case-lifecycle 规则）。
- 测试修改：`desktopMainIpcPlatform.test.ts`（124-234）、`desktopMainIpcRemoteTelemetry.test.ts`（52-156）、`desktopMainIpcRemoteOpenExternalFile.test.ts`、`desktopWindowLifecycle.test.ts`（75,141,203,267,325,384）、`desktopRemoteSessions.test.ts`（webRemoteControlManagerRef/failRemoteSession 相关断言删除，bot port 断言保留）。

### R2.2 packages/client：relay 协议族删除

- 删除 `src/webRemoteControlRelayProtocol.ts`、`webRemoteControlAcknowledgedRelayProtocol.ts`、`webRemoteControlAcknowledgedRelayProtocolTypes.ts`、`webRemoteControlAcknowledgedRelayBatchQueue.ts`、`webRemoteControlAcknowledgedRelayDeadline.ts`、`webRemoteControlRelayPayloadSerializer.ts` 与 `test/webRemoteControlRelayPayloadSerializer.test.ts`；`src/index.ts`（8-14）摘导出；`globals.d.ts` 摘相关 window.zcode 类型（仅确认被 manager 使用的部分）。消费方 manager（R2.1）与手机 bootstrap（R1.2）同波删除后无引用。

## 波 3（R3.1 → R3.2 并行）

### R3.1 shared：协议与设置清理

- 删除整文件：`web-remote-control.ts`、`web-remote-control-channel.ts`、`web-remote-control-rpc-transport.ts`、`remoteAccess.ts`；`index.ts`（137,298-300）摘导出。
- `channels.ts`：删 12 个远控 channel（220-262,813-896 内远控条目；**Bot channels 164-165,209-210,614-619,707+ 与 SSH 的 ConnectRemote 族 213-218,238 保留**）。
- `platform.ts`：删 9 个远控方法（797-827 内远控项、938-949）；`loadMcpFromUserDirectory` 族（844-857）保留。
- `validationAppSettings.ts`：删 remoteAccess schema/默认值/patch（561,669）与旧 relay 迁移（11-13,324-345；存量 settings 中的 remoteAccess 由 strip 丢弃，加中文注释）。
- `protocol.ts`：删 `AppSettings.remoteAccess`（411）。
- `remoteUsageTelemetry.ts`：删 `WebRemoteControlPairKind/EntryKind`（24-25）与 3 个 builder（45-113，消费方 trigger/manager 已删），远程 workspace 遥测保留。
- 相关 shared 测试（validation/channel/platform 遥测测试中的远控断言）同步修改。

### R3.2 bots E2E 改道

- `e2e/bots/feishu-bound-groups-ui.test.ts`（55-58）与 `feishu-runtime-error-ui.test.ts`（106-109）：入口从「移动端远程控制按钮 → web-remote-control-open-bots」改为侧边栏 footer `bots-entry-open` 按钮直达 BotsDialog；断言目标不变。
- 本机 wdio 受首启叠层限制无法执行时，保证 tsconfig.e2e typecheck 通过并如实登记未执行。

## 波 4（R4.1 收尾，串行）

### R4.1 文档、治理与依赖收尾

- `pnpm install` 更新 lockfile（移除 @zclaudia 后）；`node scripts/licenses.mjs notices && node scripts/licenses.mjs check` 重生成 THIRD-PARTY-NOTICES（@zclaudia 四条应消失）。
- `knip.json`：删 desktop `@zclaudia` ignoreDependencies（8-16）。
- 文档删除：`docs/web-remote-control/` 中描述已删机制者（architecture、minimal-plan、mobile-stability-analysis、mobile-task-home-design、mobile-theme-control、mobile-remote-workspace-reconnect、remote-control-bot-channel-entry、relay-message-logging、task-command-queue、task-snapshot-dedupe）；`single-owner-stream-rendering`、`snapshot-byte-budget`、`task-realtime-sync`、`wide-screen-task-list` 先读内容，描述仍存基础设施（replayable 流语义/taskRealtime）者保留；`docs/mobile-remote-control-android.md`；docs 根级 web-remote-control 散文文档；`docs/monitoring/remote-usage-*`、`docs/architecture/*`、`docs/testing/feature-boundary-planner-zcode-domain-map.md` 中的远控段落改写。superpowers 历史归档（2026-04/05 dated plans）保留不动。
- AGENTS.md「进程、协议与远程控制」节：删「手机远控连接桌面已有 Host attachment…」「zclaudia-gateway 与 Main 只做鉴权…」两条；「desktop-continuous 与 web-remote-replayable 两种语义」条目改为不提手机（replayable 由 Bot 远端 runtime 与 server 持有）；「手机远控连接」相关表述全清。
- `.agents/skills/feature-boundary-planner/references/zcode-domain-cross-products.md`（24-26,31,41-47,57-72）与 `zcode-feature-graph.yaml`（1661-1673,2207-2230,3467-3469,4321,4343,4376,5407,5454,5485,5528）：删手机远控 capability/surface/service 条目。
- `apps/dev-docs/src/data/productCapabilityMap.ts`（406,571,578,586）：删 mobile-remote 条目；对应测试更新。
- 两份旧 spec 顶部加 superseded 状态行指向本 spec。
- 全仓残留 grep（验收标准见 removal spec）：`zclaudia|remoteAccess|webRemoteControl|WebRemoteControl|mobile-remote|mobileRemote`，白名单 `web-remote-replayable`、`desktop-continuous`、SSH/远程 workspace 语义、`webEntryFailure*`、bots 自有命名；发现漏网即修。
