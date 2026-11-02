import {
  assertNativeHostLaunchConfig,
  type NativeHostLaunchConfig,
} from "./nodeHostProcess.js";

/**
 * Compile-time candidate composition seam.
 *
 * A candidate UI build may replace this identifier with an object literal containing
 * the fixed absolute launcher path and cwd from sealed resources. Normal builds leave
 * it undefined and keep the Electron utilityProcess path. Never read this from env,
 * argv, Renderer messages, or a runtime JSON file: those are routing inputs, not a
 * signature/audit-token proof.
 */
declare const __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__: NativeHostLaunchConfig | undefined;

function readCompileTimeCandidate(): NativeHostLaunchConfig | undefined {
  return typeof __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__ === "undefined"
    ? undefined
    : __ZCODE_CANDIDATE_NATIVE_HOST_LAUNCH__;
}

export function resolveCandidateNativeHostLaunch(
  configured: NativeHostLaunchConfig | undefined = readCompileTimeCandidate(),
): NativeHostLaunchConfig | undefined {
  if (!configured) return undefined;
  assertNativeHostLaunchConfig(configured);
  return configured;
}
