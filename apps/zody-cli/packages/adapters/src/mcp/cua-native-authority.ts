import type {
  CuaNativeAuthoritySession,
  CuaNativeAuthoritySessionOptions,
} from "./cua-native-authority-contract.js";
export type {
  CuaNativeObservationOptions,
  CuaNativeAuthorityCaptureOptions,
  CuaNativeAuthorityImageToolResult,
  CuaNativeCapturePngFacts,
  CuaNativeCaptureResultPayload,
  CuaNativeCaptureTarget,
} from "./cua-native-authority-contract.js";
import { CuaNativeAuthoritySessionImpl } from "./cua-native-authority-session.js";

export type {
  CuaNativeAuthorityCloseReason,
  CuaNativeAuthorityCloseResult,
  CuaNativeAuthorityDiagnostics,
  CuaNativeAuthorityMethod,
  CuaNativeAuthorityRequestFrame,
  CuaNativeAuthorityRevokeOutcome,
  CuaNativeAuthoritySession,
  CuaNativeAuthoritySessionOptions,
  CuaNativeConfirmRequestPayload,
  CuaNativeConfirmTarget,
} from "./cua-native-authority-contract.js";

/**
 * 可信 composition 才能调用的窄入口：调用方必须已经把真实 runtime turn scope、
 * 同一次 launcher 的私有 Duplex 与 producer incarnation 装配好。默认不启用；
 * 本工厂不读取环境变量、不启动进程、不认证 peer，也不暴露模型/RPC。
 */
export function createCuaNativeAuthoritySession(
  options: CuaNativeAuthoritySessionOptions,
): CuaNativeAuthoritySession {
  return new CuaNativeAuthoritySessionImpl(options);
}
