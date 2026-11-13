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
  const snapshots = new WeakMap<
    object,
    { ref: CuaSubmissionRef; turnId: string; runId: string | undefined }
  >();
  return {
    async observationOnce(request, observationOptions) {
      if (!observationOptions?.expected)
        throw new Error("cua_native_observation_expected_required");
      const runtime = getRuntime();
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
