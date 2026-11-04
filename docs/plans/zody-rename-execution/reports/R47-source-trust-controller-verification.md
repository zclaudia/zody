# R47.1 旧来源信任：主控验收与清理

基线 `db51e8b980d0e65a42ce3a42f7fa7f6601ee050d`。本批仅修改三个测试文件，既有 spec 与产品行为不变。Terra 实现、DeepSeek 独立 scoped PASS；11 个冻结路径含 3 write、8 verify，manifest SHA-256 `6ae669aa61dc7ddd4b9dac9a03ff14b0ea73f2100070908ac66975a088e1cfaa`。源码与证据位于 `output/zody-rename-r47-source-trust/implementation/`。

三种隔离来源为 `zcode.json`、`.zcode/config.json` 和显式 `explicit-hooks.json`。摘要从 `033f91783901e6adaf968d3d4b8ca34c41d89442:packages/shared/src/workspace-hook-digest.ts` 的 canonical declaration 数组独立重建，并由独立审查复算；不是旧 runtime 运行或真实历史授权。测试先确认实际来源类型、顺序 0、30000ms timeout 和 4096-byte output，再比较 literal。真实文件 store 写入显式 v1 record；新 app 实例读取原授权，原文件与格式化文件各准入一次。实际 `.zcode/config.json` → `.zody/config.json` 被发现，摘要变化后明确 pending 拒绝且零 dispatch；语义变化以 declaration-changed 拒绝。旧 record 文件字节保持不变。未知版本 999 在真实 store 边界返回 corrupt/空记录并保留恢复文件原字节，该项不扩大为运行时证明。

最终通过 34 个不同测试：adapter 两文件 19、共享 parser 12、新增 admission 3（文件内另 5 项未运行）；其中新增测试共 7 项，重复运行不累加。初次 discovery order 字段位置错误及语义变更错误码预期错误均保留失败日志，属于 fixture/断言修正，不是产品 red。准入使用真实 config/digest/store/runtime，但 ExecutionPort 是记录调用的测试替身，未运行 OS shell。多个 app 实例在同一测试进程内关闭重建，不代表完整 Desktop/Host/Agent 重启。

专用 output Vitest 配置继承 CLI 配置，按 adapters/core/contracts 的实际公开 exports 生成精确源码别名。实际 transform trace 核对 10 个关键信任链 owner 使用当前源码；其他传递依赖仍含 dist，不声称整个依赖闭包均为源码。插件 roots spy 仅用于新增 bootstrap 用例，finally 恢复，并断言隔离插件目录不存在；未 mock 信任 owner。13 组 worker 命令/日志、配置及原始 trace 哈希已核对。最终 root `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 均 exit 0，Lint 有 303 条既有警告。隔离 freshness 的 SSH 认证失败保留；CLI 架构上下文为 unmanaged。没有安装依赖、构建或访问真实用户数据库。

验收后只执行一次精确清理：删除一个 Node 编译缓存 **1,362,692 字节**，移除 23 个空目录；包含 **1,407,266 字节 JSONL** 的 worker 根同卷迁移到 `output/zody-rename-cleanup-20261104/r47-source-trust-preflight/preserved-zr47trust`。源码、原始日志、格式副本及有效产物保留。可用空间观察由 36,621,357,056 增至 36,622,667,776 字节，即 **1,310,720 字节**，含并发文件系统活动。独立 post-audit PASS：59 保护文件、11 源路径、迁移的 11 个条目完整，四个旧临时根消失，零错误；三个必要 worktree、两个分支保留。

主控证据为 `controller/final-verification.json`、`cleanup-preflight-final.json`、`cleanup-journal.jsonl`、`cleanup-result.json`、`post-cleanup-verification.json`，提交关联另记 `accepted-commit-association.json`；不得重跑清理器。R47 的完整 Desktop 重启、选中 attachment 路由问题及后续 R48 → R50 门禁仍未完成，本批不构成 R47 整体验收或发布通过。
