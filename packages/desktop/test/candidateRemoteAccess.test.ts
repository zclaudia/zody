import { describe, expect, it, vi } from "vitest";
import type { NativeHostLaunchConfig } from "../src/main/nodeHostProcess.js";
import {
  CANDIDATE_REMOTE_ACCESS_BLOCKED_ERROR,
  createRemoteAccessSettingsForLaunch,
  isCandidateRemoteAccessBlocked,
  shouldLoadRemoteAccessCredential,
  type RemoteAccessSettingsPort,
} from "../src/main/candidateRemoteAccess.js";

const candidate: NativeHostLaunchConfig = {
  launcherPath: "/opt/zody/native/zody-native",
  cwd: "/opt/zody/runtime",
};

function createSettings(enabled = true): RemoteAccessSettingsPort & {
  isEnabled: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  isArbitraryPathOpenAllowed: ReturnType<typeof vi.fn>;
} {
  return {
    isEnabled: vi.fn(async () => enabled),
    setEnabled: vi.fn(async () => {}),
    isArbitraryPathOpenAllowed: vi.fn(async () => true),
  };
}

describe("candidate remote access assembly", () => {
  it("keeps the normal product settings port unchanged", async () => {
    const settings = createSettings();
    const wrapped = createRemoteAccessSettingsForLaunch(settings, undefined);
    expect(wrapped).toBe(settings);
    expect(await wrapped.isEnabled()).toBe(true);
    await wrapped.setEnabled(true);
    expect(settings.setEnabled).toHaveBeenCalledWith(true);
  });

  it("blocks reads, writes, and arbitrary-path opens only for the explicit candidate launch", async () => {
    const settings = createSettings(true);
    const wrapped = createRemoteAccessSettingsForLaunch(settings, candidate);

    expect(isCandidateRemoteAccessBlocked(candidate)).toBe(true);
    expect(await wrapped.isEnabled()).toBe(false);
    expect(await wrapped.isArbitraryPathOpenAllowed()).toBe(false);
    await expect(wrapped.setEnabled(true)).rejects.toThrow(CANDIDATE_REMOTE_ACCESS_BLOCKED_ERROR);
    await wrapped.setEnabled(false);
    expect(settings.isEnabled).not.toHaveBeenCalled();
    expect(settings.setEnabled).not.toHaveBeenCalled();
  });

  it("does not read the account credential when candidate remote access is blocked", () => {
    expect(shouldLoadRemoteAccessCredential(undefined, false)).toBe(true);
    expect(shouldLoadRemoteAccessCredential(candidate, false)).toBe(false);
    expect(shouldLoadRemoteAccessCredential(candidate, true)).toBe(true);
  });
});
