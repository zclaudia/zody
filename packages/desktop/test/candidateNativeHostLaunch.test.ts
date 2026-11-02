import { describe, expect, it } from "vitest";
import {
  resolveCandidateApplicationName,
  resolveCandidateNativeHostLaunch,
} from "../src/main/candidateNativeHostLaunch.js";

describe("candidate native Host launch config", () => {
  it("stays disabled when the compile-time define is absent", () => {
    expect(resolveCandidateNativeHostLaunch()).toBeUndefined();
  });

  it("accepts only a fixed absolute launcher with the sealed Host entry", () => {
    const config = {
      launcherPath: "/opt/zody/native/zody-native",
      cwd: "/opt/zody/runtime",
      entryName: "host-entry.mjs" as const,
      bridgeFd: 5,
      launchMode: "workspace-relay" as const,
    };
    expect(resolveCandidateNativeHostLaunch(config)).toEqual(config);
    expect(() =>
      resolveCandidateNativeHostLaunch({ ...config, launcherPath: "native/zody-native" }),
    ).toThrow(/absolute path/);
    expect(() =>
      resolveCandidateNativeHostLaunch({ ...config, entryName: "index.mjs" as never }),
    ).toThrow(/entryName/);
    expect(() =>
      resolveCandidateNativeHostLaunch({ ...config, env: { ELECTRON_RUN_AS_NODE: "1" } }),
    ).toThrow(/ELECTRON_RUN_AS_NODE/);
    expect(() =>
      resolveCandidateNativeHostLaunch({ ...config, launchMode: "other" as never }),
    ).toThrow(/launchMode/);
  });

  it("resolves packaged resources relative to the running Electron resources root", () => {
    expect(
      resolveCandidateNativeHostLaunch(
        {
          kind: "packaged-resources",
          applicationName: "Zody CUA Launchservices Candidate",
          launcherPathRelativeToResources:
            "cua-helper/ZCode Computer Use.app/Contents/MacOS/macos-cua-desktop-session",
          cwdRelativeToResources: "cua-helper/ZCode Computer Use.app/Contents/MacOS",
          entryName: "host-entry.mjs",
          bridgeFd: 5,
          launchMode: "workspace-relay",
        },
        { resourcesPath: "/Applications/Candidate.app/Contents/Resources" },
      ),
    ).toEqual({
      launcherPath:
        "/Applications/Candidate.app/Contents/Resources/cua-helper/ZCode Computer Use.app/Contents/MacOS/macos-cua-desktop-session",
      cwd: "/Applications/Candidate.app/Contents/Resources/cua-helper/ZCode Computer Use.app/Contents/MacOS",
      entryName: "host-entry.mjs",
      bridgeFd: 5,
      launchMode: "workspace-relay",
    });
    expect(() =>
      resolveCandidateNativeHostLaunch(
        {
          kind: "packaged-resources",
          launcherPathRelativeToResources: "../outside",
          cwdRelativeToResources: ".",
        },
        { resourcesPath: "/Applications/Candidate.app/Contents/Resources" },
      ),
    ).toThrow(/resourcesPath/);
    expect(
      resolveCandidateApplicationName({
        kind: "packaged-resources",
        applicationName: "Zody CUA Launchservices Candidate",
        launcherPathRelativeToResources: "launcher",
        cwdRelativeToResources: ".",
      }),
    ).toBe("Zody CUA Launchservices Candidate");
  });
});
