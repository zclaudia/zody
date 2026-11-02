import type { NativeHostLaunchConfig } from "./nodeHostProcess.js";

/** Main-owned remote access setting port used by the existing gateway/runtime assembly. */
export interface RemoteAccessSettingsPort {
  isEnabled(): Promise<boolean>;
  setEnabled(enabled: boolean): Promise<void>;
  isArbitraryPathOpenAllowed(): Promise<boolean>;
}

export const CANDIDATE_REMOTE_ACCESS_BLOCKED_ERROR =
  "Remote access is disabled in the local Computer Use candidate build.";

/**
 * The compile-time native Host launch is already the explicit candidate composition signal.
 * It is wiring, not an authorization proof, and must not add another persisted/runtime state.
 */
export function isCandidateRemoteAccessBlocked(
  candidateNativeHostLaunch: NativeHostLaunchConfig | undefined,
): boolean {
  return candidateNativeHostLaunch !== undefined;
}

/**
 * Candidate-only read/write guard. The normal product receives the original settings port.
 * A candidate never reports the account's persisted remoteAccess.enabled and never writes it.
 */
export function createRemoteAccessSettingsForLaunch(
  settings: RemoteAccessSettingsPort,
  candidateNativeHostLaunch: NativeHostLaunchConfig | undefined,
): RemoteAccessSettingsPort {
  if (!isCandidateRemoteAccessBlocked(candidateNativeHostLaunch)) return settings;
  return Object.freeze({
    isEnabled: async () => false,
    setEnabled: async (enabled: boolean) => {
      if (enabled) throw new Error(CANDIDATE_REMOTE_ACCESS_BLOCKED_ERROR);
    },
    isArbitraryPathOpenAllowed: async () => false,
  });
}

/** Candidate builds must not even read the account credential while remote access is blocked. */
export function shouldLoadRemoteAccessCredential(
  candidateNativeHostLaunch: NativeHostLaunchConfig | undefined,
  enabled: boolean,
): boolean {
  return !isCandidateRemoteAccessBlocked(candidateNativeHostLaunch) || enabled;
}
