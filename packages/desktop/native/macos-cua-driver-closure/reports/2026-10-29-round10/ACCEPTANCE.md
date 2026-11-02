# macOS Computer Use Phase 1 第十轮验收

2026-10-29。**本轮可实施切片完成；产品采用仍 blocked，功能默认禁用。** DeepSeek 实现，controller 调查、先更新 spec/计划、逐项审查增量并独立构建和验收。没有证书安装、签名修改、钥匙串/TCC 变更或 UI 操作。

## 完成范围

1. 新增独立第一方原生 peer 诊断。真实 AF_UNIX socket 的完整 `LOCAL_PEERTOKEN` → `SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit)` → 动态代码有效性、实际叶证书、identifier、严格 designated requirement；不接受自报 PID，不以 Team ID 授权，不回退到 PID-only 查询。非阻塞帧与 deadline、预存/替换 socket 保留均有真实场景证据。
2. 显式单 ref 控制接线借用既有 `CuaSubmissionProducerPort` 与 `onRevocation`，runtime authority 仍唯一拥有 candidate/revoked/revision。首次失效先锁存，再请求原 owner 撤销并等待真实 cleanup；覆盖启动/清理交错、迟到 ACK、重复通知、stop 前后终态和失败传播。没有另造 lease、frame owner 或可执行许可。
3. 真实 authority + 正式 control-only 子进程的 stop/mobile 撤销组合通过。反向撤销的回执专用通道最多保留 requestTimeoutMs，再自动清理；这个期限只限制资源保留，不证明 ACK 送达或 native drain。所有 stop 结果仍为 native unknown、machine lease unavailable、stopComplete=false。

两项基础未接成真实 Helper 执行链，诊断 JSON 不能重新注入为授权。没有生产 bindTurn/producerLost 接线，也没有调用 R9 采集或发布 finalFrame。

## 独立验收台账

|层次|结果|证据|
|---|---|---|
|R9冻结树|776文件及摘要一致|`checks/round9-source.json`，树 `421530ae…e02e`|
|本轮增量重建|68文件内容逐项匹配|`source.patch.gz`、`baseline-source.tar.gz`、`source-manifest.json`|
|原生编译/链接/启动|通过，当前arm64机器范围|SDK27.0、clang21.0.0、min14.2；`native/build-manifest.json`|
|真实peer/系统Security|3个拒绝场景通过|ad-hoc/缺叶证书观察、错PID、错UID；`native/test-report.json`|
|真实socket边界|3个场景通过|预存路径、被替换路径保留，部分帧超时|
|现有签名Node下层对照|2个场景通过|真实叶证书pin机制正向、错pin拒绝；Helper策略始终拒绝|
|原生套件其余检查|10个纯策略/profile、1个JS preflight、1个默认blocked检查符合预期|不能计为真实Helper身份通过|
|正向local-self-signed Helper|**未执行/blocked**|套件对“缺证继续blocked”的断言通过，不是Helper通过|
|CLI控制/authority/相邻回归|15文件125项通过|`checks/cli-tests-accepted.log`；含正式入口组合、普通Browser/CUA未开放回归|
|控制协议/producer|5文件67项通过|`checks/control-protocol-tests.log`|
|既有静态Helper工具|2文件47项通过|`checks/existing-helper-tests.log`；不等于签名Helper运行|
|新增Peer测试|3文件10项通过|`checks/peer-tests-final.log`；移除unused import后纯测试9项又通过|
|根与CLI typecheck/lint|全部通过|CLI typecheck30任务、lint14任务；根lint301 warnings/0 errors，与开工一致|
|架构|0 violations|desktop/CLI上下文managed=false、无受控合同；不等于安全认证|
|定向格式|30份JS/TS通过|根检查实际处理14份，CLI cwd另检查16份；两个日志分别记录|
|真实截图/输入/TCC/lease/Fenced/完整D06|**未执行/blocked**|不能由上述编译、测试、撤销或进程退出替代|

拒绝结论由本诊断策略根据真实内核/Security观察作出，不冒充OS安全层拒绝：ad-hoc对照的`SecCodeCheckValidity`本身返回成功（OSStatus 0），指定requirement不匹配、无叶证书，最终由本地严格策略拒绝。报告字段`realSecurityRejection`按这个范围解释，不是D06隔离证据。

自动化测试合计 **25文件249项**；原生套件场景与其中Native测试会重叠，不再累加为另一组测试总数。当前机器为 macOS26.6.2 / arm64，Node24.14.0、pnpm10.33.2。没有DYLD覆盖。Intel和最低macOS实机未验收。

## 产物、来源与保留

最终诊断二进制 SHA-256：`0f9c78bc691d5c6044854ce3b1d3c620b110a8b2bcb2e38b311645c8a5b65cb0`，301208 bytes，位于 `output/cua-helper-round10/controller-final/bin/macos-cua-peer-diagnostic`。29份native材料与构建清单一致；实际直接系统动态依赖为7项，无Driver/SCK/Swift桥进入本可执行文件。签名是 linker ad-hoc，**不是 local-self-signed Helper**。

[来源、许可、系统依赖与观察边界](BOUNDARIES.md)单独列账。新增源码为第一方Apache-2.0，许可原文与根LICENSE摘要一致，没有派生第三方代码或修改registry。R9的20包图、44份许可材料及Rust/Swift测试仍仅作为历史基线，未冒充本轮重跑；旧SDK许可缺口未补齐。

开工3986文件快照仅5份预先声明的控制代码/测试及4份文档变化，无缺失/意外变化；前轮冻结和验收材料保持。这个结论限于快照范围，不声称覆盖工作区全部无关文件。没有clean/reset或覆盖前轮改动。源码补丁只表达本轮增量，需要已有项目/前轮基线才能复跑完整测试。

[审查裁决](REVIEW.md)记录修复和不采纳项。`failed-attempts/`保留中间缺头文件编译失败、fixture等待环、测试字段错误、公开包解析失败及新增lint警告。临时core测试alias已删除，最终组合按package.json公开exports加载新构建产物，未靠源码alias或成功stub通过。Worker环境结果不代替controller实测。

## 剩余阻断与下一阶段顺序

1. 固定真正local-self-signed Helper/App身份、实际bundle元数据、加载闭包、双向peer绑定与登录/父子关系、升级稳定性。Node对照不证明加载的JS，也不符合Helper的DR/entitlement/minos要求。
2. 将可信Helper资源与既有submission/lease生命周期接线。本轮没有可借用的产品机器lease owner；R9私有window guard不是替代品。不得新增approved/leaseGranted授权状态。
3. 在明确证书安装或系统权限操作及影响、获得相应确认后，验证真实TCC归属、单窗口采集、取消和退出；再完成native Fenced/手机屏障、完整D06、Intel及最低macOS。local-self-signed持续采用，无Developer ID或公证迁移期限。

`zcodeCuaPlaceholder`仍为true，默认launcher/executor及模型工具schema未开放。
