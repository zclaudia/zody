import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestZodyAgentNativeRuntimeNetwork,
  digestZodyAgentNativeRuntimeProviderSnapshot,
} from "@zody/services/node";
import {
  CUA_NARROW_APP_NAME,
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_RESOURCES_SLOT,
  NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME,
  NORMAL_HOST_CANDIDATE_BUNDLE_ID,
  NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
  NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
  NORMAL_HOST_CANDIDATE_RELEASE_FLAGS,
  createNormalHostNarrowProfile,
  digestNormalHostNetwork,
  digestNormalHostProviderSnapshot,
  normalizeNormalHostNetwork,
  parseNormalHostStartupSnapshot,
  projectNormalHostProviderSnapshot,
  rewriteNormalHostCandidateAppIdentity,
} from "../scripts/lib/normal-host-candidate-profile.mjs";
import {
  parseArgs,
  requirePreparedNarrowManifestPath,
} from "../scripts/lib/normal-host-candidate-config.mjs";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerView(revision = 7, modelEnabled = true) {
  return {
    revision,
    providerTemplates: [],
    providerOrder: ["deepseek-anthropic"],
    providers: [
      {
        providerId: "deepseek-anthropic",
        providerName: "DeepSeek",
        templateId: "anthropic",
        enabled: true,
        executable: true,
        effectiveConfig: {
          group: "standard-personal",
          visibility: "visible",
          access: { type: "api-key", apiKey: "must-not-be-archived" },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.example.test",
            headers: { Authorization: "Bearer must-not-be-archived" },
          },
          builtinModelIds: ["deepseek-v3.2"],
          personalModelIds: [],
          modelOrder: ["deepseek-v3.2"],
        },
        effectiveBuiltinConfig: { access: { apiKey: "also-secret" } },
        personalConfig: { access: { apiKey: "also-secret" } },
        issues: [],
        models: [
          {
            kind: "candidate",
            modelId: "deepseek-v3.2",
            builtin: true,
            enabled: modelEnabled,
            executable: true,
            selectable: true,
            issues: [],
            effectiveBuiltinConfig: { enabled: true },
            effectiveConfig: {
              enabled: modelEnabled,
              properties: { contextWindow: 128000 },
              optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
            },
          },
        ],
      },
    ],
  } as const;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "zody-normal-host-profile-"));
  createdRoots.push(root);
  const resourcesPath = join(root, "Resources");
  const appPath = join(resourcesPath, CUA_NARROW_RESOURCES_SLOT, CUA_NARROW_APP_NAME);
  const launcherPath = join(appPath, CUA_NARROW_LAUNCHER_RELATIVE_PATH);
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, "signed-launcher");
  const manifest = {
    kind: "zody-cua-narrow-resource-manifest",
    status: "pass",
    schemaVersion: 1,
    target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
    slot: {
      resourcesRelativePath: CUA_NARROW_RESOURCES_SLOT,
      appName: CUA_NARROW_APP_NAME,
    },
    stage: { appPath: `${CUA_NARROW_RESOURCES_SLOT}/${CUA_NARROW_APP_NAME}` },
    identity: { signedBinarySha256: sha256("signed-launcher") },
  };
  const manifestPath = join(resourcesPath, CUA_NARROW_RESOURCES_SLOT, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const providerProfilePath = join(root, "provider-profile.json");
  writeFileSync(
    providerProfilePath,
    JSON.stringify({
      providerSettingsView: providerView(),
      selection: {
        providerId: " deepseek-anthropic ",
        modelId: " deepseek-v3.2 ",
        options: { reasoningLevel: " high " },
      },
    }),
  );
  const networkProfilePath = join(root, "network-profile.json");
  writeFileSync(
    networkProfilePath,
    JSON.stringify({
      httpProxy: " http://127.0.0.1:7890 ",
      noProxy: " localhost,127.0.0.1 ",
      caCertPath: " /tmp/zody-test-ca.pem ",
    }),
  );
  const workspace = mkdtempSync(join(tmpdir(), "zody-normal-host-workspace-"));
  createdRoots.push(workspace);
  return {
    manifestPath,
    providerProfilePath,
    networkProfilePath,
    workspace,
  };
}

describe("normal Host candidate startup profile", () => {
  it("normalizes provider content without credentials or instance revision", () => {
    const first = projectNormalHostProviderSnapshot(providerView(1));
    const second = projectNormalHostProviderSnapshot(providerView(999));
    expect(first).toEqual(second);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("must-not-be-archived");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("Authorization");
    expect(digestNormalHostProviderSnapshot(providerView(1, false))).not.toBe(
      digestNormalHostProviderSnapshot(providerView(1, true)),
    );
  });

  it("normalizes proxy, noProxy, and CA values into one stable network digest", () => {
    expect(
      normalizeNormalHostNetwork({
        httpProxy: " http://127.0.0.1:7890 ",
        noProxy: " localhost ",
        caCertPath: " /tmp/ca.pem ",
        ignored: "must-not-be-used",
      }),
    ).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "localhost",
      caCertPath: "/tmp/ca.pem",
    });
  });

  it("keeps builder and Host service content digests byte-identical", () => {
    const network = {
      httpProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1",
      caCertPath: "/tmp/zody-test-ca.pem",
    };
    expect(digestNormalHostProviderSnapshot(providerView())).toBe(
      digestZodyAgentNativeRuntimeProviderSnapshot(providerView()),
    );
    expect(digestNormalHostNetwork(network)).toBe(digestZodyAgentNativeRuntimeNetwork(network));
  });

  it("uses a bounded Host startup snapshot without archiving raw provider/network data", async () => {
    const fixture = createFixture();
    const snapshotPath = join(fixture.workspace, "startup-snapshot.json");
    const snapshot = {
      kind: "narrow-runtime-startup-snapshot",
      reason: "read-before-eligibility-compare",
      providerRevisionSha256: "a".repeat(64),
      selection: {
        providerId: "deepseek-anthropic",
        modelId: "deepseek-v3.2",
        options: { reasoningLevel: "high" },
      },
      networkDigestSha256: "b".repeat(64),
      snapshotSource: "existing-host-services",
      taskTimeProviderGuard: false,
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot));

    const { profile, profileSource } = await createNormalHostNarrowProfile({
      narrowManifest: fixture.manifestPath,
      workspaceAllowlist: [fixture.workspace],
      startupSnapshot: snapshotPath,
      testedMacOSVersion: "26.6.2",
    });
    expect(profileSource).toBe("host-startup-snapshot");
    expect(profile.provider).toEqual({
      revisionSha256: snapshot.providerRevisionSha256,
      selection: snapshot.selection,
    });
    expect(profile.network).toEqual({ digestSha256: snapshot.networkDigestSha256 });
    expect(JSON.stringify(profile)).not.toContain("127.0.0.1:7890");
    expect(() =>
      parseNormalHostStartupSnapshot({ ...snapshot, httpProxy: "http://127.0.0.1:7890" }),
    ).toThrow(/unsupported field/);

    const options = parseArgs([
      "--workspace-allowlist",
      fixture.workspace,
      "--startup-snapshot",
      snapshotPath,
      "--output",
      join(fixture.workspace, "candidate"),
    ]);
    expect(options.startupSnapshot).toBe(snapshotPath);
    expect(options.providerProfile).toBeUndefined();
    expect(() =>
      parseArgs([
        "--workspace-allowlist",
        fixture.workspace,
        "--startup-snapshot",
        snapshotPath,
        "--provider-profile",
        fixture.providerProfilePath,
        "--network-profile",
        fixture.networkProfilePath,
      ]),
    ).toThrow(/cannot be combined/);
  });

  it("builds a profile from normalized snapshots and never archives credentials", async () => {
    const fixture = createFixture();
    const { profile, manifestSha256, launcherSha256 } = await createNormalHostNarrowProfile({
      narrowManifest: fixture.manifestPath,
      workspaceAllowlist: [fixture.workspace],
      providerProfile: fixture.providerProfilePath,
      networkProfile: fixture.networkProfilePath,
      testedMacOSVersion: "26.6.2",
    });

    expect(profile).toMatchObject({
      workspaceAllowlist: [fixture.workspace],
      provider: {
        revisionSha256: digestNormalHostProviderSnapshot(providerView()),
        selection: {
          providerId: "deepseek-anthropic",
          modelId: "deepseek-v3.2",
          options: { reasoningLevel: "high" },
        },
      },
      resourceManifest: { sha256: manifestSha256, launcherSha256 },
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain("must-not-be-archived");
    expect(serialized).not.toContain("also-secret");
    expect(serialized).not.toContain("Authorization");
  });

  it("requires the original prepared manifest instead of minting a pass manifest", () => {
    expect(() => requirePreparedNarrowManifestPath(undefined)).toThrow(
      /prepared cua-narrow manifest/,
    );
    expect(requirePreparedNarrowManifestPath("/tmp/prepared/manifest.json")).toBe(
      "/tmp/prepared/manifest.json",
    );
  });

  it("keeps default-disabled, placeholder, and candidate opt-in separate", () => {
    expect(NORMAL_HOST_CANDIDATE_RELEASE_FLAGS).toEqual({
      productDefaultDisabled: true,
      zcodeCuaPlaceholder: true,
      explicitCandidateOptIn: true,
    });
  });

  it("uses an independent fixed candidate UI identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "zody-normal-host-identity-"));
    createdRoots.push(root);
    const infoPlistPath = join(root, "Info.plist");
    const packageJsonPath = join(root, "package.json");
    writeFileSync(
      infoPlistPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleIdentifier</key><string>io.github.zclaudia.zody.preview</string>\n<key>CFBundleName</key><string>Zody Preview</string>\n<key>CFBundleDisplayName</key><string>Zody Preview</string>\n</dict></plist>\n`,
    );
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "@zody/desktop", main: "out/main/index.js" }),
    );
    const plutilCalls: string[][] = [];
    const helperRenameCalls: Array<[string, string, { sourceApplicationName: string }]> = [];

    const identity = await rewriteNormalHostCandidateAppIdentity({
      infoPlistPath,
      packageJsonPath,
      frameworksDir: join(root, "Frameworks"),
      sourceApplicationName: "Zody Preview",
      runPlutil: async (file, args) => {
        plutilCalls.push([file, ...args]);
      },
      renameHelpers: async (frameworksDir, applicationName, options) => {
        helperRenameCalls.push([frameworksDir, applicationName, options]);
        return [
          {
            from: "Zody Preview Helper.app",
            to: `${NORMAL_HOST_CANDIDATE_DISPLAY_NAME} Helper.app`,
            executable: { path: "fixture", bytes: 1, sha256: "a".repeat(64) },
          },
        ];
      },
    });

    expect(NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME).toBe("Zody CUA Normal Host Candidate.app");
    expect(NORMAL_HOST_CANDIDATE_DISPLAY_NAME).toBe("Zody CUA Normal Host Candidate");
    expect(NORMAL_HOST_CANDIDATE_BUNDLE_ID).toBe(
      "io.github.zclaudia.zody.cua-normal-host-candidate",
    );
    expect(plutilCalls).toEqual([
      [
        "/usr/bin/plutil",
        "-replace",
        "CFBundleIdentifier",
        "-string",
        NORMAL_HOST_CANDIDATE_BUNDLE_ID,
        infoPlistPath,
      ],
      [
        "/usr/bin/plutil",
        "-replace",
        "CFBundleName",
        "-string",
        NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
        infoPlistPath,
      ],
      [
        "/usr/bin/plutil",
        "-replace",
        "CFBundleDisplayName",
        "-string",
        NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
        infoPlistPath,
      ],
    ]);
    expect(JSON.parse(readFileSync(packageJsonPath, "utf8"))).toMatchObject({
      name: NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
      main: "out/main/index.js",
    });
    expect(helperRenameCalls).toEqual([
      [
        join(root, "Frameworks"),
        NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
        { sourceApplicationName: "Zody Preview" },
      ],
    ]);
    expect(identity.chromiumHelpers).toHaveLength(1);
  });

  it("parses a manifest option but assembly still requires an original", () => {
    const fixture = createFixture();
    const options = parseArgs([
      "--workspace-allowlist",
      fixture.workspace,
      "--provider-profile",
      fixture.providerProfilePath,
      "--network-profile",
      fixture.networkProfilePath,
      "--app-shell",
      join(fixture.workspace, "Zody Preview.app"),
      "--output",
      join(fixture.workspace, "candidate"),
    ]);
    expect(options.narrowManifest).toBeUndefined();
    expect(() => requirePreparedNarrowManifestPath(options.narrowManifest)).toThrow(
      /prepared cua-narrow manifest/,
    );
  });
});
