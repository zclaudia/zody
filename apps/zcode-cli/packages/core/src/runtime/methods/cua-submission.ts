import type {
  CuaSubmissionProducerPort,
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionTurnInvalidationReason,
  CuaSubmissionTurnScope,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  PermissionRuleset,
  PermissionUpdate,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import type { CuaLiveSubmissionRegistrar } from "../cua/cua-submission-coordinator.js";
import { sameIdentity } from "../cua/cua-submission-helpers.js";
import { RuntimeCuaSubmissionTurnScope } from "../cua/cua-submission-turn-scope.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveForegroundExecutionState, ActiveTurnSteeringState } from "../types.js";
import { applyPermissionUpdates } from "../../tool/executor/permission-rules.js";

const UNKNOWN_CUA_SUBMISSION_PROJECTION: CuaSubmissionProjection = Object.freeze({
  status: "unknown",
  nativeFence: "unknown",
  mobileDelivery: "unknown",
});

/** 可信 runtime 边界读取；没有 coordinator 时保持 unknown，不创建任何候选。 */
export function getCuaSubmissionProjection(this: AgentRuntimeInternal): CuaSubmissionProjection {
  return this.cuaSubmissionCoordinator?.currentProjection() ?? UNKNOWN_CUA_SUBMISSION_PROJECTION;
}

export function getCuaSubmissionRegistrar(
  this: AgentRuntimeInternal,
): CuaLiveSubmissionRegistrar | undefined {
  return this.cuaSubmissionCoordinator?.registrar;
}

export function getCuaSubmissionProducerPort(
  this: AgentRuntimeInternal,
): CuaSubmissionProducerPort | undefined {
  return this.cuaSubmissionCoordinator?.producerPort();
}

export function getCurrentCuaSubmissionRef(
  this: AgentRuntimeInternal,
): CuaSubmissionRef | undefined {
  return this.cuaSubmissionCoordinator?.currentRef();
}

/**
 * 生产 runtime 的同一 owner turn scope。仅真实 regular activeTurn + 未取消 foreground
 * execution + 当前 candidate 时签发；身份全部由 runtime 捕获，调用方不能传入或覆盖。
 */
export function createCuaSubmissionTurnScope(
  this: AgentRuntimeInternal,
): CuaSubmissionTurnScope | undefined {
  const coordinator = this.cuaSubmissionCoordinator;
  if (!coordinator || this.config.parentSessionId !== undefined || this.shuttingDown) {
    return undefined;
  }
  const activeTurn = this.activeTurn;
  if (!activeTurn || activeTurn.kind !== "regular") return undefined;
  const foreground = this.activeForegroundExecution;
  if (!foreground || foreground.controller.signal.aborted) return undefined;
  const candidate = coordinator.currentProjection();
  if (candidate.status !== "candidate") return undefined;

  const scopes = (this.cuaSubmissionTurnScopesByTurn ??= new WeakMap());
  const existing = scopes.get(activeTurn);
  if (existing) {
    // 单一 turn 至多一个 handle；已关闭的 handle 不能借重复调用复活旧 turn。
    return existing.invalidated ? undefined : existing;
  }

  const scope = new RuntimeCuaSubmissionTurnScope({
    ref: candidate.ref,
    traceId: activeTurn.traceContext.traceId,
    runId: foreground.foregroundExecutionId,
    turnId: activeTurn.turnId,
    producerPort: coordinator.producerPort(),
    bindTurn: (request) => coordinator.bindTurn(request),
    endTurn: (request) => coordinator.endTurn(request),
    isBindingCurrent: () =>
      this.activeTurn === activeTurn &&
      this.activeForegroundExecution === foreground &&
      !foreground.controller.signal.aborted &&
      coordinator.isCurrentCandidateRef(candidate.ref),
  });
  scopes.set(activeTurn, scope);
  this.cuaSubmissionTurnScope = scope;

  const unsubscribe = coordinator.subscribeRevocation((projection) => {
    // 只有同一 lineage 的 owner 撤销才失效本 scope；别的会话/lineage 不得误伤。
    if (sameIdentity(projection.ref, candidate.ref)) scope.invalidate("owner-revoked");
  });
  // foreground 的 parent AbortSignal 可能先于 held model/turn 生命周期结束；必须直接订阅
  // 真实 controller signal，abort 时同步失效，不能等 finishForegroundExecution 兜底。
  const onForegroundAbort = (): void => scope.invalidate("scope-closed");
  foreground.controller.signal.addEventListener("abort", onForegroundAbort, { once: true });
  scope.onInvalidated(() => {
    foreground.controller.signal.removeEventListener("abort", onForegroundAbort);
    unsubscribe();
    if (this.cuaSubmissionTurnScope === scope) this.cuaSubmissionTurnScope = undefined;
  });
  return scope;
}

/** 真实 turn 结束时同步失效；正常结束只释放 binding，不撤销仍有效的 lineage。 */
export function invalidateCuaSubmissionTurnScopeForTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
  reason: CuaSubmissionTurnInvalidationReason,
): void {
  this.cuaSubmissionTurnScopesByTurn?.get(activeTurn)?.invalidate(reason);
}

/** foreground execution 结束/取消时兜底失效；runId 对不上时不得影响其它 handle。 */
export function invalidateCuaSubmissionTurnScopeForForeground(
  this: AgentRuntimeInternal,
  state: ActiveForegroundExecutionState,
  reason: CuaSubmissionTurnInvalidationReason,
): void {
  const scope = this.cuaSubmissionTurnScope;
  if (scope?.runId !== state.foregroundExecutionId) return;
  scope.invalidate(reason);
}

/** shutdown 是不可恢复的 owner 撤销，不能走 normal close 语义。 */
export function invalidateCuaSubmissionTurnScopeOnDispose(this: AgentRuntimeInternal): void {
  this.cuaSubmissionTurnScope?.invalidate("owner-revoked");
}

/** App 内确认弹窗（替代 Helper 原生 NSAlert）的请求输入；身份来自 capture scope 的原值。 */
export interface CuaNativeCaptureConfirmationInput {
  readonly generation: number;
  readonly target: {
    readonly pid: number;
    readonly windowId: number;
    readonly ownerName: string;
    readonly windowName: string;
  };
  /** 与 CuaSubmissionRef.sessionId 同型（plain string）；构造 broker 请求时再收敛 branded 形状。 */
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly traceId: TraceId;
  readonly runId: string;
  readonly turnId: TurnId;
  readonly signal?: AbortSignal;
}

export interface CuaNativeCaptureConfirmationResult {
  readonly allowed: boolean;
  readonly failureReason?: "confirmation-invalid" | "confirmation-unavailable";
}

/** reason 摘要上界：ownerName/windowName 各 ≤128 时模板最长约 350，再统一截断防御未来放宽。 */
const CUA_CONFIRM_REASON_MAX_CHARS = 512;
/** UI 按固定 toolName 识别截图确认弹窗（目标身份映射）；不得随调用方变化。 */
const CUA_SCREENSHOT_CONFIRM_TOOL_NAME = "cua_screenshot_confirm";

/**
 * App 内确认弹窗替代 Helper 原生 NSAlert（spec 2026-10-31）：截图授权仍逐次确认，
 * 呈现位置改为 App UI 既有 PermissionDialog。确认只能落在发起截图的同一 live turn/
 * foreground execution 上（与 createCuaSubmissionTurnScope 同源的校验），迟到或换绑
 * 的 confirm 一律 fail-closed，不发起用户请求。
 *
 * 2026-10-31 用户修订：确认不再限定「恰两动作、不记住」，而是遵循既有工具权限策略
 * （允许一次 / 总是允许（项目规则）/ Full access / 拒绝）。发起交互前先查既有
 * permission 规则（与工具执行前审批同一 PermissionService 实例），命中 allow 即免交互；
 * 规则查询异常按未命中处理，仍走用户交互。
 */
export async function requestCuaNativeCaptureConfirmation(
  this: AgentRuntimeInternal,
  input: CuaNativeCaptureConfirmationInput,
): Promise<CuaNativeCaptureConfirmationResult> {
  const activeTurn = this.activeTurn;
  const foreground = this.activeForegroundExecution;
  if (
    !activeTurn ||
    activeTurn.kind !== "regular" ||
    activeTurn.turnId !== input.turnId ||
    activeTurn.traceContext.traceId !== input.traceId ||
    String(this.sessionId) !== input.sessionId ||
    !foreground ||
    foreground.foregroundExecutionId !== input.runId ||
    foreground.controller.signal.aborted
  ) {
    return { allowed: false, failureReason: "confirmation-invalid" };
  }
  if (await isCuaConfirmAllowedByPermissionPolicy(this, input.target)) {
    return { allowed: true };
  }
  try {
    // Full access 选项走既有 broker 应答链。claimResponse 与普通工具审批同义：
    // 同一请求只允许一个带副作用的应答胜出。
    let responseClaimed = false;
    const claimResponse = (): boolean => {
      if (responseClaimed) return false;
      responseClaimed = true;
      return true;
    };
    const result = await this.permissionBroker.requestPermission(
      {
        input: { target: buildCuaConfirmTarget(input.target) },
        // mode 取当前会话协作模式：确认请求与普通工具走同一 broker 语义（guarded 的
        // 协议错误翻译等）。
        mode: this.config.mode ?? "build",
        reason: buildCuaConfirmReason(input.target),
        requestId: `cua-confirm-${input.generation}`,
        requestedAt: new Date(),
        riskLevel: "high",
        // 合成请求不属于任何持久规则；ruleId 仅满足请求形状，不参与规则匹配。
        ruleId: "cua-confirm",
        sessionId: input.sessionId as PermissionBrokerRequest["sessionId"],
        // 项目级「总是允许」规则：复用既有 permission 应答链落盘，不另建规则存储。
        suggestedPermissionUpdates: buildCuaConfirmSuggestedPermissionUpdates(),
        toolCallId: input.runId as PermissionBrokerRequest["toolCallId"],
        toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
        traceId: input.traceId,
        turnId: input.turnId,
      },
      // 不传 timeoutMs：用户对截图确认没有固定等待上限，由外层工具超时/Stop 收口。
      { ...(input.signal ? { signal: input.signal } : {}), claimResponse },
    );
    // 只认 allow；deny 与 modify（本请求没有可修改的工具输入）都按用户拒绝处理。
    if (result.decision !== "allow") return { allowed: false };
    const applied = await applyCuaConfirmPermissionUpdates(this, result);
    return applied
      ? { allowed: true }
      : { allowed: false, failureReason: "confirmation-unavailable" };
  } catch (error) {
    if (input.signal?.aborted) {
      // Stop/取消路径：abort 必须原样上抛，由 capture 侧 catch 归入「不写响应」收口。
      throw error instanceof Error && error.name === "AbortError"
        ? error
        : new DOMException("The CUA capture confirmation was aborted", "AbortError");
    }
    return { allowed: false, failureReason: "confirmation-unavailable" };
  }
}

/**
 * 既有 permission 规则判定：与工具执行前审批共用 PermissionService 实例与项目规则来源。
 * 只读取项目/会话规则集（会话 full access 已折叠为 runtime 的 yolo/guarded 模式），
 * 任一读取失败都按「未命中」处理，让 confirm 继续走用户交互而不是误放行。
 */
async function isCuaConfirmAllowedByPermissionPolicy(
  runtime: AgentRuntimeInternal,
  target: CuaNativeCaptureConfirmationInput["target"],
): Promise<boolean> {
  try {
    let projectRules: PermissionRuleset | null = null;
    const store = runtime.sessionStore;
    if (store) {
      const session = await store.getSession(runtime.sessionId);
      if (session?.permission?.scope === "session") {
        projectRules = session.permission;
      } else if (session?.projectID) {
        projectRules = await store.getProjectPermission(session.projectID);
      }
    }
    const decision = runtime.permissionService.checkPermission(
      {
        input: { target: buildCuaConfirmTarget(target) },
        mode: runtime.getMode(),
        planEnabled: runtime.getPlanEnabled(),
        riskLevel: "high",
        toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
      },
      undefined,
      projectRules,
    );
    return decision.decision === "allow";
  } catch {
    return false;
  }
}

/**
 * 用户允许后落定应答携带的权限更新：项目规则写入既有 sessionStore（与工具执行的
 * applyGrantedPermissionUpdates 同一落点），会话规则只进 PermissionService 内存。
 * 写盘失败视为本次确认不可用（fail-closed），不宣称「已记住」。
 */
async function applyCuaConfirmPermissionUpdates(
  runtime: AgentRuntimeInternal,
  result: PermissionBrokerResult,
): Promise<boolean> {
  if (result.sessionPermissionUpdates?.length) {
    runtime.permissionService.grantSessionPermission(result.sessionPermissionUpdates);
  }
  if (!result.permissionUpdates?.length) return true;
  const store = runtime.sessionStore;
  if (!store) {
    runtime.logger?.warn("CUA confirm project permission update skipped without session store", {
      event: "tool.permission.project_update.skipped",
      module: "core.runtime.cua",
      status: "completed",
      toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
    });
    return true;
  }
  try {
    const session = await store.getSession(runtime.sessionId);
    if (session?.permission?.scope === "session") {
      await store.updateSession({
        id: runtime.sessionId,
        permission: applyPermissionUpdates(session.permission, result.permissionUpdates),
      });
      return true;
    }
    const projectID = session?.projectID;
    if (!projectID) {
      runtime.logger?.warn("CUA confirm project permission update skipped without project", {
        event: "tool.permission.project_update.skipped",
        module: "core.runtime.cua",
        status: "completed",
        toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
      });
      return true;
    }
    const current = (await store.getProjectPermission(projectID)) ?? { version: 1 };
    await store.saveProjectPermission({
      projectID,
      permission: applyPermissionUpdates(current, result.permissionUpdates),
    });
    runtime.logger?.info("CUA confirm project permission updated", {
      event: "tool.permission.project_update.saved",
      module: "core.runtime.cua",
      status: "completed",
      toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
      updateCount: result.permissionUpdates.length,
    });
    return true;
  } catch (error) {
    runtime.logger?.error(
      "Failed to persist CUA confirm project permission update",
      error instanceof Error ? error : new Error(String(error)),
      {
        event: "tool.permission.project_update.failed",
        module: "core.runtime.cua",
        status: "failed",
        toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME,
      },
    );
    return false;
  }
}

function buildCuaConfirmSuggestedPermissionUpdates(): PermissionUpdate[] {
  return [
    {
      behavior: "allow",
      rules: [{ toolName: CUA_SCREENSHOT_CONFIRM_TOOL_NAME }],
      type: "addRules",
    },
  ];
}

function buildCuaConfirmTarget(
  target: CuaNativeCaptureConfirmationInput["target"],
): Record<string, number | string> {
  return {
    pid: target.pid,
    windowId: target.windowId,
    ownerName: target.ownerName,
    windowName: target.windowName,
  };
}

function buildCuaConfirmReason(target: CuaNativeCaptureConfirmationInput["target"]): string {
  const reason = `Screen capture target: ${target.ownerName} — "${target.windowName}" (pid ${target.pid}, window ${target.windowId})`;
  return reason.length > CUA_CONFIRM_REASON_MAX_CHARS
    ? reason.slice(0, CUA_CONFIRM_REASON_MAX_CHARS)
    : reason;
}
