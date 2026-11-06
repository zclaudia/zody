# R41 stdio preflight — read-only, implementation pending

本交接以 R30 后工作树中的 R41 调用端为观察对象；R40 正在修改 shared/RPC，其 schema、常量和 API 尚未交接，本报告不冻结或推断其最终形状。不得将半完成的 R40/R41 当成可发布组合。无产品写入、测试、构建或安装。

## RemoteServer：双向门禁

- 生产 hello：`packages/server/src/entry-stdio.ts` 的 `main`，当前首行是 `zcode-hello`，随后 `waitForAck`，成功之后才 materialize provider、`createStdioServices`、`createStdioServer`、安装 lifecycle。目标 hello 为严格 `zody-hello` + generation 2；ack 必须严格 `zody-hello-ack` + generation 2。旧 ack、错误/缺字段/额外字段都不得创建 services 或 RPC。
- 消费 hello / 生产 ack：`packages/server/src/remote/handshake.ts` 的 `performHandshake`；当前跳过非 JSON banner、验证 hello 后写 ack 并返回 remaining。目标识别旧 hello 立即失败且不写 ack；合法新 hello 才写新 ack。`packages/server/src/remote/connect.ts` 在 handshake 成功后才 unshift remaining、创建 socket/protocol/client/services；该文件依执行计划不属 R41 写范围，优先在 handshake 内解决取消清理或由主控单独裁定必要扩权。
- 精确生命周期缺口：`waitForAck` timeout 当前只 reject 而不移除 data listener；无 end/close/error/cancel 清理；成功路径以字符串拼 chunk / Buffer.from 重建 remainder，UTF-8 跨 chunk 和同 chunk RPC 二进制可能损坏。client 也按 chunk `toString` 拼字符串再重建 remainder；onClose 与 timeout 做 cleanup，但 stdout end/error、stdin ack write 失败及取消链需明确处理。`connectRemote` abort 会 dispose backend，但握手尚未显式接收 signal；dispose 不必然证明 timer/listeners 即时释放。两侧都应以字节为单位定位首个 LF，保留 LF 后原始 bytes，避免流 flowing 交接窗口丢字节；成功或任一失败只结算一次、清理 timer/listeners；最终 owner 负责关闭 stream/child，避免重复 dispose。
- 推荐可测试 seam：在 R41 范围内从 entry 抽取独立 wait-for-ack helper 并注入 stdin、timeout、取消，保留入口启动行为。若新文件/测试需要扩权，交主控冻结；不要导入有 `main()` 副作用的入口假装单元测试。验证 server stdout 只承载协议、错误走 stderr。写 ack 的 backpressure/错误与移交顺序要有可观察断言。

## Agent：独立 LF JSON，不加 RemoteServer 握手

- producer/consumer 是 `packages/services/src/zody-agent/zodyStdioTransport.ts` 的 `send` 和 `handleStdoutData` ↔ `apps/zody-cli/packages/bootstrap/src/zody-protocol/transport.ts` 的 `ZodyProtocolNdjsonConnection` / `server.ts`；双方通过 shared `zodyProtocolMessageSchema`、`zodyProtocolMethods`、`zodyProtocolNotifications` 关联请求/响应。services 使用 StringDecoder，LF 分帧，stderr 独立，EOF 后进程树回收；CLI 侧保留有序处理与特殊并行请求行为。
- 路径已由 R20 改为 `zody-agent` / `zody-protocol`，旧文件分配表仍写 P2 前路径。当前此 transport 没有 RemoteServer hello/ack。登记中的 wire 名称应以 R40 最终 schema/方法表和对应调用方逐项对照，禁止据内部类型名、日志 `zcode_protocol.*` 或持久/外部身份推断替换。观察到 CLI `server-operations.ts` 的 `agent: "zcode-agent"`（1080、1180、1194）及 services `zodyTaskServiceAdapter.ts:1873` 的 `target: "zcode-agent"`；它们各自 consumer/owner 尚未证明为本任务的同一 wire 名称，须追踪并归属后才列入实际 writeSet。日志/遥测 owner R46、插件/持久身份边界不机械改动。

## 测试与待补

- `packages/server/test/remoteConnect.test.ts` 现有 fake backend 连接、断开及握手失败诊断；`stdioLifecycle.test.ts` 覆盖 RPC 启动后的关闭/清理，但都不等于 server `waitForAck` 行为验收。按执行计划新增 `packages/server/test/stdioHandshake.test.ts`，分别测试两端新新成功、新旧/旧新立即拒绝、缺/错 generation、额外字段、畸形帧、banner、无 ack、EOF、取消与 timeout；断言业务构造/注册为零，关闭一次、timer/listener 清理。模拟字节分片、多帧同 chunk、LF 后不完整多字节及任意字节原样交接；真实受控 child/双端连线验证成功链和失败资源回收。
- `packages/services/test/zodyStdioTransport.test.ts` 已覆盖 LF、U+2028/U+2029、跨 chunk 多字节、同 chunk 多帧、EOF 与 stderr；`zodyStdioTransport.processTree.test.ts` 覆盖进程树。CLI `apps/zody-cli/packages/bootstrap/src/zody-protocol/transport.ts` 的对应现存 tests 应与最终方法清单配对，补客户端请求 ID、顺序、分片、EOF/error 和双向实际通信；明确首帧是既有业务消息而非 hello。
- R40 合入后再核 schema 导出名、严格行为、代际检查错误码与 Agent 方法表；同文件 `remoteConnect.test.ts` 串行后交 R43。运行隔离 HOME/TMP/XDG 的受影响 tests、架构门禁、根 typecheck/lint；跨代真实产物及平台证据由 R48 验收，不将 mock 冒充旧发行物。
