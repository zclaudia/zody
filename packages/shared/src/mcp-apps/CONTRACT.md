# mcp-apps-protocol

纯 domain 模块，零 IO。持有 MCP Apps 的 ZCode 扩展常量、工具 `_meta` 归一化结果、`display.ui` 投影 schema 与沙箱契约类型。页面 ↔ 宿主的线协议（`ui/*` 方法、握手、版本协商、JSON-RPC、错误码）由官方 `@modelcontextprotocol/ext-apps` 承担，本模块不再复制方法名或 schema。

类型与测试之外的不变量：

- `resourceUri` 来源按优先级：`_meta.ui.resourceUri` → 弃用扁平键 `_meta["ui/resourceUri"]`（规范 MUST 兼容）→ `openai/outputTemplate`；必须以 `ui://` 开头且不超过 2048 字符，否则整个 `ui` 描述视为不存在，而不是部分接受。
- `visibility` 缺省等于 `["model", "app"]`；不含 `"model"` 的工具不得进入 provider contracts；`readMcpToolVisibility(meta)` 独立于 resourceUri 读取。
- agent 对每个 MCP server 的 `initialize` 必须宣告 `extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`（`buildMcpAppsClientCapabilities`），否则按官方模板写的 server 只会注册纯文本工具。
- ZCode 扩展能力一律放 `hostCapabilities.experimental`（widgetState、resourceSubscribe、surface、csp），官方 SDK 的 zod 会剥掉标准位之外的未知键。过渡期双宣告：`zody/*`（canonical）与 `zcode/*`（legacy，1.0 运行时别名退役门禁）同时存在，`buildMcpAppsExperimentalCapabilities` 是唯一构造点；旧插件 feature detect 依赖旧键。
- CSP 缺省按规范块；`'unsafe-eval'` / `'wasm-unsafe-eval'` 只在资源 `_meta` 的 `zody/csp` 或 `zcode/csp` 声明为 true 时放行，未知键与非布尔值丢弃。双键同时出现必须归一化相等才接受，冲突时 fail-closed（回落规范缺省，不合并、不取更宽）。
- 沙箱句柄的 `shellUrl` 由 `sandboxId` 派生（`zcode-sandbox://shell-<id>/`）；`partition` 由 server 身份派生（`persist:plugin-sandbox-v1-<hash>`），同一 server 的页面共享持久存储，卡片关闭不清；`sandboxId` 只含 `[A-Za-z0-9-]`（CSP host-source 字符集）。
- 宿主 renderer ↔ relay shell 只有一条 MessageChannel（`PLUGIN_SANDBOX_PORT_NAME`），上面跑原始 JSON-RPC；shell 不解析协议。
- `widgetState` 是 ZCode 扩展：初值经 hostContext 的 `zody/widgetState`（及 legacy `zcode/widgetState`，同一快照）随握手下发，页面经 `ui/set-widget-state { widgetState }` 交给宿主 renderer 内存保存（不持久化、无可见性参数；模型可见信息一律走 `ui/update-model-context`）。
- `_meta.ui.surface` 与清单 surface id 共用字符集 `^[A-Za-z0-9][A-Za-z0-9_.-]*$`、≤ 128 字符，非法即丢弃。
- 页面发起的 `resources/read` 边界常量在这里：`MCP_APPS_UI_READ_RESOURCE_MAX_BYTES`（8 MiB）与 `MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST`（以 `/` 结尾为前缀匹配，忽略参数与大小写）；执行方是 agent 的 mcp-ui。
- 常见文档、图片、音视频、归档和字体按明确 MIME 条目接纳，不新增大类前缀；未知 MIME 与缺失 MIME 的 blob 仍拒绝。范围与回归要求见 [资源 MIME spec](../../../../docs/mcp-apps-resource-mime-spec.md)。

Gen UI 复用沙箱登记载荷，显式 `contentKind: "gen-ui"`，pluginId/serverName 留空且不允许权限声明；普通 MCP App 仍必须提供原来的插件与 server 归属。Gen UI 的页面业务 schema 独立位于 `@zody/shared/gen-ui`。

## 双命名空间兼容（R50）

规则全文见 [插件 wire 兼容 spec](../../../../specs/zody-rename-plugin-wire.md)。本模块的公共接口：

- `MCP_APPS_META_KEY_COMPAT`：`_meta` / `hostContext` / `experimental` 键对注册表（canonical、legacy、direction、failClosed）的单一事实来源；新增登记键先加这里。
- `readMcpAppsMetaEntry(meta, pair, parse)`：通用双键读取，返回 `absent | accepted | conflict`；单键按同一 parser 校验，双键归一化相等才接受，任一不可用按冲突处理（fail-closed）。
- `resolveMcpAppsCspRelaxations(meta)`：CSP 放宽的可见结果；`conflict` 携带两侧原始值供边界报错。`normalizeMcpAppCspRelaxations` 保持原签名，冲突时返回 `null`（不产生任何放宽），既有消费者零改动即获得安全兼容。
- 出站双表示：`buildMcpAppsExperimentalCapabilities`、`buildMcpAppsWidgetStateContextEntries`、`buildMcpAppsTruncatedMeta` 从同一份输入生成 canonical 与 legacy 两个键，两键引用同一投影对象。
- 归一化后的形状（`McpAppResourceMeta`、`McpToolUiDescriptor`、登记载荷）不因双键变化；未登记 `zcode/*` 键不做前缀泛化。
