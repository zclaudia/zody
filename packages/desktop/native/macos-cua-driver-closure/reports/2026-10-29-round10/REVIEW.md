# R10 controller review dispositions

状态：最终 controller 独立验收完成。实现由 DeepSeek，审查与验收由 controller；以开工文件摘要为增量基线，不使用包含前轮未提交改动的整份 git diff 充当本轮 diff。

## 已要求修复与补证

- launcher 首次失效必须同步锁 closed；先安装同一 finalize Promise，再调用可重入观察者。异步观察者拒绝被观察，最终 close 仍等待真实退出。
- session cleanup-before/during-start、stop-before-start、已失效 launcher 的 cleanup 均不得提前成功或留下迟到 child；失败保留给显式 cleanup。
- stop 先请求唯一 authority 撤销，再按 authoritative revision 发送 revoke/stop；操作对应的 ACK 事实必须成立，所有 native facts 保持未知。
- 反向请求限定完整 ref 和单个在途操作；外部撤销/stop/关闭使迟到 ACK 失效。回执通道仅允许有界保留，其超时不是 flush 或 native drain 证据。
- owner/resolve/revoke 失败不可只记诊断后宣称 cleanup 成功；关闭实际 child 与报告未完成撤销分别处理。
- 原生 peer 使用完整内核 audit token。显式 Security requirement 检查的失败必须进入策略判定；纯策略 fixture 不替代系统检查。
- 非阻塞 socket 在每轮按绝对 deadline 检查，帧大小有上限。记录 bind 产物 inode/device 后才清理；不得删除预存或已替换 socket。lstat/unlink 不是抵抗任意同 UID 主动攻击的原子安全原语。
- native profile 不能绕过 JS preflight 的类型、文件所有权/写权限检查；未检查 bundle 版本等字段明确列出。
- 正式 authority + official control-only entry 组合与手写 ACK 的竞态 fixture 分开；签名 Node 的下层机制对照与 local-self-signed Helper 验收分开。

## 复审裁决

R worker 提出旧 revision 在 resolve 期间漂移不应失效整个 binding。controller 不采纳这一建议：本切片只绑定单个完整 ref，authority 已确认完整 ref 不再匹配时应 fail-closed，不为保持 active 放宽身份要求。

R worker 建议在反向 ACK 入队后清理，但现有 channel 没有 ACK 已发送/已收到的生命周期回调。controller 选择明确有界的只用于回执的保留期，再自动 cleanup；既不增加 setImmediate 假屏障，也不宣称 ACK 送达。该规则先补入 spec，再委派实现。

未采用第二份授权 map、lease owner、frame owner 或 JSON grant。没有修改原始 registry、前轮冻结材料、钥匙串或 TCC，也没有授予 worker UI 权限。

原生最终复跑：缺少拆分后系统头文件、replacement fixture等待环、Vitest expected.uid误写为euid均已由DeepSeek修正。controller最终真实suite与校准通过，Peer Vitest 3文件10项通过；中间失败原样保留于failed-attempts。

公开入口组合的第一次统一入口复跑失败：worker曾在本轮新增core/vitest.config.ts alias指向adapter源码。controller发现后要求删除该本轮配置；最终测试读取adapter package.json声明的exports目标并动态导入新构建产物，未增加core生产依赖。最终统一入口15文件125项全部通过。root lint新增unused import亦已修正，回到开工301 warnings/0 errors。没有接受worker报告作为最终通过依据。
