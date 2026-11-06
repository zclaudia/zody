import { create } from "zustand";
import type {
  CommandAck,
  CommandEnvelope,
  WorkspaceHookReviewRequestPayload,
} from "@zody/shared/zody-protocol-v4";
// review 单调性裁决单一来源；store 的应用策略是 cross_flow 接受新 Runtime 权威
// （renderer 服从 canonical snapshot 的最新投递）。
import { verdictWorkspaceHookReviewRequest } from "@zody/shared/workspace-hook-review-monotonicity";

export interface WorkspaceHookCommandBinding {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

export interface WorkspaceHookReviewBinding {
  request: WorkspaceHookReviewRequestPayload;
  workspacePath: string;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  onCommandSettled?: (commandId: string) => void;
}

export interface WorkspaceHookRouteTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskSessionId?: string;
}

export type WorkspaceHookBindingResolution<T> =
  | { status: "matched"; binding: T }
  | { status: "missing" }
  | { status: "ambiguous" };

interface WorkspaceHookReviewState {
  bindings: Record<string, WorkspaceHookReviewBinding>;
  commandBindings: Record<string, WorkspaceHookCommandBinding>;
  connect(sessionId: string, binding: WorkspaceHookCommandBinding): void;
  disconnect(sessionId: string, sendCommand: WorkspaceHookCommandBinding["sendCommand"]): void;
  upsert(sessionId: string, binding: WorkspaceHookReviewBinding): void;
  clear(sessionId: string, interactionId?: string): void;
}

export const useWorkspaceHookReviewStore = create<WorkspaceHookReviewState>((set) => ({
  bindings: {},
  commandBindings: {},
  connect: (sessionId, binding) =>
    set((state) => ({
      commandBindings: { ...state.commandBindings, [sessionId]: binding },
    })),
  disconnect: (sessionId, sendCommand) =>
    set((state) => {
      const current = state.commandBindings[sessionId];
      if (!current || current.sendCommand !== sendCommand) return state;
      const commandBindings = { ...state.commandBindings };
      delete commandBindings[sessionId];
      const review = state.bindings[sessionId];
      if (!review || review.sendCommand !== sendCommand) return { commandBindings };
      // command channel 已断开后不能继续保留同一连接的 review binding；否则 Settings
      // 会拿到 disposed client。sendCommand identity guard 可避免旧连接 cleanup 清掉新连接。
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings, commandBindings };
    }),
  upsert: (sessionId, binding) =>
    set((state) => {
      const commandBinding = state.commandBindings[sessionId];
      if (commandBinding && commandBinding.sendCommand !== binding.sendCommand) {
        // renderer 重连时旧 effect 可能迟到；只有当前 session command channel 才能刷新
        // review binding，避免 equal-generation replay 把新 client 换回 disposed client。
        return state;
      }
      // R47：review 必须来自它所属 session 的命令通道，并携带与通道相同的 remote 路由。
      // 旧 effect 若残留另一 remote 的 payload，不能污染当前 session 的 review binding。
      if (binding.request.sessionId !== sessionId) return state;
      if (
        commandBinding &&
        normalizeRemoteSessionId(commandBinding.remoteSessionId) !==
          normalizeRemoteSessionId(binding.request.remoteSessionId)
      ) {
        return state;
      }
      const current = state.bindings[sessionId];
      if (current) {
        const verdict = verdictWorkspaceHookReviewRequest(current.request, binding.request);
        // generation 只在一个 Runtime flow 内可比较。新 Runtime 会生成新
        // reviewFlowId 并从 1 重计；跨 flow（cross_flow）必须服从 canonical snapshot 的
        // 最新投递，否则旧 Runtime 的高 generation 会永久挡住新权威请求。同 flow 则严格
        // 要求 generation 单调，replay/conflict/stale 不得覆盖当前 binding。
        if (
          verdict === "same_flow_stale" ||
          verdict === "same_flow_replay" ||
          verdict === "same_flow_conflict"
        ) {
          return state;
        }
      }
      return { bindings: { ...state.bindings, [sessionId]: binding } };
    }),
  clear: (sessionId, interactionId) =>
    set((state) => {
      const current = state.bindings[sessionId];
      if (!current || (interactionId && current.request.interactionId !== interactionId)) {
        return state;
      }
      const bindings = { ...state.bindings };
      delete bindings[sessionId];
      return { bindings };
    }),
}));

export function findWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
  route: Pick<WorkspaceHookRouteTarget, "remoteSessionId" | "taskSessionId"> = {},
): WorkspaceHookReviewBinding | undefined {
  const resolution = resolveWorkspaceHookReviewBinding(bindings, {
    workspacePath,
    workspaceIdentity,
    ...route,
  });
  return resolution.status === "matched" ? resolution.binding : undefined;
}

const TRUSTABLE_WORKSPACE_HOOK_STATES = new Set(["pending_trust", "revoked", "stale_digest"]);

/**
 * 查找能授权指定静态 Settings 行的精确 immutable review binding。
 *
 * Settings 的 trustState 只负责展示，绝不能直接成为 mutation authority；真正提交前必须
 * 同时匹配 workspace、bundle 和 opaque reviewItemId，避免等待期间跨 generation/bundle
 * 误用另一条 request。
 */
export function findWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    taskSessionId?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookReviewBinding | undefined {
  const resolution = resolveWorkspaceHookReviewBindingForItem(bindings, input);
  return resolution.status === "matched" ? resolution.binding : undefined;
}

export function resolveWorkspaceHookReviewBinding(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  target: WorkspaceHookRouteTarget,
): WorkspaceHookBindingResolution<WorkspaceHookReviewBinding> {
  return uniqueBinding(
    Object.values(bindings).filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          bindingRemoteSessionId: binding.request.remoteSessionId,
          workspaceIdentity: target.workspaceIdentity,
          workspacePath: target.workspacePath,
          remoteSessionId: target.remoteSessionId,
        }) && matchesTaskSession(binding.request.sessionId, target.taskSessionId),
    ),
  );
}

export function resolveWorkspaceHookReviewBindingForItem(
  bindings: Record<string, WorkspaceHookReviewBinding>,
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    taskSessionId?: string;
    bundleDigest: string;
    reviewItemId: string;
  },
): WorkspaceHookBindingResolution<WorkspaceHookReviewBinding> {
  return uniqueBinding(
    Object.values(bindings).filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.request.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          bindingRemoteSessionId: binding.request.remoteSessionId,
          workspaceIdentity: input.workspaceIdentity,
          workspacePath: input.workspacePath,
          remoteSessionId: input.remoteSessionId,
        }) &&
        matchesTaskSession(binding.request.sessionId, input.taskSessionId) &&
        binding.request.bundleDigest === input.bundleDigest &&
        binding.request.items.some(
          (item) =>
            item.reviewItemId === input.reviewItemId &&
            TRUSTABLE_WORKSPACE_HOOK_STATES.has(item.trustState),
        ),
    ),
  );
}

export type WorkspaceHookReviewWaitResult =
  | { status: "matched"; binding: WorkspaceHookReviewBinding }
  | { status: "timeout" | "aborted" | "invalidated" | "ambiguous" };

export function waitForWorkspaceHookReviewBindingForItem(
  input: {
    workspacePath?: string | null;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    taskSessionId?: string;
    bundleDigest: string;
    reviewItemId: string;
    expectedSendCommand?: WorkspaceHookReviewBinding["sendCommand"];
    signal?: AbortSignal;
    isInvalid?: () => boolean;
  },
  timeoutMs: number,
): Promise<WorkspaceHookReviewWaitResult> {
  const readCurrent = (): WorkspaceHookReviewWaitResult | { status: "missing" } => {
    const resolution = resolveWorkspaceHookReviewBindingForItem(
      useWorkspaceHookReviewStore.getState().bindings,
      input,
    );
    if (resolution.status !== "matched") return { status: resolution.status };
    if (input.expectedSendCommand && resolution.binding.sendCommand !== input.expectedSendCommand) {
      return { status: "missing" };
    }
    return resolution;
  };

  if (input.signal?.aborted) return Promise.resolve({ status: "aborted" });
  if (input.isInvalid?.()) return Promise.resolve({ status: "invalidated" });
  const current = readCurrent();
  if (current.status !== "missing") return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const onAbort = () => finish({ status: "aborted" });
    const timer = globalThis.setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    const finish = (result: WorkspaceHookReviewWaitResult) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      input.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    unsubscribe = useWorkspaceHookReviewStore.subscribe((state) => {
      if (input.isInvalid?.()) {
        finish({ status: "invalidated" });
        return;
      }
      const resolution = resolveWorkspaceHookReviewBindingForItem(state.bindings, input);
      if (resolution.status === "ambiguous") {
        finish({ status: "ambiguous" });
        return;
      }
      if (resolution.status !== "matched") return;
      if (
        input.expectedSendCommand &&
        resolution.binding.sendCommand !== input.expectedSendCommand
      ) {
        return;
      }
      finish(resolution);
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });

    // subscribe 与首次读取之间仍可能发生一次同步 upsert；订阅完成后再检查一次收口竞态。
    const afterSubscribe = readCurrent();
    if (afterSubscribe.status !== "missing") finish(afterSubscribe);
  });
}

export function findWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  workspacePath?: string | null,
  workspaceIdentity?: string,
  route: Pick<WorkspaceHookRouteTarget, "remoteSessionId" | "taskSessionId"> = {},
): WorkspaceHookCommandBinding | undefined {
  const resolution = resolveWorkspaceHookCommandBinding(bindings, {
    workspacePath,
    workspaceIdentity,
    ...route,
  });
  return resolution.status === "matched" ? resolution.binding : undefined;
}

export function resolveWorkspaceHookCommandBinding(
  bindings: Record<string, WorkspaceHookCommandBinding>,
  target: WorkspaceHookRouteTarget,
): WorkspaceHookBindingResolution<WorkspaceHookCommandBinding> {
  return uniqueBinding(
    Object.values(bindings).filter(
      (binding) =>
        matchesWorkspaceBinding({
          bindingWorkspaceIdentity: binding.workspaceIdentity,
          bindingWorkspacePath: binding.workspacePath,
          bindingRemoteSessionId: binding.remoteSessionId,
          workspaceIdentity: target.workspaceIdentity,
          workspacePath: target.workspacePath,
          remoteSessionId: target.remoteSessionId,
        }) && matchesTaskSession(binding.sessionId, target.taskSessionId),
    ),
  );
}

function uniqueBinding<T>(bindings: T[]): WorkspaceHookBindingResolution<T> {
  if (bindings.length === 1) return { status: "matched", binding: bindings[0]! };
  return { status: bindings.length === 0 ? "missing" : "ambiguous" };
}

function matchesTaskSession(bindingSessionId: string, taskSessionId?: string): boolean {
  const task = taskSessionId?.trim();
  return !task || bindingSessionId === task;
}

function normalizeRemoteSessionId(value?: string): string | undefined {
  return value?.trim() || undefined;
}

function matchesWorkspaceBinding(input: {
  bindingWorkspaceIdentity?: string;
  bindingWorkspacePath: string;
  bindingRemoteSessionId?: string;
  workspaceIdentity?: string;
  workspacePath?: string | null;
  remoteSessionId?: string;
}): boolean {
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceKey) return false;
  const bindingWorkspaceIdentity = input.bindingWorkspaceIdentity?.trim();
  if (bindingWorkspaceIdentity) {
    // identity 命中或 path 命中的 OR 判定不够：同一路径的远程 tab 因 path
    // 相等会被本地 Settings 选成信任提交通道，形成跨 workspace 误授权。
    // 修法：binding 一旦带 identity 就只能严格匹配 workspaceKey；只有自身无
    // identity 的旧本地 binding 才允许按 path fallback。
    if (bindingWorkspaceIdentity !== workspaceKey) return false;
    return matchesRemoteSession(input.bindingRemoteSessionId, input.remoteSessionId);
  }
  // 当前查询本身携带 identity 时同样禁止降级到 path；否则未知远程 identity 会误选
  // 一个无 identity 的本地旧 binding。
  if (input.workspaceIdentity?.trim()) return false;
  if (input.bindingWorkspacePath !== input.workspacePath) return false;
  return matchesRemoteSession(input.bindingRemoteSessionId, input.remoteSessionId);
}

function matchesRemoteSession(
  bindingRemoteSessionId?: string,
  targetRemoteSessionId?: string,
): boolean {
  const bindingRemote = normalizeRemoteSessionId(bindingRemoteSessionId);
  const targetRemote = normalizeRemoteSessionId(targetRemoteSessionId);
  // R47：remote 只能精确同值。查询要 remote 时不得落到无 remote 的 local binding；
  // local 查询也不得借用同 identity/path 的 remote binding。
  return bindingRemote === targetRemote;
}
