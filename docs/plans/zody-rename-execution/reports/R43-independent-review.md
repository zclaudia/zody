# R43 independent review

Reviewer `broker:deepseek-flash-ro-7e02c5e0e0181fbe:01a1a456-8275-7f92-ade9-5b96ca871195`, read-only `deepseek-flash` / `magpie` / `group/deepseek`; baseline `8d953d3c`, 2026-11-04.

**结论**
R43 在当前冻结快照上可作**限定接口/部署阶段验收（scoped acceptance）**，未发现需阻断的 R43 源码缺陷。该结论不包含真实远端发布、旧新制品混布或平台矩阵验收。

**已核实**
- 11 个 source/spec/runbook 哈希全部匹配，`controller-results.json` 无 mismatch；冻结后无源码漂移。
- 版本门禁位于 `packages/server/src/remote/handshake.ts:85`：严格 generation-2 schema 通过后、发送 ack 前，精确比较运行实例 `version` 与 `ZODY_VERSION`。`packages/server/src/remote/connect.ts:209` 在所有连接路径传入期望版本，包括 `skipDeploy`；不匹配不发 ack、不进入本地 RPC，并释放 backend。`skipDeploy` 与 post-install 不匹配测试均通过。
- `serverBundleDeployCheck.ts:8` 已切换为 `__zody_rpc_nested_uint8array_v1`；旧 marker/new marker 实际文件测试成对覆盖，旧 marker 会触发部署。
- `remoteDeployLock.ts:64` 的 heartbeat 现在只终止并等待自身 sleep，并将后台管道重定向到 `/dev/null`；`remoteDeployLock.ts:176` 的 abort 路径移除 listener/timer 并关闭本次 waiter stream。未改变 owner token、stale 阈值、心跳间隔、锁获取/释放超时或 caller-serialized 语义。
- 真实本地双 holder 测试验证了同协议串行、首个 holder 的 heartbeat/sleep 后代退出、第二个 holder 的 EOF 清理；同时明确演示不遵守锁的旧 writer 可以绕过锁，因此 runbook 要求先暂停旧部署者，而不是声称可 fencing 旧进程。
- 证据已闭合：`deploy-suite-01` 142/142；controller `controller-critical-01` 39/39 且无 skip；root typecheck/lint/arch 均 exit 0，lint 303 warnings/0 errors，arch 0 violations；format/freshness 通过；cleanup audit 记录 25 个 runner HOME/TMP 根缺失、25 份 raw log 保留。未运行 tests/build/install，也未修改文件。

**保留限制**
- 无真实 SSH、真实旧/新制品、rollback 和平台矩阵证据，属于 R48/平台验收；当前不宣称正式 rollout。
- 现有 abort 测试主要覆盖“等待锁、尚未获锁”的路径；锁获取后、安装过程中的取消与 WSL/Docker/SSH 真实子进程回收没有被直接证明。源码有 signal 检查和持锁释放路径，但不应扩大表述为“任意阶段取消均已完成资源回收”。
- `serverBundleDeployCheck.ts:48` 的 marker/`--version` 探测仍依赖远端 stream close，本身没有显式 timeout；不可响应的远端进程可能使部署检查挂起。该行为不是 R43 本次新增，但属于残余远端风险，应保留在 R48/transport 验收中。
