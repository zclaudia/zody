# pre-push 大差异文件列表（2026-11-19）

用户后续决定移除本地自动 pre-push。普通分支推送由 Git 完成。仓库停止通过安装依赖注册 Husky，保留 `pnpm verify:pre-push` 及其受影响测试脚本作为手动入口。下述缓冲区修复继续服务手动检查，既有标签发布 CI 继续独立验证。验收检查安装后无仓库自动 hook、手动脚本仍可用，并用普通分支推送验证。

以下是移除前的故障与修复记录。

本轮正常推送250个本地提交时，affected-test脚本读取14116个变更路径（1190968字节），超过spawnSync默认约1MiB缓冲，返回status=null、error=ENOBUFS；错误处理又将部分NUL分隔文件列表整段打印。lint与架构已通过，单测尚未开始，不能记为测试失败或绕过hook。

唯一命令执行入口 `scripts/run-affected-unit-tests.mjs` 的run负责有界收集子进程输出，runGit负责有界错误说明。将捕获缓冲显式设为64MiB，保持基线选择、删除文件触发全量及全部测试门禁不变；失败时优先说明spawn错误或stderr，stdout仅作为有界后备。不得打印完整路径列表、跳过hook或将工具失败算成检查通过。

回归用隔离fake git输出超过1MiB的NUL列表，证明仍能完成选择；另模拟非零退出且有大stdout，证明错误提示有界。真实git diff再确认读取完整14116路径，之后以正常pre-push重新推送。
