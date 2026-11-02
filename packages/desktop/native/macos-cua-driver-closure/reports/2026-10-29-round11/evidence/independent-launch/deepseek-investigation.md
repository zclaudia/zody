**结论**
- identity 注入与 CommandInbox ticket 已存在，不是当前缺口。真正的缺口是：runtime 的 `CuaSubmissionCoordinator` 持有唯一 `CuaSubmissionAuthority`，却从未调用 `bindTurn`，也没有向可信 consumer 暴露绑定端口；`CuaSubmissionAuthority.bindTurn` 已实现，但只在 R11 自建 authority 内被调用。
- 证据：coordinator 明确“不调用 bindTurn”（`apps/zcode-cli/packages/core/src/runtime/cua/cua-submission-coordinator.ts:53`），实际只创建 authority（同文件 `:88`）并暴露 `producerPort()`（`:292`）；bindTurn 在 `cua-submission-authority.ts:134`。
- R11 当前不是生产接线：`authority-entry.mjs:179` 自行 `new CuaSubmissionAuthority`，`authority-entry.mjs:195` 自行 admit、`:206` 自行 bind；supervisor 还自行生成 app/host/runtime/session/source/turn 身份，见 `src/orchestrator.mm:350`。这些 ref 与运行中的 Desktop/CommandInbox authority 没有关系。
- 把任意 Node FD/socket 交给该 self-authority 不能解决：这只改变传输，不证明对端是产品 runtime；反而会形成第二个 authority。当前开发 Zody/Agent 没有固定签名身份，不能据此宣称 product-sealed producer。

**直接可实施：复用唯一 owner 的 TS 接线**
1. 在 `apps/zcode-cli/packages/core/src/runtime/cua/cua-submission-coordinator-contract.ts` 增加仅内部可信路径可用的 `CuaSubmissionTurnBindingPort`：
```ts
interface CuaSubmissionTurnBindingPort {
  bindCurrentTurn(input: {
    producerIncarnation: string;
    runId: string;
    turnId: string;
  }): CuaSubmissionBindTurnResult;
  endCurrentTurn(input: { runId: string; turnId: string }): CuaSubmissionEndTurnResult;
}
```
2. 在 `cua-submission-coordinator.ts` 实现该 port，直接调用同一个 `#authority`，只取 `#current.ref`，不新建 authority、不生成 lineage/身份。语义是“给当前 candidate 绑定 producer/turn”，不是授权新 candidate。
3. 在 `apps/zcode-cli/packages/core/src/runtime/methods/cua-submission.ts` 增加受信 getter，或在适配层通过 runtime deps 注入该 port；不要暴露给模型工具、cell 或公开协议。
4. 在 `apps/zcode-cli/packages/adapters/src/mcp/cua-submission-control-contract.ts:64` 的 session options 增加 `turnBindingPort` 和 runtime 提供的 `runId/turnId`。`cua-submission-control.ts:137` 在启动 control consumer 前绑定；`:357` cleanup 时 `endCurrentTurn`，绑定失败则不得启动。
5. `producerIncarnation` 目前由 `control-only-ready.ts:87` 随机生成，可由 session 生成后同时用于 bind 和 control bootstrap；不得让 native 自造另一个 incarnation。
6. `runId` 来源需要 controller 在 spec 中定死。现有 `prompt-admission.ts:105` 生成 `turnId` 并消费 ticket，`config.ts:125` 只暴露 `turnId`，没有 runtime-owned `runId`；不要在 adapter/native 临时伪造。

事件顺序应为：
```text
CommandInbox live ticket
  -> coordinator.onTurnStarting -> 唯一 authority.admitLive
  -> turnBindingPort.bindCurrentTurn(producer/run/turn)
  -> adapter control session 仅拿到 ref + producerPort
  -> producer revoke/resolve 回到同一 authority
  -> cleanup endCurrentTurn / revoke
```

必要测试：
- `apps/zcode-cli/packages/core/tests/cua-submission-runtime.test.ts`：真实 runtime admission 后 current ref 可 bind 一次；重复 bind 幂等；撤销后拒绝；cleanup endTurn。
- `apps/zcode-cli/packages/adapters/tests/cua-submission-control.test.ts`：bind 失败不启动 consumer；启动失败/断连执行 endTurn/revoke。
- `apps/zcode-cli/packages/core/tests/cua-submission-control-binding.test.ts`：现有真实 authority + official control-only entry 组合（当前在 `:83` 自建测试 authority）改为从 runtime 获取 owner port，断言没有第二个 authority。
- 该路径不需要签名、TCC 或原生截图，可独立验证“唯一 owner + bind + revoke”。

**必须产品 sealed producer/签名才能成立**
- R11 的 `authority-entry.mjs:179` 必须删除 authority 实例化，改成只消费 controller 提供的完整 ref/turn binding；`orchestrator.mm:350` 的随机 app/host/runtime/session 不得进入生产路径。Helper 可继续独占机器 lease 与 capture，见 `orchestrator.mm:637` 和 `:665`，但不能拥有提交授权。
- runtime 到 native Helper 的可信边界目前不存在：Helper 的 peer 校验期望同签名 supervisor/Helper（`orchestrator.mm:428`），不是运行中的 Desktop/Agent；控制协议只支持 `revoke_submission/stop`（`packages/zcode-cua/control-protocol-schema.js:50`）。若 Helper 保留开始前 `check`，还必须增加只读的 authenticated `resolve/status` 操作，不能凭本地缓存宣称 owner 仍是 candidate。
- 可行的最小产品形态是：签名 supervisor 由产品 Host 启动，把控制 FD 交给已 pin 的 Node producer bridge；bridge 只实现 control-channel producer，runtime 仍是唯一 controller/authority owner。必须固定校验 supervisor、Node、bridge 的签名/DR/hash，并且 controller 身份必须由产品启动链或固定签名证明。仅凭“同用户可继承 FD”或开发 Agent 提供的 FD 不够。
- 该要求不是 TCC 问题。当前 LaunchServices 显示 subject/responsible 为 Helper 是权限归属证据，但截图 blocked 不能证明 owner 接线，也不能替代 sealed boundary。
- `packages/zcode-cua/broker-server.js:100` 在当前检出仍是 unavailable 占位，实际 macOS product Helper transport 尚不存在；`packages/services/src/node.ts:850` 即使调用也拿不到可运行产品 Host。

**真实运行门槛**
- 先完成并跑 targeted tests、`pnpm typecheck`、`pnpm lint`。
- 原生正向验收必须由真实 Desktop Host/CommandInbox 产生 submission，使用真实 `hostId/runtimeInstanceId`（Host 注入见 `packages/desktop/src/host/index.ts:2609`，Agent 启动握手见 `zcodeAgentProcessManager.ts:1414`），绑定到已签名 Helper，完成一次截图、authority revoke、资源与机器 lease 释放。
- 验收时必须核验：只有一个 authority 实例；ref 的 host/runtime/session/workspace 与运行中 runtime 一致；Helper 没有自行 admit/bind；撤销先于资源归还完成。child exit0 或 TCC subject 正确都不足以代替这些事实。
