/**
 * taskRestart — F27 任务重启 UI 侧纯函数（docs/task-restart-and-reload.md，来源 a60ba6a7）。
 * 共享进程架构下「重启一个任务」= workspace 进程换代 + 目标任务 cold-resume；
 * 这里只承载确认框触发判定（兄弟任务 running）与 typed `/reload` 提交截获决策，
 * 重启执行唯一写路径是 services 的 IZodyTaskService.restartTask。
 */

/** typed 提交截获的文本形态：以 `/reload` 开头且后随空白或结尾（含 `/reload foo`）。 */
export const TYPED_RELOAD_TEXT_PATTERN = /^\/reload(?:\s|$)/;

export type TaskRestartSiblingSource = Iterable<{
  taskId: string;
  status?: string;
}>;

/**
 * 确认框触发判定（单一判定，specs/task-restart-service-slice.md 与
 * docs/task-restart-and-reload.md 产品规则 4）：同 workspace 存在 running 兄弟任务
 * 即「资源无法安全释放」，重启前必须确认；目标任务自身的运行轮次不算——中断它正是
 * 重启的目的。只读 tasks-index 投影事实，不拉起进程、不新增服务接口。
 */
export function hasRunningSiblingTasks(params: {
  /** 同 workspace 的任务投影（taskId + status）。 */
  tasks: TaskRestartSiblingSource;
  /** 被重启的目标 taskId。 */
  taskId: string;
}): boolean {
  for (const task of params.tasks) {
    if (task.taskId === params.taskId) {
      continue;
    }
    if (task.status === "running") {
      return true;
    }
  }
  return false;
}

export type TypedReloadSubmissionDecision =
  /** 不是 /reload 文本：按普通发送路径继续。 */
  | { kind: "not-reload" }
  /** 恰好 `/reload` 且门禁满足：本地执行，之后清空输入。 */
  | { kind: "execute" }
  /** `/reload xxx`（带参数）或门禁不满足：静默丢弃本次提交，绝不发送给模型。 */
  | { kind: "drop" };

/**
 * typed `/reload` 提交截获决策（F27 验收「/reload 不出现在模型输入」）。
 * 上游语义（a60ba6a7 ConversationComposer）：`/reload` 是本地操作，在模型配置、队列
 * 和消息历史处理之前截获；参数和附件不发给模型——因此 drop 分支同样不能落入普通发送。
 */
export function resolveTypedReloadSubmission(params: {
  /** 提交文本（已 trim）。 */
  text: string;
  /** App 层 recovery reload 命令是否存在（不存在时无本地执行能力）。 */
  hasReloadCommand: boolean;
  /** composer 忙碌中（pending）。 */
  busy?: boolean;
  /** 是否携带附件或任何引用上下文（附件/引用存在时不作为 reload 提交）。 */
  hasAttachmentsOrContexts?: boolean;
}): TypedReloadSubmissionDecision {
  if (!TYPED_RELOAD_TEXT_PATTERN.test(params.text)) {
    return { kind: "not-reload" };
  }
  if (
    params.text !== "/reload" ||
    !params.hasReloadCommand ||
    params.busy ||
    params.hasAttachmentsOrContexts
  ) {
    // `/reload foo`、无本地命令、pending 或带附件：全部静默丢弃，不执行也不发送。
    return { kind: "drop" };
  }
  return { kind: "execute" };
}

/**
 * 从 App 层命令中解析 recovery reload 命令（提交截获的执行体）。
 * 单独成函数便于 composer 与测试复用同一选择规则。
 */
export function findRecoveryReloadCommand<
  T extends { recovery?: boolean; value: string; run: () => unknown },
>(appCommands: readonly T[] | undefined): T | undefined {
  return appCommands?.find((command) => command.recovery === true && command.value === "reload");
}
