import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  digestZodyAgentNativeRuntimeNetwork,
  type ZodyAgentNativeRuntimeStartupContext,
} from "@zody/services/node";
import {
  CUA_NARROW_APP_NAME,
  CUA_NARROW_CAPABILITY,
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_MINIMUM_MACOS_VERSION,
  CUA_NARROW_PROFILE_KIND,
  CUA_NARROW_PROFILE_SCHEMA_VERSION,
  CUA_NARROW_RESOURCES_SLOT,
  compareMacOSVersions,
  isMacOSVersionAtLeast,
  parseCuaNarrowAgentBuildProfile,
  prepareCuaNarrowAgentRuntime,
  readCuaNarrowAgentBuildProfile,
  resolveCuaNarrowLauncherPath,
} from "../src/host/cuaNarrowAgentRuntime.js";

const createdRoots: string[] = [];

afterEach(() => {
  delete process.env.ZODY_CUA_NARROW_AGENT_JSON;
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

const startupContext: ZodyAgentNativeRuntimeStartupContext = {
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
  patch: object = {},
) {
  return {
    kind: CUA_NARROW_PROFILE_KIND,
    schemaVersion: CUA_NARROW_PROFILE_SCHEMA_VERSION,
    capability: CUA_NARROW_CAPABILITY,
    minimumTarget: {
      os: "darwin",
      arch: "arm64",
      minimumMacOSVersion: CUA_NARROW_MINIMUM_MACOS_VERSION,
    },
    resourceManifest: {
      sha256: resources.manifestSha256,
      launcherSha256: resources.launcherSha256,
    },
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

function commandContext(workspace: string) {
  return {
    workspacePath: workspace,
    workspaceKey: workspace,
    presentationSurface: "desktop" as const,
  };
}

describe("macOS version comparison", () => {
  it("compares numerically across the 26.x jump and short forms", () => {
    expect(compareMacOSVersions("14.2", "14.2")).toBe(0);
    expect(compareMacOSVersions("14.2", "14.2.0")).toBe(0);
    expect(compareMacOSVersions("26.6.2", "14.2")).toBeGreaterThan(0);
    expect(compareMacOSVersions("14.1.9", "14.2")).toBeLessThan(0);
    expect(compareMacOSVersions("9.1", "14.2")).toBeLessThan(0);
    expect(compareMacOSVersions("15.0", "14.2")).toBeGreaterThan(0);
    expect(isMacOSVersionAtLeast("26.6.2", "14.2")).toBe(true);
    expect(isMacOSVersionAtLeast("14.1", "14.2")).toBe(false);
  });
});

describe("cua narrow agent runtime", () => {
  it("is disabled without a compile-time profile and never reads runtime env", () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources);
    process.env.ZODY_CUA_NARROW_AGENT_JSON = JSON.stringify(profile);

    expect(readCuaNarrowAgentBuildProfile()).toBeUndefined();
    expect(() => parseCuaNarrowAgentBuildProfile(undefined)).toThrow(/kind/);
  });

  it("accepts only the fixed v2 startup profile shape", () => {
    const resources = createResources();
    const profile = createProfile(resources);

    expect(parseCuaNarrowAgentBuildProfile(profile)).toMatchObject({
      kind: CUA_NARROW_PROFILE_KIND,
      schemaVersion: 2,
      capability: CUA_NARROW_CAPABILITY,
      minimumTarget: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
    });
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, capability: "screenshot.fullscreen" }),
    ).toThrow(/capability/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({
        ...profile,
        minimumTarget: { ...profile.minimumTarget, minimumMacOSVersion: "12.0" },
      }),
    ).toThrow(/minimumMacOSVersion/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, workspaceAllowlist: ["/tmp"] }),
    ).toThrow(/unsupported field/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, provider: { revisionSha256: "a".repeat(64) } }),
    ).toThrow(/unsupported field/);
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, network: { digestSha256: "a".repeat(64) } }),
    ).toThrow(/unsupported field/);
    // v1（self-use 轮）profile 必须显式失败：schemaVersion 不存在双读路径。
    expect(() =>
      parseCuaNarrowAgentBuildProfile({ ...profile, schemaVersion: 1 }),
    ).toThrow(/schemaVersion/);
  });

  it("derives the launcher only from the fixed cua-narrow slot inside resourcesPath", () => {
    const resources = createResources();
    expect(resolveCuaNarrowLauncherPath(resources.resourcesPath)).toBe(resources.launcherPath);
    expect(() => resolveCuaNarrowLauncherPath("relative/resources")).toThrow(/absolute/);
  });

  it("does not enable on an unsupported target, arch, below-minimum macOS, or tampered resources", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources);

    await expect(
      prepare(profile, resources, [workspace], { platform: "linux" }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "target-platform" });
    await expect(prepare(profile, resources, [workspace], { arch: "x64" })).resolves.toMatchObject({
      status: "unsupported",
      reason: "target-arch",
    });
    await expect(
      prepare(profile, resources, [workspace], { macOSVersion: "14.1.9" }),
    ).resolves.toMatchObject({ status: "unsupported", reason: "macos-below-minimum" });
    // 跨大版本（26.x 跳跃编号）满足 14.2 下限。
    await expect(
      prepare(profile, resources, [workspace], { macOSVersion: "26.6.2" }),
    ).resolves.toMatchObject({ status: "eligible" });

    writeFileSync(resources.launcherPath, "tampered-launcher");
    await expect(prepare(profile, resources, [workspace])).resolves.toMatchObject({
      status: "unsupported",
      reason: "launcher-digest-mismatch",
    });
  });

  it("keeps the startup readback as a bounded diagnostic that never gates eligibility", async () => {
    const workspace = createWorkspace();
    const resources = createResources();
    const profile = createProfile(resources);
    const events: unknown[] = [];

    // 任意 provider/network 配置（与任何构建期事实无关）都不得影响 eligibility。
    for (const context of [
      startupContext,
      { ...startupContext, providerDigestSha256: "c".repeat(64) },
      {
        ...startupContext,
        selection: { ...startupContext.selection, modelId: "other-model" },
      },
      { ...startupContext, network: { ...startupContext.network, httpProxy: "http://127.0.0.1:9999" } },
    ]) {
      await expect(
        prepare(profile, resources, [workspace], {
          startupContext: context,
          report: (event: unknown) => events.push(event),
        }),
      ).resolves.toMatchObject({ status: "eligible" });
    }
    // 缺 startupContext 只跳过诊断日志，不禁用窄链。
    await expect(
      prepare(profile, resources, [workspace], { startupContext: undefined }),
    ).resolves.toMatchObject({ status: "eligible" });

    const snapshot = events.find(
      (event) => (event as { kind?: string }).kind === "narrow-runtime-startup-snapshot",
    );
    expect(snapshot).toEqual({
      kind: "narrow-runtime-startup-snapshot",
      reason: "diagnostic-readback",
      providerDigestSha256: startupContext.providerDigestSha256,
      selection: startupContext.selection,
      networkDigestSha256: digestZodyAgentNativeRuntimeNetwork(startupContext.network),
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1:7890");
    expect(JSON.stringify(snapshot)).not.toContain("zody-test-ca.pem");
  });

  it("routes only prepared workspaces captured at Host init", async () => {
    const workspace = createWorkspace();
    const otherWorkspace = createWorkspace("other");
    const resources = createResources();
    const profile = createProfile(resources);

    const result = await prepare(profile, resources, [workspace]);
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    await expect(result.runtime.resolve(commandContext(workspace))).resolves.toEqual({
      launcherPath: resources.launcherPath,
      entryName: "cli-entry.mjs",
      cliInFd: 6,
      cliOutFd: 7,
      launchMode: "workspace-relay",
    });
    // 未在 Host init 时准备的 workspace（含 Host 启动后才打开的）回退普通 Agent 路径。
    await expect(result.runtime.resolve(commandContext(otherWorkspace))).resolves.toBeNull();
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.not.toBeNull();
  });

  it("falls back when prepared storage is unavailable for the spawn workspace", async () => {
    const workspace = createWorkspace();
    const unpreparedWorkspace = createWorkspace("unprepared");
    const resources = createResources();
    const profile = createProfile(resources);

    const result = await prepare(profile, resources, [workspace]);
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    await expect(
      result.runtime.resolve(commandContext(unpreparedWorkspace)),
    ).resolves.toBeNull();
  });

  it("stays eligible with an empty seed set; dynamic preparation admits new workspaces", async () => {
    // 动态准入（spec 2026-11-09 追加小节）：init 集合为空不再禁用 resolver。
    const workspace = createWorkspace("late-opened");
    const resources = createResources();
    const profile = createProfile(resources);
    // resolver 以 realpath 规范化路径调用 preparer（macOS /var → /private/var）。
    const canonicalWorkspace = realpathSync(workspace);
    let prepareCalls = 0;

    const result = await prepare(profile, resources, [], {
      prepareWorkspaceStorage: async (path) => {
        prepareCalls += 1;
        expect(path).toBe(canonicalWorkspace);
        return true;
      },
    });
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    // 首次 spawn：现场准备成功 → 路由窄链。
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.not.toBeNull();
    // 第二次 spawn：命中集合，不再调用 preparer。
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.not.toBeNull();
    expect(prepareCalls).toBe(1);
  });

  it("deduplicates concurrent storage preparations per canonical workspace", async () => {
    const workspace = createWorkspace("concurrent");
    const resources = createResources();
    const profile = createProfile(resources);
    let prepareCalls = 0;
    let releasePreparation: (() => void) | undefined;

    const result = await prepare(profile, resources, [], {
      prepareWorkspaceStorage: async () => {
        prepareCalls += 1;
        await new Promise<void>((resolve) => {
          releasePreparation = resolve;
        });
        return true;
      },
    });
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    const first = result.runtime.resolve(commandContext(workspace));
    const second = result.runtime.resolve(commandContext(workspace));
    // 等 preparer 真正被调用（realpath 异步完成）再放行，避免竞态下 no-op 释放。
    await vi.waitFor(() => {
      if (prepareCalls === 0) throw new Error("preparation not started yet");
    });
    releasePreparation?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).not.toBeNull();
    expect(secondResult).not.toBeNull();
    expect(prepareCalls).toBe(1);
  });

  it("falls back on preparation failure and can retry on a later spawn", async () => {
    const workspace = createWorkspace("flaky");
    const resources = createResources();
    const profile = createProfile(resources);
    const events: unknown[] = [];
    let shouldSucceed = false;

    const result = await prepare(profile, resources, [], {
      prepareWorkspaceStorage: async () => shouldSucceed,
      report: (event: unknown) => events.push(event),
    });
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;

    await expect(result.runtime.resolve(commandContext(workspace))).resolves.toBeNull();
    expect(
      events.some(
        (event) =>
          (event as { kind?: string; reason?: string }).kind === "narrow-runtime-fallback" &&
          (event as { reason?: string }).reason === "workspace-storage-preparation-failed",
      ),
    ).toBe(true);

    shouldSucceed = true;
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.not.toBeNull();
  });

  it("keeps the not-prepared fallback when no dynamic preparer is wired", async () => {
    // 无 preparer 的接线（测试/旧路径）保持 v2 初始语义：未命中集合即回退。
    const workspace = createWorkspace("no-preparer");
    const resources = createResources();
    const profile = createProfile(resources);
    const events: unknown[] = [];

    const result = await prepare(profile, resources, [], {
      report: (event: unknown) => events.push(event),
    });
    expect(result.status).toBe("eligible");
    if (result.status !== "eligible") return;
    await expect(result.runtime.resolve(commandContext(workspace))).resolves.toBeNull();
    expect(
      events.some(
        (event) =>
          (event as { kind?: string }).kind === "narrow-runtime-fallback" &&
          (event as { reason?: string }).reason === "workspace-storage-not-prepared",
      ),
    ).toBe(true);
  });
});
