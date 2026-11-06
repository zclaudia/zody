# Artifact URI 切换与历史会话

新生成的会话媒体使用 `zody-artifact://`；store 只解析新 scheme。旧 `zcode-artifact://` 在历史记录中保持原值，不迁移、不读取、不重新生成媒体。会话及历史文本仍可加载；旧媒体和旧 input-history 附件降级为元数据，不进入文件、内联、缓存或源路径回退。

附件读取、stat 和 previewSource 必须先确认新 scheme 与当前 session 的授权，再访问缓存或 Host；普通文件路径使用既有规则，不能把旧 URI 当文件路径。assistant markdown 和 user previewRef 均服从同一授权边界。通用 URI 形状识别可保留旧字符串但不赋予访问权。新 URI 支持同 session 文本、二进制、媒体读写和重启恢复；外 session 拒绝。历史字节、来源路径及快照不改写，不恢复已删除的分享接口。

数据流：会话 store 拥有持久媒体 → gateway 按 session 授权 → runtime 读取或 stat → UI 投影；desktop continuous 与 mobile replayable 仍复用原有 Host/session owner，重连不新建 Host/Agent。旧记录投影只读并降级，不触发迁移或二次写入。
