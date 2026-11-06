# R42 phone field 控制器核验

本批基线为 `c5c669b8375b04e13cb8ec81b42a7661a912adfc`。Terra 在既定 44 可写与 1 verify-only 路径内完成 phone discriminator 与 appProtocol 5 切换；DeepSeek 最终限定范围接受。控制器逐项核对 45 个源文件 SHA、44 份命令日志及范围，未发现不匹配或越界。清单位于 `output/zody-rename-r42-phone-field/controller/final-verification.json`，最终源清单 SHA 为 `b733c372f05505639a5aeeb41c61ce56a586d7cbaf6e7cd8998aafe1faa61cb0`。

使用既有固定 Node 24.14.0、pnpm 10.33.2 与已安装依赖。实际子进程环境采用完整 allowlist，HOME/USERPROFILE/TMP/XDG 指向 `/tmp/zr42phone` 合成根；未安装依赖、创建工作树或启动真实 GUI、用户数据库与发布流程。最终根 `pnpm typecheck`、`pnpm lint` 均退出 0，Lint 303 既有警告；架构检查退出 0、违规 0。本次模块 registry 为 managed:false，架构结果不替代协议运行时测试。

联合 focused 为 300 pass / 7 skipped；真实 gateway URL 缺失的整组跳过如实保留。额外 39、201 与 32 项复验有重叠。原红测、错误测试选择、过时 RPC 标识断言、漏导入 vi、初次 max-lines Lint 错误和中途格式化语法错误的原日志均保留。max-lines 通过删除冗余类型注解及未使用导入修复，没有关闭规则；格式化临时错误恢复后，42 个调整前后文件的 formatter canonical bytes 相同，相关测试通过。11 个 scoped 格式失败与基线集合相同，不声称全 fmt 通过。

清理已按本阶段独立清单执行一次：三份 formatter 验证副本与一处 Node 编译缓存共 4,218,777 逻辑字节删除，隔离根剩余 fixture 整体迁入 `output/zody-rename-cleanup-20261104/r42-phone-field-preflight/preserved-zr42phone`。执行器前后校验 45 个源文件与 103 份保留证据。可用空间由 37,346,287,616 增至 37,350,535,168 字节，观测增加 4,247,552 字节；APFS 并发变化不等于本次独占回收量。清单、journal、执行结果和空间记录在 `output/zody-rename-r42-phone-field/controller/cleanup-opaque-*`，独立清理后核验在 `output/zody-rename-cleanup-20261104/r42-phone-field-preflight/`。核验无误后才开放下一写入阶段；本次及旧清理执行器均不可重跑。最新 c5 SEA、R45/R22 历史必要证据、R02 旧版资源和共享工具链保留，它们不自动成为本次新源码的构建产物。

清理后独立核验 PASS、0 错误：45 个源文件、103 份证据及保留目录逐项匹配，四个候选不存在；仍有 3 个必要 worktree、2 个分支，没有可删的闲置项。本批未触及的 SEA/R45 仅核有限元数据，不声称再次全量哈希验证。

当前缺口仍包括真实 GUI/设备 E2E、新最终制品与 R48 矩阵；本报告不表示完整 R42 或发行验收完成。R47 路由与 ready 资源生命周期缺陷仍为待范围决定事项。
