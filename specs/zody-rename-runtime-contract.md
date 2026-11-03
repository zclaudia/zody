# Zody 改名运行时契约

状态：实施目标；R40–R48，现有旧实现不代表已满足。身份、权限、workspaceIdentity 和 remoteSessionId 的现有边界不变。禁止 P3/P4 分开发行；部署全部目标后才开放连接。

## 代际与门禁

统一内部代际常量 `ZODY_RENAME_GENERATION = 2`；不是产品版本或 V4 会话协议版本。值必须为整数 2，缺失、其他数字、字符串及多值均为不兼容。共享 API `checkRenameGeneration(value): {ok:true} | {ok:false, code:"incompatible-generation"}`；严格解析每种信封后调用，错误可见但不泄露 token。既有认证、一次性 capability 和身份校验不能由版本替代。

- stdio server 首行严格 `{type:"zody-hello", version:string, platform:string, arch:string, pid:positive integer, generation:2}`；client 回复严格 `{type:"zody-hello-ack", version:string, clientId:nonempty string, generation:2}`。保留 SSH 非 JSON banner 跳过；识别到旧 `zcode-hello` 或无效/错误代际即拒绝，不等待超时。server 只在有效 ack 后注册 RPC；client 只在有效 hello 后写 ack、移交同一缓冲区的剩余字节。新 server 拒绝旧 ack，旧 server 的 hello 被新 client 立即拒绝；超时只处理静默对端。失败、EOF、取消关闭所属 stream/子进程并移除监听器和缓冲，零业务 admission。
- `GET /api/server-info` 在现有字段上增加必需整数 `renameGeneration:2`；新 client 必须在连接前验证，缺失即失败。两套实现 `packages/server/src/http.ts` 和 `packages/zcode-server-cli/src/server-core/http.ts` 均实现。`/api/rpc-host-capability`、`/ws/host` 的新请求携带 `x-zody-generation: 2`；先认证和代际验证，再签发/消费 capability、升级与注册业务；旧 header 不授信。普通 HTTP 请求失败返回 HTTP 426 与 JSON `{error:"incompatible-generation"}`；WebSocket upgrade 拒绝只要求 HTTP 426 状态，客户端显示兼容错误，不要求 JSON body。普通浏览器无法设置自定义 header：`/ws` 和 `/ws/remote/:id` 使用 WebSocket 子协议 `zody-generation-2`，服务端升级前要求并选中它；客户端验证所选子协议后才发送 RPC。缺失/错误拒绝升级；新客户端遇到旧服务器未选中协议时关闭，不发送业务。包括 remoteId 分支，server-info 检查与子协议都必须验证，防止缓存页及中途目标变更。
- 手机经 gateway 到已有 desktop attachment：复用 `web-remote-control-channel` 的严格 `hello`/`hello_ack`，将 channel protocolVersion 从 1 增至 2 并精确校验（与 `ZODY_RENAME_GENERATION=2` 数值相同、语义独立），沿用 appProtocol 范围协商；ack 只有协商成功后发出。旧/缺失版本以既有 `close{incompatible-version}` 关闭，双方在 ack 前不发送 data、订阅或恢复。gateway 只转发，不将字段或 token 提升为 trusted host。保留 workspaceIdentity 和 remoteSessionId；断线清理 attachment，重连重新握手后恢复 replayable，不新建 Host/Agent。

```mermaid
sequenceDiagram
  participant C as Client / phone
  participant G as Gateway or HTTP/stdio
  participant H as Existing Host/runtime owner
  C->>G: authenticate + generation negotiation
  G->>H: verified attachment / handshake
  H-->>C: compatible ack
  C->>H: RPC or replay subscription
  Note over C,H: mismatch: reject, close and release; no admission
```

同代分别验证 desktop-continuous 的实时流和 web-remote-replayable 的断线恢复；旧新双向分别验证零业务写入和进程、socket、capability、监听器清理。部署锁保证并发串行；安装失败、取消或运行版本不匹配不得开放入口，保留可回滚的完整旧组合，skipDeploy 也必须验证真实运行实例。

## 数据、环境与信任

非插件 `ZCODE_*`/define 硬切为 `ZODY_*`；新旧并存只认新名，子进程和远端传递一致。插件例外见 [contract-map](../docs/plans/zody-rename-execution/contract-map.md)。artifact URI 硬切且不迁移旧媒体；会话主体仍可读。遥测一次上报新名称，不双发。工作区 hook 信任按原始来源与摘要验证，不能把 `.zcode` 记录改写为 `.zody` 后继承批准；移动、篡改、未知 schema 和拒绝均不能执行。现有 project `.zcode` 只读路径兼容仍有效。

RemoteServer stdio 的 hello/ack 不适用于 Agent stdio。Agent 的 LF JSON 帧及 CLI 对端保持既有协议和请求关联、分片、EOF、进程清理；原子名称清单和实际调用端见 [契约映射](../docs/plans/zody-rename-execution/contract-map.md)。

## 独立 Server ESM 发行入口

独立 server-cli 与 server-core 的生产 ESM bundle 共用显式 `createRequire(import.meta.url)` 兼容桥，以入口实际发行位置解析内联 CommonJS 所需模块；保持原有内联布局和依赖版本，不新增旧名兼容或改变握手协议。动态 require 目标必须经两份真实 bundle 核验：Node 内置模块可由该桥加载，其他字面目标或计算目标须明确来源、发行闭包与许可，未知目标不得静默视为安全。

验收使用真实构建和 staging 产物，在隔离 HOME/TMP 与不能回落仓库 node_modules 的独立目录验证 CLI help/version、Supervisor fork 的 core ready、localhost server-info、停止及进程/socket 清理；确认同一发行目录内资源和依赖完整，记录平台、工具链、hash 和真实失败。mock 或构建成功本身不能替代真实入口验证；未运行的平台保持 pending。
