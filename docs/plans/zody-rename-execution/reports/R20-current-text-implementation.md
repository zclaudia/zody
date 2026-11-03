# R20 当前文字与独立 JS 绑定实施

基线 `66af64363af06f2729c3a725ebc9e06dc71964c3`。先按 `revision/rebase-66af.json` 核对 78 文件在 21c 与 66af 的 before SHA：12 个预检潜在交集中 5 个文件实际改变；修订补丁在 66af 上 `git apply --check` 通过并应用，未覆盖成员批更改。另同步新成员对应的现行注释、代码示例与 memory README；已删除业务和历史语境保留。当前 87 个 tracked 文件的 66af before/after SHA 为 `output/zody-rename-r20-current-text/final-preflight/revision/file-hashes-66af.json`，不包括主控账本或本未跟踪报告。spec 先补充当前文字和外部契约规则。

compact 与 memory 各自的 `loadZCodeModules` 独立导出及消费者改为 `loadZodyModules`；`staging-backup-task-readers.mjs` 自有 `zcodeTaskModeSchema` 改为 `zodyTaskModeSchema`。`js-payload-check.json` 对 7 文件证明当前字节严格等于 66af 源码仅做相应标识替换，fixture 数据、请求和持久化 payload 未变。peer 指出的 `@zody/shared` 以及 broker `listen`、`ready`、`close` 时序说明已修；原 21c 修订候选、hash 和 1602 声明审计仍保留。

保留 `ZCODE_PROTOCOL_NAME` 的 `ZCode Protocol` wire 名、5 个既有 Error.name、ServiceChannels、环境字段、provider-node builtin、旧快照输入、插件身份、第三方署名和冻结材料。`zcodeType` 在 shared protocol feature 表是现行内部分发字段，对应协议字段 `zcode_type`；desktop 的 `zcodeType` 是日志结构化字段，本批保留，分别由协议和 R46 日志/遥测合同处理；测试同名局部变量随其消费者语义保留，不将日志键当作普通产品文案替换。`path-validation.json` 实际核查 10 个文档引用目标存在，包括历史文档及现行 feature graph 路径；该 graph 文件名未属已批准源码移动，留 R21。

真实执行及 argv 见 `commands.json`：根目标测试 4 文件 82 项；dev-docs 7 文件 18 项；CLI 与 TUI 使用各包的 Node test runner，分别 7 和 4 项；隔离 HOME/USERPROFILE/TMPDIR 且去除 API key 的 compact fake 七场景和 memory bench 四场景通过。两个 E2E 使用本工作树已有构建产物，不能替代最终干净构建；无真实 provider 调用。lint 退出 0、303 warnings，changed architecture 0 violations；未安装、运行 Docker、新建 worktree、签名或发布。

最终根 `pnpm typecheck` 实际退出 0（`typecheck-final.log`）。本批未提交，需由主控对完整冻结候选进行独立复验、干净安装和后续生成验收。

## 主控集成记录

作者上述“未提交”描述交付时点；主控后续冻结为 `70366cdc774b5cb96fc2f7f6c57e17046d4a19a8`。独立审查确认绑定和 payload 变更，但指出三个当前注释与内部 hook 诊断文案未闭合，返回 CHANGES_REQUIRED，原始收据见 R20-current-text-deepseek-review-1.md；对应修正另行交付，不能把原批记为文本验收通过。
