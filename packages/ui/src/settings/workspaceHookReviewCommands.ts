import type {
  CommandPayloadMap,
  CommandType,
  WorkspaceHookReviewRequestPayload,
} from "@zody/shared/zody-protocol-v4";
import type { Hook } from "@zody/shared";
import {
  resolveWorkspaceHookCommandBinding,
  resolveWorkspaceHookReviewBindingForItem,
  useWorkspaceHookReviewStore,
  waitForWorkspaceHookReviewBindingForItem,
  type WorkspaceHookCommandBinding,
  type WorkspaceHookReviewBinding,
} from "@/store/workspaceHookReviewStore.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export async function sendWorkspaceHookCommand<T extends CommandType>(
  binding: Pick<WorkspaceHookCommandBinding, "sendCommand" | "onCommandSettled">,
  sessionId: string,
  type: T,
  payload: CommandPayloadMap[T],
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const envelope = createCommandEnvelope({ type, sessionId, payload } as never);
  pendingCommandRegistry.record(envelope);
  try {
    const ack = await binding.sendCommand(envelope);
    pendingCommandRegistry.applyAck(envelope, ack);
    return {
      accepted: ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop",
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
    };
  } finally {
    binding.onCommandSettled?.(envelope.commandId);
  }
}

export function toWorkspaceHookReviewCommandTarget(request: WorkspaceHookReviewRequestPayload) {
  return {
    sessionId: request.sessionId,
    taskId: request.taskId,
    runId: request.runId,
    ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
    workspaceIdentity: request.workspaceIdentity,
    bundleDigest: request.bundleDigest,
    reviewFlowId: request.reviewFlowId,
    generation: request.generation,
    interactionId: request.interactionId,
  };
}

const DEFAULT_REVIEW_WAIT_TIMEOUT_MS = 5_000;

function shouldGrantCurrentWorkspaceSnapshot(reasonCode: string | undefined): boolean {
  return (
    reasonCode === "workspace_hooks_require_trust_capable_host" ||
    reasonCode === "workspace_hooks_snapshot_mismatch" ||
    reasonCode === "workspace_hooks_bundle_changed"
  );
}

function isCurrentReviewBinding(
  binding: WorkspaceHookReviewBinding,
  commandBindings: Record<string, WorkspaceHookCommandBinding>,
): boolean {
  const current = commandBindings[binding.request.sessionId];
  // 当前 session 已有新通道时，旧 review 的 sendCommand 不能再被当作可提交目标；
  // 没有 command binding 时保留既有 review 行为（Runtime 仍会做最终 owner 校验）。
  return !current || current.sendCommand === binding.sendCommand;
}

function respondToWorkspaceHookReview(
  binding: WorkspaceHookReviewBinding,
  reviewItemId: string,
): Promise<{ accepted: boolean; reasonCode?: string }> {
  const request = binding.request;
  return sendWorkspaceHookCommand(binding, request.sessionId, "respondWorkspaceHookReview", {
    ...toWorkspaceHookReviewCommandTarget(request),
    decision: {
      action: "trust_selected",
      reviewItemIds: [reviewItemId],
    },
  });
}

/**
 * Settings 行内 Trust 的单次用户动作：已有精确 flow 时直接 respond；否则先通过当前
 * session command binding 请求 flow，再等待 Runtime 投影出的 immutable request。
 * 当前 session 的 immutable snapshot 无法审核 Settings bundle 时，转由 workspace
 * Agent authority 重新发现 canonical snapshot；UI 静态 snapshot 始终只提供 exact target。
 */
export async function trustWorkspaceHookWithReview(input: {
  hook: Hook;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskSessionId?: string;
  reviewWaitTimeoutMs?: number;
  signal?: AbortSignal;
  grantWithoutSession?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }) => Promise<{ accepted: boolean; reasonCode?: string }>;
}): Promise<{ accepted: boolean; reasonCode?: string }> {
  const workspaceHook = input.hook.workspaceHook;
  const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
  if (!workspaceHook || !workspaceKey || workspaceHook.workspaceIdentity !== workspaceKey) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  const remoteSessionId = input.remoteSessionId?.trim() || undefined;
  const taskSessionId = input.taskSessionId?.trim() || undefined;
  if (input.signal?.aborted) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  const grantCurrentWorkspaceSnapshot = () => {
    if (!input.grantWithoutSession || !input.workspacePath) return undefined;
    return input.grantWithoutSession({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      bundleDigest: workspaceHook.bundleDigest,
      hookDeclarationDigest: workspaceHook.hookDeclarationDigest,
    });
  };
  const reviewTarget = {
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    ...(taskSessionId ? { taskSessionId } : {}),
    bundleDigest: workspaceHook.bundleDigest,
    reviewItemId: workspaceHook.reviewItemId,
  };
  const initialReview = resolveWorkspaceHookReviewBindingForItem(
    useWorkspaceHookReviewStore.getState().bindings,
    reviewTarget,
  );
  if (initialReview.status === "ambiguous") {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  let reviewBinding =
    initialReview.status === "matched" &&
    isCurrentReviewBinding(
      initialReview.binding,
      useWorkspaceHookReviewStore.getState().commandBindings,
    )
      ? initialReview.binding
      : undefined;

  if (!reviewBinding) {
    const commandResolution = resolveWorkspaceHookCommandBinding(
      useWorkspaceHookReviewStore.getState().commandBindings,
      {
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(taskSessionId ? { taskSessionId } : {}),
      },
    );
    if (commandResolution.status === "ambiguous") {
      // 同 identity + remote 有多个 task channel 且调用方没有给出 taskSessionId 时
      // 不按插入顺序猜 owner；歧义必须 fail closed，且不能借 workspace grant 绕过。
      return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
    }
    if (commandResolution.status === "missing") {
      if (taskSessionId) {
        return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
      }
      const granted = grantCurrentWorkspaceSnapshot();
      if (granted) return granted;
      return {
        accepted: false,
        reasonCode: "workspace_hooks_require_trust_capable_host",
      };
    }
    const commandBinding = commandResolution.binding;
    const requested = await sendWorkspaceHookCommand(
      commandBinding,
      commandBinding.sessionId,
      "requestWorkspaceHookReview",
      {
        sessionId: commandBinding.sessionId,
        ...(commandBinding.remoteSessionId
          ? { remoteSessionId: commandBinding.remoteSessionId }
          : {}),
        workspaceIdentity: workspaceHook.workspaceIdentity,
        bundleDigest: workspaceHook.bundleDigest,
      },
    );
    if (!requested.accepted) {
      const concurrentReview = resolveWorkspaceHookReviewBindingForItem(
        useWorkspaceHookReviewStore.getState().bindings,
        reviewTarget,
      );
      if (concurrentReview.status === "ambiguous") {
        return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
      }
      if (concurrentReview.status === "matched") {
        if (
          !isCurrentReviewBinding(
            concurrentReview.binding,
            useWorkspaceHookReviewStore.getState().commandBindings,
          )
        ) {
          // 已出现 reviewed item 但不是当前通道的 flow：属于 stale，不能转成 grant。
          return requested;
        }
        reviewBinding = concurrentReview.binding;
        return respondToWorkspaceHookReview(reviewBinding, workspaceHook.reviewItemId);
      }
      // 只要存在活跃 session binding 就把 Trust 固定路由给该
      // session；Settings 保存新 Hook 后，活跃 session 仍持有启动时不可变 snapshot，
      // 因而无法审核当前 bundle，却也阻断了本来安全可用的 workspace pretrust。
      if (shouldGrantCurrentWorkspaceSnapshot(requested.reasonCode)) {
        const granted = grantCurrentWorkspaceSnapshot();
        if (granted) return granted;
      }
      return requested;
    }

    const waited = await waitForWorkspaceHookReviewBindingForItem(
      {
        ...reviewTarget,
        expectedSendCommand: commandBinding.sendCommand,
        ...(input.signal ? { signal: input.signal } : {}),
        isInvalid: () => {
          const current =
            useWorkspaceHookReviewStore.getState().commandBindings[commandBinding.sessionId];
          return !current || current.sendCommand !== commandBinding.sendCommand;
        },
      },
      input.reviewWaitTimeoutMs ?? DEFAULT_REVIEW_WAIT_TIMEOUT_MS,
    );
    if (waited.status === "ambiguous") {
      return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
    }
    if (waited.status === "aborted" || waited.status === "invalidated") {
      // 连接换代或 scope abort 后旧 flow 不得借新通道重发，也不能转成 grant。
      return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
    }
    if (waited.status !== "matched") {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_interaction_timeout",
      };
    }
    reviewBinding = waited.binding;
    if (reviewBinding.sendCommand !== commandBinding.sendCommand) {
      return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
    }
  }

  if (input.signal?.aborted) {
    return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  }
  return respondToWorkspaceHookReview(reviewBinding, workspaceHook.reviewItemId);
}
