import { CuaSubmissionCoordinator } from "./cua-submission-coordinator.js";
import { hasCompleteCuaSubmissionIdentity } from "./cua-submission-coordinator-contract.js";
import type { CuaSubmissionRuntimeOptions } from "./cua-submission-coordinator-contract.js";

/** 缺完整可信身份时不构造 coordinator；普通聊天继续运行，CUA 保持 unknown。 */
export function createCuaSubmissionCoordinator(
  options: CuaSubmissionRuntimeOptions | undefined,
): CuaSubmissionCoordinator | undefined {
  if (!options || !hasCompleteCuaSubmissionIdentity(options)) return undefined;
  try {
    return new CuaSubmissionCoordinator(options);
  } catch {
    return undefined;
  }
}
