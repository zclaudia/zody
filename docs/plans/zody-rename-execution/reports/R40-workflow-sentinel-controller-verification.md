# R40 saved workflow：主控验收与清理

基线 `a64d8843575e0df34cab0f2a2e356b2b615d8ab1`；单一 Terra writer，DeepSeek 独立验收通过。冻结 27 个写入路径和 5 个只读路径，共 32 个文件；source manifest SHA-256 `b6531584ef6c79020bec9c42e536de634735fa8b0c0cf2a406f9d2bdf3e9b7b8`。内部 recognizer 与新写 marker 分开，公共 core 导出未扩张；legacy 显式 metadata 更新按既有路径设计创建 canonical 副本，旧源不写入。

CLI 八文件先通过 180 项，随后真实 RPC 竞态测试两项通过，其中一项重叠，最终为 181 个不同测试；UI/服务三文件 50 项通过，parser 32 项为重叠复核。真实 NDJSON server/transport 完成更新、读取、列表和竞态失败验证；服务 mocked-client 与 UI 组件测试分别标识。已验证 macOS 实际异步 link 无覆盖发布、旧字节保护、发布前后清理失败及原字节 move；不扩张为其他 store/save/move 写路径的并发保证。

默认 CLI 测试解析旧 dist 的失败已保留。阶段专用 Vitest 配置继承现有 CLI 配置，仅将 core/contracts 精确指向源码，SHA-256 `67ab164ab4e4c92bc98976684b4b9765f35bbb94db3a2e096d195a8f0e584633`。这证明当前源码集成，不是发行构建。冻结后主控串行运行 contracts/core/bootstrap 三个包的 `tsc --noEmit`，以及根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，六项均 exit 0，Lint 保留 303 条已有警告。CLI 类型检查可解析保留的依赖声明，不能据此宣称构建产物已更新。

31 份 worker 命令日志、六份主控日志和所有冻结源码经哈希核验。隔离环境缺少 SSH 凭据，freshness fetch 失败，本地基线已精确核对；已有格式问题保留。CLI/UI context 为 managed:false。真实 Windows、其他文件系统/EXDEV、Desktop workflow hub E2E 和发行构建均未执行。

独立审查曾将保留的历史 proposal 与已修正的 grant 记录混淆，主控提供 `grant-proposal-association-clarification.json` 后关闭该项：两者路径/blob/role 完全相同，唯一 reason 文本不同，因此各自 scope digest 不同。历史 proposal 及首轮审查均原样保留，没有豁免产品范围。

验收后精确清理一次：四个 Node 缓存文件与三份已核对 Git blob 的基线格式副本，合计 **5,474,864 字节**，并移除 70 个空目录；七个合成临时根及格式副本目录均已移除。143 个保留源码/证据文件在操作前后哈希一致。文件系统可用空间观察增加 **5,406,720 字节**，包含并发 APFS 活动，不能作为独占物理回收量。没有删除源码、日志、共享依赖、保留构件或必要 worktree/分支；清理器不得重跑。

证据位于 `output/zody-rename-r40-workflow-sentinel/controller/` 的 `final-verification.json`、`cleanup-preflight-final.json`、`cleanup-journal.jsonl`、`cleanup-result.json`、`post-cleanup-verification.json`。提交关联另存 `accepted-commit-association.json`。仅接受此有界源码阶段，完整 rename、R48 与发布仍未验收。
