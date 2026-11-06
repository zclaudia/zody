# 合并关键组合独立只读复核

范围：mainBefore d5b2cc28e04a437a6e3b5fb44023cc08869cf691 与 renameHead fcd56d017b1729db0831b6b9075f1628536f7468 的进行中合并；审查指定手机远控、启动上下文及协议冲突解决，不重审既有 F4/F5。未修改源码或 Git 状态。

- 启动上下文：通过。`packages/services/src/zody-agent/nativeRuntimeStartupProfile.ts:172` 仍以 provider 设置生成 `providerDigestSha256`、selection 和 network；`zodyAgentProcessManager.ts:99` 的类型相符。与主线旧路径按命名映射比较，相关实现保留。
- 手机 shell/bridge/刷新 guard：限定指定文件的合并组合通过。相对 main 的功能差异主要为公开包和本地符号改名；`mobileShell.ts` 的轻量导出、Remote 启动和原生文件/通知桥、overlay 刷新保护保留。`mobile-ui-bridge.ts:36` 的 Shell/Remote 全局键与 main 一致，`mobileRemoteNativeHost.ts:28` 固定 `ZcodeMobileBridgeHost` 保留；shell 继续依赖既有配对、选电脑和 handoff。
- 协议：通过源码复核。`packages/shared/src/web-remote-control-channel.ts:33` 为 channel 2、应用范围 5；桌面发送 hello_ack 带版本，手机发送和验证版本。`gatewayDeviceTransportInbound.ts:55` 在 raw 分支前拒绝旧 discriminator；`gatewayDeviceTransport.test.ts:655` 覆盖旧键、混合键与新键，并记录 raw 回调。
- 验证限制：此复核只读源码、冲突记录和父版本差异；未独立重跑测试，合并构建和测试以主控实际结果为准。未验证真实 Android/桌面连接、发布或签名。未发现该限定范围内可操作的合并遗漏。

## 合并后局部修复复核

- `ServiceChannels` 的 task/agent/session descriptor 与 attachment 事务编码已统一引用当前 `Zody*` key；刷新 guard 使用现有 `zodySessionStore` 路径。gateway late-frame fixture 的重连 ack 为 channel 2 / app 5，断言仍检查旧 channel 迟到帧被丢弃与新帧顺序。
- 复核时发现 Windows 菜单文案键错误、5 个桌面命令及 IPC/renderer 的旧 API 标识遗漏，已通知主控修复。当前代码已核对：UI → renderer → preload → main 的 `getZodyStdioTapDevState`、菜单 → handler 的五个 `DesktopCommandIds.Zody*` 一致；文案恢复既有 `toggleZCodeStdioTap` key，双语 locale 存在；菜单测试 mock 值同步。
- 来源：这五个 desktop 命令及 IPC/renderer 旧符号在 main 和 incoming fcd56 的对应旧定义下均一致；本次合并适配更名 shared/preload 后未同步全部调用，属于合并组合遗漏。扫描 desktop 的 DesktopCommandIds、PlatformChannels、ServiceChannels 和 window/platform 限定旧 ZCode 调用，修复后未发现余项；`ShareImport` 命中为已删除功能注释。该搜索不是所有动态键或运行时路径的完备证明。
- 未独立运行测试；最终 desktop 类型和测试结果以主控验证为准。

## 冻结版本追加复核

- 对最终 source manifest 所列 14,335 个文件逐项计算 SHA-256，均与记录一致；manifest 汇总标识 `4f51b45ab5bf559b670d072aa90ea9e861b1fd2645a2b6ccebb502fa0aaca0b8`。
- `desktopBrowserPlatformBridge.ts:44` 的下载回调来自 main 原有功能；最终实现相对 main 仅将该委托的 `window.zcode` 适配为 `window.zody`，incoming 无此回调。preload 与 `packages/client/src/globals.d.ts:201` 均声明对应能力。renderer 独立 tsconfig 只 include 自身目录，并未显式导入 client 的 globals 声明；新增一处相同全局访问因此产生额外诊断，不等于下载行为缺失。此处未更改检查配置，未独立重跑 254/255 对照。
- `desktop/src/main/index.ts` 的 `onZCodeEndpointChanged` 与 `isZCodeBusy` 与各自 consumer 接口保持一致，回调仍指向合并后的实现。
