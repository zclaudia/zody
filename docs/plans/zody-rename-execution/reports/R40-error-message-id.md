# R40 第一方错误 message ID 切换

基线 `737ac457c6adbe71e6780619ab4f0cc07e067b8e`。两语言有效 catalog 的 24 个错误 ID 与 `zcode.unavailable`、`zcode.initFailed` 两项定义，切为相同后缀的 `zody.*`，无旧 ID alias。六个生产文件均逐字节等于基线执行限定 ID 替换后的结果，译文、code 和其他内容不变；证据见 `output/zody-rename-r40-error-message-id/implementation/exact-transform.json`。两项非错误 ID 仅验证真实 catalog 查找，没有声称存在活跃消费者。旧错误、历史 raw、未知 `data.zcode.error`、插件事件和外部协议保持原有边界。

规格先行；`red-provider` 对旧映射产生预期失败（1 failed、6 passed）。五个指定文件的 `focused-first` 共 139 tests 通过；之后 `i18n-hash` 单文件 10 tests 通过，与前组重叠。测试使用实际 IntlProvider、合并后的 en/zh catalog 和实际 banner resolver，核对 26 键固定 SHA、旧键缺失及新键；四个 owner、十二 provider、Claude 两种参数、三 media、runtime、历史 BigModel、suspicious-empty、未知 code 和旧 runtime code 均覆盖。TDP17 实际 scenario 的 3007 文本和 resolver→真实 telemetry payload 验证为翻译文字；既有 Composer 与 parity comparator 作为回归运行，不能单独证明真实 Desktop E2E。pending Desktop E2E 未执行。

固定 Node freshness 尝试 fetch 因隔离环境没有 SSH key 而失败，未读取真实凭据；HEAD 精确为基线。变更前 changed architecture exit 0，ui context 为 `managed:false`。原 scoped formatter 检查十文件中两份 locale 与两份测试已有格式问题，未全文件重排；新增测试段按 formatter 输出整理。scoped oxlint exit 0。完整 argv、合成 HOME/TMP/XDG、退出码和日志 SHA 保存在本阶段 output。根 typecheck、lint、changed architecture 由 controller 在冻结后执行；真实 Desktop E2E、发布和用户数据未执行或修改。
