# R40 message ID：主控验收与清理

基线 `737ac457c6adbe71e6780619ab4f0cc07e067b8e`；单一 Terra writer，DeepSeek 独立源码验收通过。11 个写入路径（含报告）、17 个只读路径，共 28 个文件冻结；source manifest SHA-256 `3847ae6763d8a05fc105e597c2c1907d057a52c29af3455137bf7d87bdc79bc8`。六个生产文件经主控/独立审查核对，只执行限定 ID 替换；译文原样保持的证据是 exact-transform，而非测试对同一 catalog 的自比较。

五文件 139 项定向测试通过；随后新增 scope-key hash 断言的单文件 10 项复核与前组重叠。代表性 provider 红测 1 fail/6 pass，原始失败记录保留。实际 IntlProvider、26 个有效语言键、完整错误分支、TDP17 scenario 与 resolver→telemetry payload 均有验证。既有 Composer 测试使用 mock；真实 Desktop pending E2E 未执行，不能视为完整 GUI 验收。

冻结后主控串行执行根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，均 exit 0；Lint 有 303 条已有警告，架构检查无违规，ui registry 未受 managed policy 覆盖。远端 freshness fetch 因隔离环境无 SSH 凭据失败，本地 HEAD 精确核对；四个文件有原有格式问题，不宣称全格式检查通过。9 份 worker 日志与三个根检查日志哈希均已核验。

验收后按独立预检精确清理一次：删除一个 Node 编译缓存文件，共 **1,362,628 字节**；移除四个临时根内外共 30 个空目录。执行前后 64 个源码/证据文件哈希一致。文件系统可用空间观察增加 **1,314,816 字节**，包含并发 APFS 活动，不等同于独占物理回收量。格式验证副本尚未证明等价，保留；没有删除源码、日志、工作区依赖、保留构建产物或必要 worktree/分支。清理器不可重跑。

证据：`output/zody-rename-r40-error-message-id/controller/final-verification.json`、`cleanup-preflight.json`、`cleanup-journal.jsonl`、`cleanup-result.json` 和 `post-cleanup-verification.json`。提交关联另存 `accepted-commit-association.json`，避免自引用提交哈希。本记录仅接受此有界阶段，完整 rename、R48 及发布仍未验收。
