# R40 Agent metadata 控制器核验

基线 `fe99c9a4531aaeead982826c2be6c5cf3f929c89`。Terra 完成两个已确认私有 metadata 字段的生产/消费切换；DeepSeek 独立验收通过。原 17 路径范围通过 addendum-3 增加一个现有 AgentService 测试文件，最终 18 可写、6 只读。控制器核对 24 源文件、六个只读基线和 59 份命令日志，0 不匹配、0 越界；runtime spec 仅追加，R42 phone 合同原文保留。

最终源清单 SHA-256 `f3f9f99095f8ef8994bbe38aa9225130850e2a8c8f36619b0ecfd58c2cba2ca1`；核验索引为 `output/zody-rename-r40-agent-meta/controller/final-verification.json`。固定 Node 24.14.0 / pnpm 10.33.2，实际测试与检查子进程使用完整 allowlist 和 `/tmp/zr40meta` 合成 HOME/USERPROFILE/TMP/XDG。没有新 worktree 或显式依赖安装命令；合成插件 seed marker 为 filesystem，重复依赖与仓库及保留 canonical 匹配，不能仅凭相同内容认定具体选用的绝对来源。

根 `pnpm typecheck`、`pnpm lint` 与架构检查均退出 0；Lint 保留 303 条警告。250 项根定向与 116 项 CLI 协议测试通过，后续仅对新增或修改的案例复验。实际 LF mapper、任务 adapter/RPC、retry tracker、UI projection、真实合成 SQLite 关闭重开和受控 Node 对端分别提供各层证据，不冒称整条真实远端链路。测试位置调整复用已存在的约 450 行 adapter fixture，避免复制。初始失败均保留；非空未知 retry 对象的默认归一化保持基线，仅纠正过严测试预期；自动 traceId 不同的还原测试改为比较业务消息。

范围内原有 formatter 问题保留，新增段局部格式检查，不作全仓 fmt 通过声明。未知 metadata 的真实生产者仍未确认：历史来源补查和独立产品决策方案已准备，当前旧 backgroundAgent 回退及其他 hold reader 不变。R47 和 ready FD 生命周期修复不在本批。

清理已按 `controller/cleanup-remote-id-manifest.json` 的三个精确候选执行一次：Git 可再生的 CLI 基线副本、Node 编译缓存、与 R46 canonical 完全相同的 computer-use 依赖，共 27,954,274 逻辑字节。插件源码、日志、失败证据和未证实可再生的 formatter 副本保留，原临时根迁入 `output/zody-rename-cleanup-20261104/r40-agent-meta-preflight/preserved-zr40meta`。SQLite 测试源码和日志保留，原临时根清单中已无存活的独立 SQLite DB，不声称保留了 DB 文件。执行前发现主控验证摘要从旧 27b/54 日志更新为 f3/59，已保留旧清单并只刷新对应摘要哈希；没有忽略不匹配执行。

同卷可用空间从 38,379,016,192 增至 38,407,716,864 字节，观测增加 28,700,672 字节；这受 APFS 并发活动影响，不是独占物理回收量。执行结果与 journal 位于 `controller/cleanup-remote-id-execution-*`。独立清理后核验 PASS、0 错误，24 个源、132 个证据、59 组命令/日志和 canonical 284 项匹配，原 782 项扣除两处缓存子树后保留 495 项。三个候选与原 tmp 不存在。仍有 3 个必要 worktree、2 个分支；未触及的 SEA/R45 仅做有限元数据检查，不宣称再次全量 hash。不得重跑本次或旧阶段清理执行器。

本批不代表未决 metadata 全部完成、真实手机/网络/Host/GUI、R48 混布或最终发行验收通过。
