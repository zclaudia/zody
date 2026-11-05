# plugin-ui-bridge

Host 服务是 UI 与 Agent MCP 之间的桥；UI 通过 `IPluginUiBridgeService` 使用，不直接读取 HTML 或连接配置。

- prepare 先向 Agent 取得来源绑定的运行凭证，再按 runtimeId/token/generation/resourceUri 合并资源读取与 Main 登记；不能仅按 renderer 提交的 scope 合并。资源读取前后由 Agent 检查连接代际。
- HTML 上限 16 MiB，mimeType 仅接受 text/html;profile=mcp-app 或 text/html；超限拒绝，不截断。HTML 经 Host 到 Main，Renderer 只获取句柄。
- 宿主从受信账号仓库读取 provider/profile.id 并哈希为 accountContext，不传 token。账号配置变更立即使在途 open 过期并关闭旧实例；同账号 token 刷新不触发换代。user_info 更新保守地重新验证实例。
- validate/close/recycle 透传完整实例凭证；recycle 仅在 Agent 确认没有审批/调用 pin 时成功。调用归属、权限、取消和终态由 Agent 单一拥有，Host 不缓存执行结果或重放工具。
- resources/read 原样返回 MCP contents，解码总大小限 8 MiB；Agent 同时检查 MIME 白名单。不裁剪内容，不经过模型摘要。
- 只支持本地 workspace Agent；远程保持现有不支持/普通 MCP 卡回退。复用 Host attachment、workspace identity 和会话 lease，不新建远程宿主。

- Sampling 仅透传到已存在的目标 workspace Agent，不新建/恢复执行、缓存结果或重放；超时/失败取消原 operationId。以严格 schema 返回官方基础 sampling 结果。

Sampling 使用独立 `IPluginUiSamplingService` 描述符透传请求与取消，不扩张资源桥方法集合；Web/远程未注入时不声明 capability。

## 资源 `_meta` 双键入站（R50 规则，R52 接入）

规则全文见 [插件 wire 兼容 spec](../../../../specs/zody-rename-plugin-wire.md)。本服务是 MCP Apps 资源 `_meta` 的实际入站边界，只调用 `@zody/shared/mcp-apps` 的公开规则函数，不另造兼容判断。

- 来源优先级不变：`resources/read` 选中的 HTML 项 `_meta` 是权威，只有该项没有任何声明时才翻 `resources/list` 条目兜底。
- 单键（`zody/csp` 或 legacy `zcode/csp`）按原 schema 归一化后接受；非法视作未声明，不因识别到旧/新键而放宽。
- 双键归一化相等才接受，返回值取规范值（不做"新键优先"）。
- 双键冲突（归一化不等或任一侧非法）时，`prepareSandbox` 以可见错误 `PluginUiBridgeError("resource_meta_conflict")` 拒绝整个资源准备：不登记沙箱、不携带任何 CSP 放宽，绝不合并两侧或取更宽的一侧（fail-closed）。错误信息包含两侧键名，便于插件作者修正声明。
- 其他资源字段（`permissions` / `prefersBorder` / 尺寸提示）语义不变；未声明的浏览器权限一律不授予。
