# R47 精确路由与歧义拒绝：主控验收（W5 review closure）

登记日期：2026-11-05。结论：**accepted=true；审查结论 PASS；最后定向测试 exit 0**。本文只覆盖 R47 的 `remoteSessionId`/task 精确路由与歧义拒绝修复，不构成完整 R47、远端真实链路或发布验收。

## 已实现

候选只改方案锁内文件：

- 2 份 spec 新增 §11 精确路由条款与 Phase 5 引用。
- 6 个生产文件：store 新增 `WorkspaceHookRouteTarget`/`resolve*`/`uniqueBinding`/`matchesRemoteSession`，`upsert` 增加 sessionId + remote 同源守卫；commands 贯穿 route、`expectedSendCommand`、`isInvalid` 与歧义/换代 fail-closed；inline trust 增加 abort 与歧义不可操作；`HooksSection`/`SessionPane`/`PendingBanner` 贯穿 `remoteSessionId`。
- 7 个测试文件，含新增非全 mock 集成测试。锁内允许条件成立：pane tree + resolver + registry 的组合无法在既有单测文件内验证。

`V4InteractionDialogs` 未改（方案锁第 7 条明示可不改；其测试文件在 7 个测试文件范围内）。

git diff 核实：

- `packages/shared` 零改动；`request`/`payload` schema 的 `remoteSessionId` 为既有字段（`workspace-hook-review.ts:38,70,90`）。
- 无后端协议、无 R45 改动（`file-assignments.json` 的 R45 writeSet 与本 diff 不相交）、无用户凭据改动。
- 3 个 node-repl-host 文件属 R20，不在本轮。

## 7 条核心合同逐条核对

1. grant 目标只含 path/identity/双 digest（`workspaceHookReviewCommands.ts:117-125`），`remoteSessionId` 不进入持久 Trust 身份。
2. resolve 按 trim 后 `remoteSessionId` 严格同值 + 唯一解析（store:354-363）；集成测试断言 `calls.old=0`；歧义/失效/旧 effect/stale 均显式拒绝，仅 superseded 被静默（`workspaceHookTrustState.ts:69`）。
3. Settings 不传 taskSessionId；歧义时 `trustActionAvailable=false` 且 grant 不绕过（`useWorkspaceHookInlineTrust.ts:60-70`，测试断言 `grantWithoutSession` 未调用）。
4. 本地无 remote 的单 binding 与双方无 identity 的 path fallback 保持（`matchesWorkspaceBinding` 分支 + 既有测试 137-182 行仍绿）。
5. grant 仅两处：无 binding 的既有 workspace pretrust（service 经 `targetServiceResolution` 绑定所选 remote，`rpcReady=false` 时禁用）与 request 返回既有可降级 reason 且无并发 review；policy/stale/timeout/aborted/invalidated 均不 grant，已有 review 直接 respond、失败不转 grant（测试覆盖）。
6. disconnect/upsert 的 sendCommand identity 守卫保留并加强（store:55-86）；wait 的 `expectedSendCommand` + `isInvalid` 阻止旧 flow 借新通道。
7. 文件集不越界。

## 定向测试通过

- 实施者：`output/zody-rename-r47-routing-fix/logs/targeted-r47-tests-final3.log`，7 文件 62 用例全绿；ui-tsc-noemit 输出为空；oxlint 0 error（3 个警告均为 HEAD 已存在，含 `sessionPaneSource` 在 HEAD 即未使用）。
- 主控复跑：`output/zody-rename-w5-controller/logs/r47-targeted-r1.log`，7 文件 62 passed（start 11:26:49）。本轮未重复运行测试套件。

## 独立验收通过

本轮只读静态审查通过，加上亲自执行的只读 oxfmt 检查：R47 全部代码/测试文件中仅 2 个 HEAD 基线即失败的文件继续失败，无新引入失败文件。

## 尚未验证

- 真实远端真机 A/B 双连接路由与 Runtime registry 端到端。runtime19 报告自述仅本地桌面子集，remote 路由明确排除。
- Windows。
- 全量测试套件。
- 根 `typecheck`/`lint`/`architecture`：审查时点尚无日志（派发合同规定 writers 后串行执行）；收口时主控已补跑并通过，见下。

## 收口根检查（主控执行）

- `pnpm typecheck` exit 0：`output/zody-rename-w5-controller/logs/root-typecheck.log`。
- `pnpm lint` exit 0，303 warnings / 0 errors：`output/zody-rename-w5-controller/logs/root-lint.log`。
- `pnpm architecture:check --changed` exit 0，violations 0 / baseline 0 / new 0：`output/zody-rename-w5-controller/logs/root-architecture.log`。
- 归因：全部通过，无需分诊。

## 阻止发布

无 R47 特有阻断项。基线遗留的 `fmt:check` 红灯（`workspace-hook-trust.md`、`HooksSection.tsx`、`SessionPane.tsx` 于 HEAD 已不合规）是否阻断由主控按基线政策裁决。

## 边界

runtime19 仅证明本地子集；Windows 验证保留阻断；Linux 未执行；旧全量测试未全绿；R48 及之后未开始。
