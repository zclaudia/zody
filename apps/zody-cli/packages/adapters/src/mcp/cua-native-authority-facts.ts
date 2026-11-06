import type {
  CuaSubmissionProjection,
  CuaSubmissionRef,
  CuaSubmissionRevocationResult,
} from "@zody/contracts";
import {
  sameCuaSubmissionIdentity,
  sameCuaSubmissionRef,
} from "./cua-native-authority-contract.js";

export const UNKNOWN_CUA_SUBMISSION_PROJECTION: CuaSubmissionProjection = Object.freeze({
  status: "unknown",
  nativeFence: "unknown",
  mobileDelivery: "unknown",
});

export const UNKNOWN_CUA_SUBMISSION_REVOCATION: CuaSubmissionRevocationResult = Object.freeze({
  status: "unknown",
  projection: UNKNOWN_CUA_SUBMISSION_PROJECTION,
});

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** revoke 会推进 revision；回执只要求同 lineage identity + 不倒退 revision，原请求仍严格原 ref。 */
export function isRealRevocationForScope(
  result: CuaSubmissionRevocationResult,
  scopeRef: CuaSubmissionRef,
): result is Extract<CuaSubmissionRevocationResult, { status: "revoked" }> {
  return (
    result.status === "revoked" &&
    sameCuaSubmissionIdentity(result.ref, scopeRef) &&
    result.ref.authorizationRevision >= scopeRef.authorizationRevision &&
    result.projection.status === "revoked" &&
    sameCuaSubmissionRef(result.projection.ref, result.ref)
  );
}
