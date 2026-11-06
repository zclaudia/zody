# Workflow 默认身份：主控验收与清理

基线 `56deb506be13ba249b5dd8ea8587eee45f1b95d2`。单一 Terra writer、DeepSeek 独立验收通过；7 写入及 10 验证路径冻结，manifest SHA-256 `1c1c19b51249e33e281c5f73362af860588939eaf11d0f3fb6489e53dc6150d8`。主控及独立审查均复算：两个生产文件只将四个第一方默认 literal 从 `zcode-workflow` 改为 `zody-workflow`，其他字节不变。显式普通名、旧名、空串、expert 分支及历史值保持原规则。

最终定向运行通过：实际 guarded child 4 项、公开 facade/expert 2 项、UI 26 项。另有 27 个 child 文件用例及 40 个 facade 文件用例被名称过滤，没有宣称整文件全部重跑。child 读取真实 session store 的消息，并观察一次父权限请求和拒绝不执行；facade 读取实际 child SQLite 消息及 call-through 父端口配置，不冒充实际权限 prompt。UI 保留旧显式标签，并新增默认标签。插件根解析器仅在这两项 facade 测试中返回空，实际被调用且未生成插件依赖目录。

冻结后 bootstrap `tsc --noEmit`、根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 四项均 exit 0；Lint 有 303 条既有警告。前置 freshness exit 0。架构上下文 CLI/UI 为 unmanaged；root scoped formatter 没有覆盖被忽略的 CLI 文件，新 facade 测试块单独格式化，不宣称全格式通过。17 个 worker 命令/日志和四组主控日志均核对哈希。旧 R46 generic fixture 以 source manifest 和未变 blob 关联，不作为新 OS hook、workflow usage 关闭重开或完整 E2E 的证据；GUI、发行构建、真实用户数据库未执行。

验收后精确清理一次：删除两个 Node 编译缓存文件 **2,725,256 字节**，移除 32 个空目录。包含 **305,716 字节 JSONL** 的 `/tmp/zr20agent` 整根同卷迁移至 `output/zody-rename-cleanup-20261104/r20-workflow-agent-preflight/preserved-zr20agent`；原 red/fail/green 日志和格式副本全部保留。71 个保护文件前后哈希相同；独立 post-audit 同时验证迁移目录 11 个条目的路径、身份、类型及文件哈希，零错误。五个旧临时根均消失，三个必要 worktree、两个分支保持。

文件系统可用空间观察增加 **2,666,496 字节**，包含并发 APFS 活动，不等于独占物理回收量。清理器不得重跑。证据位于 `output/zody-rename-r20-workflow-agent/controller/` 的 `final-verification.json`、`cleanup-preflight-final.json`、`cleanup-journal.jsonl`、`cleanup-result.json`、`post-cleanup-verification.json`；提交关联另存 `accepted-commit-association.json`。此为有界源码验收，完整 rename、R48 与发布仍未通过。
