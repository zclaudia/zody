# R22 SEA 与 Desktop 内部包路径修正

基线 `ec6cf46ca6e5dcf5a420cf22f00ac1d38304639d`。六文件范围及逐文件 before/after SHA 在 `output/zody-rename-r22/sea-rename-fix/file-hashes.json`。先补 `specs/zody-brand-residual-cleanup.md` 验收规则，再补行为红测与实现；未修改依赖、根锁、许可生成对、外部 CUA 或 R30 环境变量。

SEA 资产生产者已经放置 `node_modules/@zody/tui/dist/index.js`，加载器仍读取旧 scope。回归通过真实 `placeRuntimePackage` 放置 fixture，再用真实 `loadTuiRuntime` 在独立子进程内模拟 SEA host API；旧版确实抛 ERR_MODULE_NOT_FOUND，修复后通过。同步 collector 默认 placement context 与诊断文字。该回归验证真实 resolver/loader 联动，但 host API 和资产是 fixture，不能代替已构建 SEA。Terra 的三个 TUI 相关测试通过，其中现有两个使用主工作树已有 dist，未声称由本批新构建。

Desktop 旧排除 glob 不再匹配已改名的 workspace 包。033f→edb 十个直接 workspace 依赖逐项映射相同；9d 全新安装物理快照 3053 条中不存在 @zcode/ package manifest。主控据此批准只同步一条 glob 为 @zody/**，保持原排除范围，不重新设计 bundling。实际 Linux target 配置及当前 manifest 的行为红测中，旧 glob 漏掉全部十包，7 项旧测试通过、1 项新测试失败；修复后8/8。最终测试动态识别所有 workspace: 范围并要求非空，不把十包数量变成永久约束。首次默认 macOS 测试因缺冻结 CUA manifest 未收集到用例，该失败单独保留、不作为行为红测。此项不证明实际 Desktop 打包或所有运行依赖已验证。

主控独立核对六文件 before/after SHA，复跑 SEA loader 行为测试1/1、实际 Linux target 配置8/8，随后根 typecheck、lint、changed architecture 全部退出0；精确 argv、隔离短 /tmp 环境和日志见 `output/zody-rename-r22/sea-rename-controller/results.json`。Terra 原始红绿和门禁结果在 `sea-rename-fix/`。真实 SEA 重建和独立 DeepSeek 审查另行记录，不提前称通过。

此前 edb 四目标构建停在首个 SEA stage，实际缺 shared dist。隔离候选随后执行公共 G 的 typecheck0并生成 shared/dist/index.js；真实 collector 已有 src→dist exports 改写，25/25入口解析目标检查通过。未修改 shared 的导出合同或构建设计，也未将解析目标存在误写为依赖执行通过。证据在 `output/zody-rename-r22/edb-shared-prerequisite/`；完整首次失败日志和长临时目录事实保留在 `R22-distribution-attempt-edb.md`。
