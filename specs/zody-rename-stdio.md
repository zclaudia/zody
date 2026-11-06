# RemoteServer stdio 代际门禁

RemoteServer server 单独拥有等待 ack 的状态；client handshake 单独拥有等待 hello 的状态。双方首个兼容信封通过 R40 严格 schema，代际固定为 2，server 先发 hello，client 验证后发 ack，server 收到有效 ack 才创建 provider 配置、services 和 RPC。SSH 非 JSON banner 仅可在 client hello 前跳过；识别旧 hello 或无效目标 hello 立即失败，不得发送 ack。无效、旧、缺字段或带额外字段的 ack 立即拒绝。产品版本与代际独立。

帧以 LF 分隔并按 UTF-8 解码；读取帧时保留字节，LF 后的全部原始字节包括不完整多字节和二进制 RPC 负载，在移交时完整有序且恰好一次交给 RPC。握手期间输入应暂停以防注册前丢失数据，移交后由流消费方恢复。成功、错误、EOF、取消、超时及写失败均只结算一次并清理 timer、监听器和 abort listener；失败时连接所有者关闭资源。失败前不允许创建业务服务/注册 RPC；既有 backend/child 清理由其唯一 owner 负责。

Agent stdio 是独立的 LF JSON 协议，保持现有 schema、请求/响应关联、顺序、UTF-8 分片、stderr 分离、EOF 和进程树清理，不使用 RemoteServer hello/ack；不改变 V4 帧。

验收覆盖新新成功、旧新双向拒绝、缺失/错误代际及额外字段、banner、任意分片及同 chunk 余字节、EOF/error/timeout/取消、错误写入和零业务初始化；通过受控真实本地 child 验证行为和清理，输入与 HOME 均隔离。
