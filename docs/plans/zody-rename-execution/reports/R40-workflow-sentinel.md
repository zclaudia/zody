# R40 saved workflow sentinel

基线 `a64d8843575e0df34cab0f2a2e356b2b615d8ab1`。新序列化器写 `/* zody-workflow`，读取器严格识别首个非空行的新头与旧 `/* zcode-workflow`；旧文件只读兼容，不自动迁移。inline 保存拒绝两种头，关闭 frontmatter 解析的 snippet 保留原文；显式 global→project move 继续逐字节搬运，允许旧头随之保留。

显式更新 legacy 项目定义时，bootstrap 使用同目录独占 `.tmp` staging、写完整内容后 `link` 无覆盖发布 canonical，旧源字节不变；并发目标存在时失败并保留对方字节。发布前清理失败会报告异常及可能残留，发布后清理失败仍成功、保留 canonical 并尽力记录 warning。此 no-replace 保证仅限本操作，不扩及其他 store/save/move 写路径；不同平台和文件系统仍需各自验证。

规格先行，serializer 和旧源更新各有真实红测。CLI 原八文件 `cli-final` 180 tests 通过；随后在已有 RPC 测试文件新增实际 NDJSON server/link 竞态用例，`rpc-race` 两项通过，其中一项与前组重叠，因此最终范围为 181 个不同测试（不是 182）。parser-target 32 项是重叠复核。CLI 测试用 `implementation/vitest-source.config.mjs` 继承原配置并仅将 `@zody/core`、`@zody/contracts` 精确指向本次源码入口；真实 update/get/list 和 race 经 NDJSON transport、server dispatch、bootstrap 与 core 路径。最初 `green-pair` 中 bootstrap 使用旧 dist 而失败，source alias 后通过；这不是发行构件验证。真实 link spy 首次因 ESM namespace 不可重定义失败，使用同一 Node fs.promises 对象后通过；原日志保留。

root UI/服务三文件 `ui-final` 50 tests 通过：详情成功重载、失败无成功通知、项目列表刷新 canonical，服务测试是 mocked-client 转发，不冒充真实 RPC。实际 macOS 文件系统运行了 link 及确定性竞争；真实 Windows、其他文件系统/EXDEV 与 Desktop workflow hub E2E 未执行。前置 freshness 在合成环境 fetch 因 SSH 公钥不可用失败，未读取真实凭据；基线 HEAD 已核对。变更前 architecture check 通过，CLI/UI context 均为 `managed:false`。基线 formatter 已有问题的文档、E2E 和 CLI 部分文件未全文件重排；基线干净的新增代码与测试按 scoped formatter 检查，CLI/root scoped lint 均通过。root typecheck/lint/architecture 与 CLI noEmit 由 controller 冻结后运行，不在此推断结果。
