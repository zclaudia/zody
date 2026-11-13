import type { CuaSubmissionRef } from "@zody/contracts";
/** 身份字段逐项比较，避免 JSON 对象属性顺序影响授权判断。 */
export function sameCuaObservationRef(a: CuaSubmissionRef, b: CuaSubmissionRef): boolean {
  return (
    a.submissionLineageId === b.submissionLineageId &&
    a.appIncarnation === b.appIncarnation &&
    a.hostInstanceId === b.hostInstanceId &&
    a.runtimeInstanceId === b.runtimeInstanceId &&
    a.sessionId === b.sessionId &&
    a.workspaceKey === b.workspaceKey &&
    a.authorizationRevision === b.authorizationRevision
  );
}
