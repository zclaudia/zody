import { sameCuaObservationRef } from "./cua-runtime-observation-ref.js";
import type { CuaSubmissionRef } from "@zody/contracts";
import type { AgentRuntime } from "@zody/core";
import type {
  CuaNativeCaptureRuntimeOptions,
  CuaNodeReplMcpPortFactoryInput,
} from "./cua-runtime-native-capture.js";
import { observeCuaRuntimeOnce } from "./cua-runtime-native-observation.js";

export function createCuaObservationCallbacks(
  getRuntime: () => AgentRuntime,
  options: CuaNativeCaptureRuntimeOptions,
): Pick<CuaNodeReplMcpPortFactoryInput, "observationOnce" | "verifyObservationScope"> {
  const watchers = new Set<{ close(): void; waitForClose(): Promise<unknown> }>();
  const snapshots = new WeakMap<
    object,
    { ref: CuaSubmissionRef; turnId: string; runId: string | undefined }
  >();
  return {
    async observationOnce(request, observationOptions) {
      if (!observationOptions?.expected)
        throw new Error("cua_native_observation_expected_required");
      const runtime = getRuntime();
      if (request.method === "stop_computer_control") {
        const scope = runtime.createCuaSubmissionTurnScope();
        if (!scope) {
          // 没有 live owner 时先关闭残留监听，避免将仍持有租约的连接误报为空闲。
          const pending = [...watchers];
          for (const watcher of pending) watcher.close();
          await Promise.all(pending.map((watcher) => watcher.waitForClose()));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action_sent: false,
                  dispatch_status: "not_sent",
                  state_sync_status: "not_requested",
                  control_status: "inactive",
                }),
              },
            ],
          };
        }
        try {
          const expected = observationOptions.expected;
          if (
            scope.ref.sessionId !== expected.sessionId ||
            scope.ref.workspaceKey !== expected.workspaceKey ||
            scope.turnId !== expected.turnId ||
            (runtime.matchesCuaContext
              ? !runtime.matchesCuaContext(expected)
              : Boolean(expected.workspaceIdentity || expected.remoteSessionId))
          )
            throw new Error("cua_stop_scope_mismatch");
          const result = await scope.producerPort.revoke({ ref: scope.ref, reason: "user-stop" });
          if (result.status !== "revoked") throw new Error("cua_stop_authority_unavailable");
          return { content: [{ type: "text", text: JSON.stringify({ stopped: true }) }] };
        } finally {
          scope.close();
        }
      }
      const projection = runtime.getCuaSubmissionProjection();
      if (projection.status !== "candidate")
        throw new Error("cua_native_observation_scope_unavailable");
      const snapshot = {
        ref: { ...projection.ref },
        turnId: observationOptions.expected.turnId,
        runId: runtime.getActiveForegroundExecutionId(),
      };
      const result = await observeCuaRuntimeOnce(runtime, {
        ...options,
        request,
        ...observationOptions,
        onLeaseWatcher(watcher) {
          watchers.add(watcher);
          void watcher.waitForClose().then(() => watchers.delete(watcher));
        },
      });
      snapshots.set(observationOptions.expected, snapshot);
      return result;
    },
    verifyObservationScope(expected) {
      const snapshot = snapshots.get(expected);
      const runtime = getRuntime();
      const projection = runtime.getCuaSubmissionProjection();
      return Boolean(
        snapshot &&
        projection.status === "candidate" &&
        sameCuaObservationRef(projection.ref, snapshot.ref) &&
        runtime.getActiveTurnInfo()?.turnId === snapshot.turnId &&
        snapshot.runId !== undefined &&
        runtime.getActiveForegroundExecutionId() === snapshot.runId,
      );
    },
  };
}
