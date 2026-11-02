# macOS Computer Use 首期：DeepSeek 分工与控制器验收

日期：2026-10-25–26。当前用户授权将[首期计划](computer-use-macos-phase1-implementation.md)拆分给 DeepSeek 实现，由 OpenAI controller 做最终复核。本文记录工作边界、依赖与真实验收结果；产品规则仍以 [spec](../../specs/computer-use-macos-phase1.md) 为准。

## 授权与执行边界

使用 Broker 路线 `deepseek-official-flash`，配置返回模型 `commandcode-plan/deepseek/deepseek-v4.1-flash`。controller 的模型/provider 不变；授权项目仅 `/Users/zhvala/SourceCode/zody`。勘察任务 read-only，实施任务显式 workspace-write；不授予 Computer Use/UI 操作权限，不发送整个父对话。

本轮允许编写和验证默认禁用的候选契约、执行与生命周期代码。P0 仍是原生产品采用与激活门槛，不能通过开发入口绕过。不得移除 `zcodeCuaPlaceholder`、启用真实系统输入、修改 TCC、签名身份或发布设置；不得改写历史实验。候选代码通过不表示首期全部完成或正式验收通过。

## 当前签名策略（2026-10-26）

用户决定暂不加入 Apple Developer Program，持续使用自签名证书。当前验收采用 [spec 定义的 `local-self-signed` profile](../../specs/computer-use-macos-phase1.md#当前签名策略2026-10-26)；Developer ID 和 Apple 公证移至未来可选的对外分发阶段，不再阻断本地开发/自用验收。本次只同步文档，没有创建或安装证书、修改钥匙串/TCC、调整 entitlements 或启用真实输入。以下开工基线和测试结果保留为历史事实。

## 分工与依赖

| 工作包              | 范围与单一 owner                                                         | 依赖                             | controller 验收重点                                                               | 状态                                                   |
| ------------------- | ------------------------------------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| A 控制协议          | producer 公共合同、严格 schema、认证与重送规则；不拥有任务输入           | spec/control 字段冻结            | 错身份/版本/摘要/序号拒绝，ACK 不冒充 Fenced，无原生 IO                           | 候选协议验收通过；未接 sideband                        |
| B cell 执行         | node_repl main 管理独立 cell 子进程、调用传输与清理                      | 正式采用另需控制 sideband 与 D06 | 真子进程、取消/退出、凭据与 FD 边界、Browser Use 对照；不把进程分离当完整安全证明 | 候选进程/bridge 验收通过；默认 executor 不切换         |
| C 用户提交          | CLI runtime 唯一持有 lineage 资格/撤销；输入来源、自动续跑、手机投递屏障 | 完整接线依赖 A/B/Helper 回执     | stop/restart 不复活，mobile 不借 desktop scope 获权，未知 fence 不提前投递        | 内存 authority 验收通过；live admission/投递屏障待集成 |
| D 原生 Helper/frame | 机器锁/fence/ledger、Driver 与最终媒体链                                 | P0、A–C                          | 唯一输入 owner、真实目标/帧、资源 drain、崩溃恢复                                 | P0 阻断，未验收                                        |
| E 平台与产品集成    | services lifecycle、权限、UI 与分发                                      | D 与正式 profile                 | 懒启动、错误投影、手机历史非回归、保持默认隐藏                                    | 依赖阻断，未验收                                       |
| F 总验收            | controller 审 diff、复跑测试、检查最终制品/证据矩阵                      | 各工作包                         | 区分 contract/进程/桌面/live/packaged 证据；逐项记录未完成门槛                    | 本轮代码验收通过；产品验收 blocked                     |

第一轮 A/B/C 分别只读勘察，返回文件与接口边界；第二轮使用显式 workspace-write 任务实施。并发写入文件不得重叠；公共 spec/计划与集成调整由 controller 统一维护。若需改变公共接口，先反馈 controller 再更新依赖方。已有工作树改动按开工快照保留，不使用 reset/checkout 清理。

## 开工基线

- HEAD：`c5981debb46fab4d8d83881667907cf32512a049`；freshness 通过，ahead 30 / behind 0。
- 架构检查：0 violations / 0 new；读取 zcode-cli 与 services context，两者为 unmanaged，不能将该检查解释为全边界证明。
- 现有 node-repl-host：6 测试文件、51 测试通过。CLI typecheck：30 包通过；首次基线使用系统 Node 24.21.0，正式复验使用 `mise.toml` 要求的 Node 24.14.0 / pnpm 10.33.2。
- 当前主机 arm64；只读检查有效 codesigning identity 数量为 0。自有签名/TCC、Intel 与最低 macOS 的正式验收未完成。
- 用户在实施期间确认暂时没有上述签名及实机环境，要求记录阻断项；后续签名策略按上节更新。历史环境缺口不改成通过，缺 Developer ID 不再作为当前自签名 profile 的阻断。

## 结果登记

### Worker 与产物

三个只读勘察均完成，随后分别建立 workspace-write 实施任务。以下为实施 worker ID，均使用同一 DeepSeek 路线：

| 工作包 | Worker ID                                                                                 | 候选合同与代码入口                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A      | `broker:deepseek-official-flash-rw-c2d541bc0c4e8861:01a173b7-b672-7d61-9942-7e86217f5cd9` | [控制协议合同](../../packages/zcode-cua/CONTROL-PROTOCOL.md)、`@zcode/zcode-cua/control-protocol`                         |
| B      | `broker:deepseek-official-flash-rw-c2d541bc0c4e8861:01a173b4-945d-78b1-bc32-92c90b0cb0fe` | [cell/bridge 合同](../../apps/zcode-cli/packages/node-repl-host/CONTRACT.md)、`@zcode/node-repl-host/subprocess-executor` |
| C      | `broker:deepseek-official-flash-rw-c2d541bc0c4e8861:01a173b7-b6d2-7122-9c84-e3cb941d199a` | [submission authority 合同](../../apps/zcode-cli/packages/core/src/runtime/cua/CONTRACT.md)、`CuaSubmissionAuthority`     |

A、B、C 均已交付并经 controller 复查和实际复跑；本轮候选代码验收通过。候选实现不改变正式 MCU1、G1–G4 与 P1–P6 的通过状态。

### Controller 审查与修订

- 控制协议补齐双向 revoke、opaque incarnation、完整签名 body 的重送摘要、Ed25519 类型校验与遍历时预算。controller 实际复现初稿默认 64 条窗口在第 34 次请求失败，已修正独立 replay 容量并覆盖 64/1024 边界。
- authority 对外引用改为冻结副本；dispose 先封闭入口；producer 死亡保留有界 tombstone；unknown steer 撤销；producer 获得仅 resolve/revoke 的窄 facade。以上均有回归。
- executor 初稿补齐取消时立即撤权、重复 revoke/close 共用 drain、上下文副本、成功 frame 与真实 exit 关联、异步 FD flush/close。固定尾读延时已移除，改用完整 frame/EOF/exit 与调用取消信号。
- FD 验收使用真实独立子进程。受控 probe 证明 Node timeout VM 会在原请求管道关闭后复用 FD 3（原 socket mode 49298，关闭后 EBADF，VM 内 FIFO mode 4096，结束后 EBADF），不把编号复用误判为原管道泄漏。

### 已执行验证

所有 controller 正式复验均使用 Node 24.14.0 / pnpm 10.33.2。

| 命令 / 范围                                                                         | 实际结果                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                    | 通过                                                                                           |
| `pnpm --dir apps/zcode-cli typecheck`                                               | 30/30 任务通过；Turbo 仍报告预存 workspace/lockfile closure 警告，未改 lockfile                |
| `pnpm exec tsc -p packages/zcode-cua/tsconfig.json --noEmit`                        | 通过；此包不由根 typecheck 覆盖                                                                |
| `pnpm --dir apps/zcode-cli lint`                                                    | 14/14 任务通过；59 warnings / 0 errors                                                         |
| `pnpm architecture:check --changed`                                                 | 0 violations / 0 new；unmanaged 范围限制不变                                                   |
| core：`cua-submission-lineage.test.ts` + `mcp-tool-bridge.test.ts`                  | 2 文件 / 60 tests 通过                                                                         |
| 根：`control-protocol.test.ts` + `placeholderProducerDetection.test.ts`             | 2 文件 / 41 tests 通过                                                                         |
| browser-use-plugin：`subagent-browser-boundary.test.ts`                             | 1 test 通过                                                                                    |
| bootstrap：`bundled-plugins-resilience.test.ts` + `plugin-runtime-features.test.ts` | 2 文件 / 27 tests 通过                                                                         |
| controller 独立构建后的 cell harness                                                | 6 项通过：独立 PID、fresh globals、合成敏感 env 排除、原请求 FD 关闭、成功退出、取消后实际退出 |
| A/C 新文件定向 `oxfmt --check`、`git diff --check`                                  | 通过                                                                                           |

最终补充：

- `pnpm --dir apps/zcode-cli/packages/node-repl-host test`：**11 文件 / 86 tests 全部通过**，无 unhandled rejection；包含构建后默认 MCP、Browser bridge、真实 cell、完整大响应、退出/取消/超时、后代持有管道、每调用 token 与 owned/borrowed 清理。worker 自身沙箱因 Unix socket `listen()` 返回 EPERM 未通过的用例已由 controller 在本机完整复跑，不以 worker 环境失败冒充通过。
- controller 定向回归合计 **18 文件 / 215 tests 通过**，另有独立构建后 cell harness 的 6 项断言；不是全仓测试或实机 UI 验收。
- 最终 `pnpm lint`：**303 warnings / 0 errors**；本次修改文件定向 lint 无新增警告。CLI typecheck 在最后源码修改后重跑，仍为 30/30 通过。
- 最终定向 `oxlint --no-ignore`：38 个改动 JS/TS 文件，0 warnings / 0 errors；定向 `oxfmt --check --ignore-path /dev/null`：48 个改动文件通过。最终 CLI lint 14/14 与架构检查 0 violations 均通过。
- controller 中途包测试确实失败过：旧共享 token fixture、未 await 的挂起代码、错误 Browser symbol 与延迟处理 Promise rejection。修正后才登记上述最终通过结果。
- 格式检查曾扩大到整个 node-repl-host，发现四个未修改基线文件有格式问题（`src/result.ts`、`test/bundle-smoke.test.ts`、`test/computer-use-onboarding.test.ts`、`test/mcp-server-process-guards.test.ts`）。这些文件与开工快照逐字一致，保持原样；本轮改动文件单独检查。
- 开工快照中既有文件的差异未超出分配范围；未恢复无关本地改动。

### 未实施及阻断项

1. runtime authority 尚未接入可信 live admission、自动续跑参数、双向控制 sideband 和手机输入 Fenced 投递屏障；纯模块的 revoke 不代表真实原生停止。
2. 子进程候选未成为默认 executor，未证明 OS/调试/原生模块/文件/后代进程隔离；Browser capability 也未升级为完整每调用授权。D06 和 MCU1-23a 未关闭。
3. Helper/Driver、机器锁与 fence、真实 frame/provider 交付链、services/UI/profile 及正式安装包仍待后续阶段。不能从本轮单测推导它们已实现。
4. 当前自签名 profile 的证书身份、Helper 加载/peer 校验、TCC 与覆盖升级尚未验证；Intel/最低 macOS 测试机仍缺失，双架构 packaged 验收未完成。这些缺口按验证项保留，不阻止现有 arm64 主机的开发工作。Developer ID/Apple 公证不再列为当前阻断；功能与原生验收尚未完成，`zcodeCuaPlaceholder: true` 保留。

## 第二轮继续实施（2026-10-26）

用户授权继续规划、DeepSeek 实施与 controller 验收，分工和结果统一登记在 [第二轮计划](computer-use-macos-phase1-round2.md)。本轮基于上述已通过候选补控制 IPC、runtime 生命周期接线与自签名产物诊断；新增工作不能沿用上一轮测试数作为通过证据。
