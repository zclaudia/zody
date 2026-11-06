# Expert 与动态子 Agent 标识：主控验收与清理

基线 `b51426938367a25423064f76c9d6c61ce0846b77`。Terra 实现、DeepSeek 独立审查给出 scoped PASS；主控复核 11 个冻结路径（6 写入、5 只验证），manifest SHA-256 `9a31dda814d68a0755b50266d7922958e295097c68615a8a1ff2b270e3ed54e7`。产品仅两处 expert literal 和一处动态 Agent 名称前缀改变；后缀继续使用既有 profile 解析结果，权限来源保留 profile 名，历史数据不改写。

最终定向测试为 expert 1 项、dynamic 2 项通过，分别过滤 41 与 44 项其他用例，重复运行不累加。Expert 使用真实 child SQLite 消息和父端口 call-through，dynamic 使用真实 runtime/recording store 与 helper call-through，均通过 child ID 关联。没有宣称真实权限 prompt、OS hook、关闭重开或完整 GUI 验证。原测试中的无绑定变量引用在静态发现后移除，没有对应运行失败证据。

冻结后的 core/bootstrap `tsc --noEmit`、根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 五项均 exit 0；Lint 为 303 条既有警告。11 组 worker 命令日志与五组主控记录均复核哈希。隔离 freshness 因 SSH 认证失败未通过；初始错误的 `cli` context 和实际 unmanaged `zcode-cli` context 均保留，不扩大架构结论。

验收后仅执行一次精确清理：删除 3 个 Node 编译缓存，共 **4,087,932 字节**，移除 41 个空目录。worker 临时根中 **381,872 字节**的 JSONL 和合成测试数据整体同卷迁移至 `output/zody-rename-cleanup-20261104/r20-agent-adjacent-preflight/preserved-zr20adj`，全部日志保留。清理器核对 52 个保护文件前后哈希相同。文件系统可用空间由 35,555,311,616 增至 35,559,362,560 字节，观察增加 **4,050,944 字节**；该窗口包含并发文件系统活动，不等于独占物理回收量。

证据位于 `output/zody-rename-r20-agent-adjacent/controller/`：`final-verification.json`、`cleanup-preflight-final.json`、`cleanup-journal.jsonl`、`cleanup-result.json`。独立清理后审计 PASS：52 个保护文件、37 个迁移条目及六个旧临时根均核对，零错误。清理后审计和提交关联分别记录在 `post-cleanup-verification.json` 与 `accepted-commit-association.json`。清理器不得重跑；三个必要 worktree、两个分支及现有有效产物保留。本批不构成完整改名、R48 或发布验收。
