# 任务级重启 services 侧小切片（restartTask / 收口 restartWorkspaceProcess 死参）

来源：上游 v3.17.1（a60ba6a7）任务菜单「重启任务」能力核验结论为能力缺失（fork 裁决
slice-first）。本 spec 只覆盖 F27 第①步——`packages/services` 侧任务级重启最小切片；
任务菜单、`/reload` 斜杠命令与 Agent 进程恢复确认框属 F27 后续主体，不在本 spec 范围。

## 背景

- 本仓桌面/远控共用 workspace 级共享 Agent 进程（`ZodyAgentProcessManager` 按
  `workspaceKey = workspaceIdentity?.trim() || workspacePath` 唯一管理一个 CLI 进程），
  不存在单任务进程，因此「重启一个任务」在进程维度必然换代整个 workspace 进程。
- 上游 v3.17.1 的「重启任务」走 CLI 侧 `sessionLifecycle.restart`（zcodeAgentService.ts:7173-7182），
  生命周期事实由 CLI 管理；本仓协议层 `zodyProtocolMethods` 无 `session/restart`，
  故本切片在 host services 层组合实现等价语义，后续是否下沉协议层另行裁决。
- 现状 `IZodyTaskService.restartWorkspaceProcess`（zodyTaskService.ts:665-671）声明的
  `resumeTaskId` / `bumpRuntimeEpoch` 参数在 adapter（zodyTaskServiceAdapter.ts:3008-3010）
  被 `normalizeWorkspaceParams` 整体丢弃，属于死参；`ZodyTaskMeta.runtimeEpoch` 字段
  全仓无写入方。重启 + 续接的语义需要一个新的单入口 API 承载，而不是复活死参。

## 接口

```ts
// packages/services/src/session/zodyTaskService.ts
export interface ZodyTaskRestartResult {
  taskId: string;
  /** 进程换代作用的 workspace key（workspaceIdentity?.trim() || workspacePath）。 */
  workspaceKey: string;
  /** 本次重启生效的 provider：params.provider ?? task meta.provider ?? "glm"。 */
  provider: ZodyProvider;
  /** 目标任务恢复来源：session = CLI 持久化会话；legacy = 本地 legacy 快照回退。 */
  resumedFrom: "session" | "legacy";
  /** 兄弟任务续跑语义（显式契约）：不自动恢复，下次访问时按需 cold-resume。 */
  siblingResumePolicy: "cold-resume";
  /** 恢复后回写 task index 的最新 meta，UI 可直接用结果刷新列表，省一次回读。 */
  meta: ZodyTaskMeta;
}

restartTask(params: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZodyProvider;
}): Promise<ZodyTaskRestartResult>;
```

结果类型定义在 `packages/services/src/session/zodyTaskService.ts`（与
`ZodyArchivedTaskDeletionResult` 等服务局部结果类型同位；本切片不动 `@zody/shared`）。

## 语义规则（状态所有者 / 事件顺序）

1. **先验存在，后回收进程**：restartTask 先读 `taskIndexRepo.getTaskMeta`；任务不存在
   （或已软删除）时抛 `code: "ZODY_TASK_NOT_FOUND"` 错误且**不**触发进程换代——未知
   taskId 不应付出整个 workspace 的换代代价。
2. **进程换代**：存在性校验通过后，按 `disposeWorkspace({workspacePath, workspaceIdentity})`
   回收共享进程（`restartGenerationByWorkspaceKey` +1，排队中的 start continuation 一并作废），
   与 `restartWorkspaceProcess` 同一粒度；同 workspace 的其他任务不单独回收。
3. **目标任务 cold-resume**：dispose 完成后立即 `resumeSession(taskId)`（复用
   `resumeSnapshotOrLegacy`，含 legacy 快照回退），触发懒拉起新进程并从持久化会话恢复。
   「cold-resume」= 进程内存态丢失、持久化会话与 task index 保留。恢复成功的判定以
   `session/resume` 返回快照（或 legacy 快照）为准。
4. **兄弟任务语义（F27 验收「重启后任务续跑语义明确」）**：同 workspace 其他任务
   *不自动恢复*；其列表态来自 tasks-index（持久化），流式订阅随进程换代失活，由
   task-index syncer 经 `onAgentRuntimeRestarted` 重订；用户下次访问该任务（打开快照 /
   发送输入）时按需 cold-resume，复用同一新进程。
5. **运行中轮次**：restartTask 不等待 task-ready（区别于关闭空闲 workspace 的回收路径），
   显式中断该 workspace 全部运行中轮次——重启语义本身要求打断卡死轮次。
6. **索引回写**：resume 成功后按快照 `syncTaskIndexMeta` 回写 task index（与
   getTaskSnapshot 一致），结果携带最新 meta；不额外发 `task_meta_changed` 事件，
   列表收敛交给 syncer 的 sessions-index 帧。
7. **失败语义**：进程已回收但 resume 失败时错误向上传播；此时 workspace 处于无进程的
   安全空闲态，下次任意访问会重新拉起，不需要回滚。
8. **幂等 / 并发**：本切片不内置锁或防抖（与 `restartWorkspaceProcess` 对齐，UI 入口
   自防抖，见 useWorkspaceSessionReload 的时间窗防抖）；重复调用 = 再换代一代 + 再
   cold-resume，结果幂等。
9. **收口死参**：`restartWorkspaceProcess` 接口删除 `resumeTaskId` / `bumpRuntimeEpoch`
   （连同 UI 调用点 useWorkspaceSessionReload.ts、SessionPane.tsx 的实参），行为不变——
   这两个参数本就被 adapter 丢弃，从未生效。`bumpRuntimeEpoch` 对应的「runtime 基线
   收敛」机制全仓无写入方，未来若实现应作为独立裁决，不在本切片复活。
10. **provider 参数**：仅作为结果回显与日志归因（`params.provider ?? meta.provider ??
    "glm"`），不参与进程回收——`disposeWorkspace` 只按 workspaceKey 作用。

## 验收场景

1. restartTask 对存在的任务：`disposeWorkspace` 先于 `resumeSession` 被调用（顺序断言），
   返回 `resumedFrom: "session"`、`siblingResumePolicy: "cold-resume"` 与回写后的 meta。
2. restartTask 对未知 taskId：抛 `ZODY_TASK_NOT_FOUND`，且 `disposeWorkspace` /
   `resumeSession` 均不被调用（反例：修改前该接口不存在，调用直接失败）。
3. restartTask 在会话缺失但存在 legacy 快照时回退 `resumedFrom: "legacy"`，不抛错。
4. restartTask 的进程换代按 workspaceKey 作用：同 workspace 多任务共享一次 dispose，
   兄弟任务不触发独立 resume（契约由场景 1 的调用序列断言覆盖）。
5. resume 失败向上传播，进程已回收（disposeWorkspace 已被调用）。
6. `restartWorkspaceProcess` 移除死参后：接口与 UI 调用点不再携带
   `resumeTaskId` / `bumpRuntimeEpoch`；现有 workspace 级重启测试行为不变。
