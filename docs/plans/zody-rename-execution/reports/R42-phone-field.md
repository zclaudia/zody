# R42 phone field：限定范围实施记录

本批将 phone application payload 的 live discriminator 从 `zcode_type` 切为 `zody_type`；channel protocol 保持 2，双方本地 app protocol 固定 `[5,5]`，历史 feature introducedIn 1–4 不变。Desktop 在构造时拒绝其他本地范围。Desktop hello negotiation 在查找当前 attachment 之前拒绝旧手机并要求升级手机；Web 对旧 Desktop close 或旧/无效 hello acknowledgement 在 ready、RPC 和 replay 前终止并要求升级 Desktop。拒绝可以关闭连接和记录诊断，不允许执行业务处理或替换现有 attachment。

共享顶层 own-key guard 在 Desktop raw 快路径和 Web schema 解析之前拒绝旧键或混合键；它不递归遍历用户内容。客户端 frame/ACK 使用新字段，保留原有 attachment、identity、时序、限制、分片、重组与 replay 合同。`gatewayDeviceTransportHello.ts` 为 verify-only：协商拒绝发生在 `getActive()` 之前，文件未修改。涉及的受控上下文按 architecture registry 读取 shared/client/desktop/web；四者均是 `managed:false`，架构检查不能证明其运行时语义。

规格先于实现更新，`red-range-root` 在原实现上产生 1 个预期失败、24 通过；首次 `red-range` 因路径选择无测试，保留原始失败。字段 guard 的负例在实现之后补充，不将其称作实现前红测。`focused-acceptance` 在当前源码上 17 个文件通过、1 文件跳过，300 tests 通过、7 skipped；跳过的 7 个是真实 gateway integration：隔离环境未设置 `ZODY_GATEWAY_IT_URL`，因此整组跳过，不能当运行成功。覆盖包括双端旧/混合 raw frame 和 ACK 拒绝、旧 app1–4 不能替换当前 Desktop attachment、Web 旧 ack 不能 ready、UTF-8/物理与逻辑边界、分片、重组和 replay；合法 `platform-request.args` 中的旧键和用户字符串经实际 payload 解析后保留；这不表示已知结构化 schema 会保留任意未知嵌套键。之前的 `focused-all` 因历史测试仍期望 R20 已改的 `__zcodeRpcControl` 而失败，已将该授权文件的断言改为当前 `__zodyRpcControl`；其后 `focused-final` 因新测试未导入 `vi` 失败，修正后重新运行成功。所有日志保留。

命令、合成环境、退出状态与日志 SHA 位于 `output/zody-rename-r42-phone-field/implementation/`；实际 UI/设备 E2E、新 Desktop/Web 制品构建均未执行。根 typecheck、lint 和最终 architecture 由 controller 在本阶段冻结后统一执行，不能从这里推断已通过。Agent metadata、R47 与 ready FD 生命周期修复不在本批；不声称完整 R42、R48 或发行验收通过。
