# R44 main bridge / IPC preflight

只读预检；R40 正在修改 shared/RPC，以下消费方观察不是共享 API 冻结结果。实施前等待 R40 最终常量交接，逐项锁定 writeSet；不改 R42 HTTP/mobile、plugin iframe / GenUI / MCP 兼容桥、artifact 或外部身份。

## 当前主桥和边界

- `packages/desktop/src/preload/index.ts:252` 以 `contextBridge.exposeInMainWorld("zcode", …)` 生产主应用桥；`packages/client/src/globals.d.ts` 是同一 bridge 的类型；主消费者是 desktop renderer `desktopPlatform.ts`、`desktopBrowserPlatformBridge.ts`、`main.tsx`，client `logger.ts`，UI `logger.ts` 的受控日志转发。将该实例和调用者原子改为 `zody`，通过 `IPlatformService` 保持平台边界。逐文件审 `window.zcode`：`desktop/src/renderer/src/plugin-sandbox/*`、`main/pluginSandbox/*`、`preload/pluginSandbox/hostBridge.ts` 的同名/别名是独立兼容桥，不做文本全局替换；文档注释也按含义处理。
- IPC 基于 R40 `PlatformChannels` / `InternalChannels` 新值，preload、main 注册方以及 renderer 实际 listener 同代；只改字面硬编码配对项：`preload/cuaPermissionPanel.ts:13` ↔ `main/cuaPermissionDragPanel.ts:66` 的 `zcode:cua-permission-panel-state`。其他引用 shared 常量的 main/preload（`desktopMainIpcPlatform.ts`、`desktopMainIpcRemote.ts`、`desktopBrowserViewIpc.ts`、`desktopBrowserDataIpc.ts`、`desktopCommandHandlers.ts`、`desktopHostProcess.ts`、`desktopWindowLifecycle.ts` 等）优先保持类型安全并测试行为，不另复制 channel 字符串。`desktopRemoteAccessIpc.ts`、`desktopWebRemoteControlIpc.ts` 和 transport 可能与 R42 相邻：共享文件只经主控确定串行，不触碰协议语义。
- `__ZCODE_DEVICE_ID__` preload index:29 → desktopPlatform:217 是内部同版本桥；`__ZCODE_RENDERER_DISABLE_LOGGING__` client `rendererLoggingEnv.ts` ↔ UI `logger.ts` 及其测试/诊断 fixture；`__zcodeFinalArmsCustomEventsE2E` preload index:102 ↔ `desktop/test/e2e/helpers/conversation-telemetry-parity-capture.ts` 与 `process-resource-telemetry-roles.test.ts` 等测试 probe。逐对改生产、测试及类型，不借此更改 R46 遥测事件名称。删除历史 zcode:// 分享/账号注释不属行为，保留；已有深链 title/endpoint 只回归。
- Wheel bridge：`preload/embeddedBrowserWheel.ts:117` 生产 `EmbeddedBrowserWebviewChannels.WheelBoundary` → `ui/src/browser-use/useEmbeddedBrowserWheelChain.ts:26` 消费，两端仓内同版本，shared 值由 R40 改 `zody:`；`desktop/test/embeddedBrowserWheel.test.ts` 和 `ui/test/UnifiedBrowserView.test.ts` 验证方向。此结论已发送 R40 写者。
- CodingPlan webview：非内部双端；`desktopWindowChrome.ts:50,450`、`desktopMainIpcRemote.ts:71` 明示官网购买专用 preload/webview 已删除，当前检索不到 `CodingPlanWebviewChannels` 活跃消费者。runtime-contract 明确保留外部官网桥旧值，不虚构使用方或删除兼容合同。plugin sandbox、embedded JavaScript dialog、resourceManager、CUA panel 名称各按各自实际 owner，不把所有 preload globals 视为同一个主桥。

## builtin 属性闭包

`packages/provider-node/src/runtime-paths.ts` 生产/读取 `zcodeBuiltinFilePath`；`provider-config-runtime.ts` 消费 `zcodeBuiltinFilePath`、`zcodeBuiltinActiveFilePath`、`zcodeBuiltinRemote`、`zcodeBuiltinEnvironment`；`zody-builtin-cache-paths.ts` 与 `endpoint-scoped-zody-builtin-source.ts` 成对使用 `zcodeEndpointOrigin`。`packages/services/src/model-provider/providerConfigRuntime.ts` 和 CLI `apps/zody-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` / `packages/cli/src/provider-runtime-env.ts` 组装对应对象。变更需追踪 `packages/provider/src/{config-service,sources,resolver,registry-service,facades}.ts` 等共享 producer/consumer，按具体声明及对象字段原子切换；不改变远端 JSON `builtin_provider_config_json`、历史磁盘 `zcode-builtin-refresh.json` 或 revision 值作为文本替换。跨 owner 属性和任一 R42 重叠路径须主控冻结精确 writeSet，不能以当前 P2 前路径清单为授权。

## 验收切片

- 目标 tests：`packages/desktop/test/preloadDisposer.test.ts`、`rendererMessageHandler.test.ts`、`embeddedBrowserWheel.test.ts`、相应 Main IPC handlers tests；`packages/client/test/rendererLogging.test.ts`、`packages/ui/test/logger.test.ts`、`UnifiedBrowserView.test.ts`；以及 CUA drag/panel 实际双端测试。补 preload 真实公开桥的属性/方法、IPC 请求响应与事件/取消订阅同名闭包，旧主桥不作为 fallback；轮滚与 plugin iframe 兼容保持原有隔离。核对桌面目标测试中含真实 renderer 主桥，而不是仅 mock 常量。
- builtin：`packages/provider-node/test/{provider-node-runtime,zody-builtin-consumption,zody-builtin-lifecycle,zody-builtin-integrity}.test.ts`、`packages/services/test/providerConfigRuntime.test.ts`、CLI `process-provider-registry-runtime.test.ts` 与 `zody-builtin-model-runtime-integration.test.ts`；覆盖真实组装→读取，以及旧外部/持久字段保持。检查缓存与迁移不被属性重命名破坏。
- 实际 Desktop 冒烟需覆盖 preload/main/renderer 同版本操作和事件，并隔离 HOME、合成工作区；执行前先架构 baseline、受控 context、补 spec/test 再实现。最终 root typecheck/lint/changed architecture；真实 Desktop 运行环境与平台缺口如实记录，不以 mock 冒充。
