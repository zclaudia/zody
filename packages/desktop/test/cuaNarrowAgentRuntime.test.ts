import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  digestZCodeAgentNativeRuntimeNetwork,
  type ZCodeAgentNativeRuntimeStartupContext,
} from "@zcode/services/node";
import {
  CUA_NARROW_APP_NAME,
  CUA_NARROW_CAPABILITY,
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_PROFILE_KIND,
  CUA_NARROW_RESOURCES_SLOT,
  digestCuaNarrowNetworkConfig,
  parseCuaNarrowAgentBuildProfile,
  prepareCuaNarrowAgentRuntime,
  readCuaNarrowAgentBuildProfile,
  resolveCuaNarrowLauncherPath,
} from "../src/host/cuaNarrowAgentRuntime.js";

const createdRoots: string[] = [];

afterEach(() => {
  delete process.env.ZCODE_CUA_NARROW_AGENT_JSON;
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function createResources(launcherBytes = "signed-launcher", manifestPatch: object = {}) {
  const resourcesPath = mkdtempSync(join(tmpdir(), "zody-cua-narrow-runtime-"));
  createdRoots.push(resourcesPath);
  const appPath = join(resourcesPath, CUA_NARROW_RESOURCES_SLOT, CUA_NARROW_APP_NAME);
  const launcherPath = join(appPath, CUA_NARROW_LAUNCHER_RELATIVE_PATH);
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, launcherBytes);
  const manifest = {
    kind: "zody-cua-narrow-resource-manifest",
    status: "pass",
    schemaVersion: 1,
    target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
    slot: {
      resourcesRelativePath: CUA_NARROW_RESOURCES_SLOT,
      appName: CUA_NARROW_APP_NAME,
    },
    identity: { signedBinarySha256: sha256(launcherBytes) },
    ...manifestPatch,
  };
  const manifestText = JSON.stringify(manifest);
  const manifestPath = join(resourcesPath, CUA_NARROW_RESOURCES_SLOT, "manifest.json");
  writeFileSync(manifestPath, manifestText);
  return {
    resourcesPath,
    launcherPath,
    manifestPath,
    launcherSha256: sha256(launcherBytes),
    manifestSha256: sha256(manifestText),
  };
}

function createWorkspace(name = "workspace") {
  const workspace = mkdtempSync(join(tmpdir(), `zody-cua-narrow-${name}-`));
  createdRoots.push(workspace);
  return workspace;
}

const startupContext: ZCodeAgentNativeRuntimeStartupContext = {
  providerDigestSha256: "a".repeat(64),
  selection: {
    providerId: "deepseek-anthropic",
    modelId: "deepseek-v3.2",
    options: { reasoningLevel: "high" },
  },
  network: {
    httpProxy: "http://127.0.0.1:7890",
    noProxy: "localhost,127.0.0.1",
    caCertPath: "/tmp/zody-test-ca.pem",
  },
};

function createProfile(
  resources: ReturnType<typeof createResources>,
  workspaceAllowlist: string[],
  patch: object = {},
) {
  return {
    kind: CUA_NARROW_PROFILE_KIND,
    schemaVersion: 1,
    capability: CUA_NARROW_CAPABILITY,
    testedTarget: { os: "darwin", arch: "arm64", macOSVersion: "26.6.2" },
    workspaceAllowlist,
    resourceManifest: {
      sha256: resources.manifestSha256,
      launcherSha256: resources.launcherSha256,
    },
    provider: {
      revisionSha256: startupContext.providerDigestSha256,
      selection: startupContext.selection,
    },
    network: { digestSha256: digestCuaNarrowNetworkConfig(startupContext.network) },
    ...patch,
  };
}

function prepare(
  profile: unknown,
  resources: ReturnType<typeof createResources>,
  preparedWorkspacePaths: string[],
  patch: object = {},
) {
  return prepareCuaNarrowAgentRuntime({
    buildProfile: profile,
    platform: "darwin",
    arch: "arm64",
    macOSVersion: "26.6.2",
    resourcesPath: resources.resourcesPath,
    preparedWorkspacePaths,
    startupContext,
    ...patch,
  });
}

function resolverContext(
  workspace: string,
  readStartupContext: () => Promise<ZCodeAgentNativeRuntimeStartupContext> = async () =>
    startupContext,
) {
  return {
    commandContext: {
      workspacePath: workspace,
      workspaceKey: workspace,
      presentationSurface: "desktop" as const,
    },
    runtimeContext: { readStartupContext },
  };
}

function commandContext(workspace: string) {
  return {
    workspacePath: workspace,
    workspaceKey: workspace,
    presentationSurface: "desktop" as const,
  };
}

describe("cua narrow agent runtime", () => {
  it("is disabled without a compile-time profile and never reads runtime env", () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);
    process.env.ZCODE_CUA_NARROW_AGENT_JSON = JSON.stringify(profile);

    expect(readCuaNarrowAgentBuildProfile()).toBeUndefined();
    expect(() => parseCuaNarrowAgentBuildProfile(undefined)).toThrow(/kind/);
  });

  it("accepts only the fixed startup profile shape", () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);

    expect(parseCuaNarrowAgentBuildProfile(profile)).toMatchObject({
      kind: CUA_NARROW_PROFILE_KIND,
      capability: CUA_NARROW_CAPABILITY,
      workspaceAllowlist: [workspace],
      provider: {
        revisionSha256: startupContext.providerDigestSha256,
        selection: startupContext.selection,
      },
      network: { digestSha256: digestCuaNarrowNetworkConfig(startupContext.network) },
    });
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, capability: "screenshot.fullscreen" }),
    ).toThrow(/capability/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, workspaceAllowlist: ["relative/path"] }),
    ).toThrow(/absolute/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({
        ...profile,
        provider: { revisionSha256: "not-a-digest", selection: startupContext.selection },
      }),
    ).toThrow(/provider/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({
        ...profile,
        network: { digestSha256: "not-a-digest" },
      }),
    ).toThrow(/network/);
  });

  it("derives the launcher only from the fixed cua-narrow slot inside resourcesPath", () => {
    const resources = createResources();
    expect(resolveCuaNarrowLauncherPath(resources.resourcesPath)).toBe(resources.launcherPath);
    expect(() => resolveCuaNarrowLauncherPath("relative/resources")).toThrow(/absolute/);
  });

  it("does not enable on an untested target or without matching resources", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);

    await expect(
      prepare(profile, resources, [workspace], { platform: "linux" }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "target-platform" });
    await expect(prepare(profile, resources, [workspace], { arch: "x64" })).resolves.toMatchObject({
      status: "unsupported",
      reason: "target-arch",
    });
    await expect(
      prepare(profile, resources, [workspace], { macOSVersion: "26.5.0" }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "target-macos-version" });

    writeFileSync(resources.launcherPath, "tampered-launcher");
    await expect(prepare(profile, resources, [workspace])).resolves.toMatchObject({
      status: "unsupported",
      reason: "launcher-digest-mismatch",
    });
  });

  it("requires the Host service startup snapshot to match every pinned field", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);

    await expect(
      prepare(profile, resources, [workspace], {
        startupContext: { ...startupContext, providerDigestSha256: "c".repeat(64) },
      }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "provider-revision-mismatch" });
    await expect(
      prepare(profile, resources, [workspace], {
        startupContext: {
          ...startupContext,
          selection: { ...startupContext.selection, modelId: "other-model" },
        },
      }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "provider-selection-mismatch" });
    await expect(
      prepare(profile, resources, [workspace], {
        startupContext: {
          ...startupContext,
          network: { ...startupContext.network, httpProxy: "http://127.0.0.1:9999" },
        },
      }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "network-digest-mismatch" });
    await expect(
      prepare(profile, resources, [workspace], { startupContext: undefined }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "startup-context-unavailable" });
  });

  it("emits a bounded startup readback before a profile mismatch", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace], {
      provider: {
        revisionSha256: "f".repeat(64),
        selection: startupContext.selection,
      },
    });
    const events: unknown[] = [];

    await expect(
      prepare(profile, resources, [workspace], {
        report: (event: unknown) => events.push(event),
      }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "provider-revision-mismatch" });

    const snapshot = events.find(
      (event) => (event as { kind?: string }).kind === "narrow-runtime-startup-snapshot",
    );
    expect(snapshot).toEqual({
      kind: "narrow-runtime-startup-snapshot",
      reason: "read-before-eligibility-compare",
      providerDigestSha256: startupContext.providerDigestSha256,
      selection: startupContext.selection,
      networkDigestSha256: digestZCodeAgentNativeRuntimeNetwork(startupContext.network),
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1:7890");
    expect(JSON.stringify(snapshot)).not.toContain("zody-test-ca.pem");
    expect(digestCuaNarrowNetworkConfig(startupContext.network)).toBe(
      digestZCodeAgentNativeRuntimeNetwork(startupContext.network),
    );
  });

  it("routes only allowlisted prepared workspaces after the startup snapshot matches", async () => {
    const workspace = createWorkspace();
    const otherWorkspace = createWorkspace("other");
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);

    const result = await prepare(profile, resources, [workspace]);
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    const matching = resolverContext(workspace);
    await expect(
      result.runtime.resolve(matching.commandContext, matching.runtimeContext),
    ).resolves.toEqual({
      launcherPath: resources.launcherPath,
      entryName: "cli-entry.mjs",
      cliInFd: 6,
      cliOutFd: 7,
      launchMode: "workspace-relay",
    });
    const other = resolverContext(otherWorkspace);
    await expect(
      result.runtime.resolve(other.commandContext, other.runtimeContext),
    ).resolves.toBeNull();
  });

  it("re-reads the Host service snapshot for every new Agent spawn", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);
    const result = await prepare(profile, resources, [workspace]);
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    const readStartupContext = vi
      .fn<() => Promise<ZCodeAgentNativeRuntimeStartupContext>>()
      .mockResolvedValueOnce(startupContext)
      .mockResolvedValueOnce({ ...startupContext, providerDigestSha256: "c".repeat(64) })
      .mockRejectedValueOnce(new Error("provider service unavailable"))
      .mockResolvedValueOnce(startupContext);
    const context = resolverContext(workspace, readStartupContext);

    await expect(
      result.runtime.resolve(context.commandContext, context.runtimeContext),
    ).resolves.not.toBeNull();
    await expect(
      result.runtime.resolve(context.commandContext, context.runtimeContext),
    ).resolves.toBeNull();
    await expect(
      result.runtime.resolve(context.commandContext, context.runtimeContext),
    ).resolves.toBeNull();
    await expect(
      result.runtime.resolve(context.commandContext, context.runtimeContext),
    ).resolves.not.toBeNull();
    expect(readStartupContext).toHaveBeenCalledTimes(4);
  });

  it("falls back when no spawn-time reader or prepared storage is available", async () => {
    const workspace = createWorkspace();
    const unpreparedWorkspace = createWorkspace("unprepared");
    const resources = createResources();
    const profile = createProfile(resources, [workspace, unpreparedWorkspace]);

    const result = await prepare(profile, resources, [workspace]);
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.toBeNull();
    const unprepared = resolverContext(unpreparedWorkspace);
    await expect(
      result.runtime.resolve(unprepared.commandContext, unprepared.runtimeContext),
    ).resolves.toBeNull();
  });

  it("refuses to enable when no allowlisted workspace was prepared before services started", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources, [workspace]);

    await expect(prepare(profile, resources, [])).resolves.toMatchObject({
      status: "unsupported",
      reason: "no-prepared-workspace",
    });
  });
});
