import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CUA_NARROW_APP_NAME,
  CUA_NARROW_LAUNCHER_RELATIVE_PATH,
  CUA_NARROW_RESOURCES_SLOT,
  NARROW_PROFILE_SCHEMA_VERSION,
  NORMAL_HOST_CANDIDATE_APP_BUNDLE_NAME,
  NORMAL_HOST_CANDIDATE_BUNDLE_ID,
  NORMAL_HOST_CANDIDATE_DISPLAY_NAME,
  NORMAL_HOST_CANDIDATE_PACKAGE_NAME,
  NORMAL_HOST_CANDIDATE_RELEASE_FLAGS,
  createNormalHostNarrowProfile,
  assertShellNarrowLauncherMatches,
  resolveShellLayout,
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

function createFixture(manifestPatch: object = {}) {
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
    ...manifestPatch,
  };
  const manifestPath = join(resourcesPath, CUA_NARROW_RESOURCES_SLOT, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath, manifest, launcherPath, resourcesPath };
}

describe("normal Host candidate startup profile (schemaVersion 2)", () => {
  it("builds a v2 profile from the prepared manifest alone", async () => {
    const fixture = createFixture();
    const { profile, manifestSha256, launcherSha256 } = await createNormalHostNarrowProfile({
      narrowManifest: fixture.manifestPath,
    });

    expect(profile).toEqual({
      kind: "zody-cua-narrow-agent-profile",
      schemaVersion: NARROW_PROFILE_SCHEMA_VERSION,
      capability: "screenshot.single-window",
      minimumTarget: { os: "darwin", arch: "arm64", minimumMacOSVersion: "14.2" },
      resourceManifest: { sha256: manifestSha256, launcherSha256 },
    });
    expect(manifestSha256).toBe(sha256(readFileSync(fixture.manifestPath)));
    expect(launcherSha256).toBe(fixture.manifest.identity.signedBinarySha256);
    // v2 profile 不携带任何构建机事实（路径/provider/network）。
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toMatch(/workspaceAllowlist|provider|network|root|Users\//);
  });

  it("rejects manifests whose minimum macOS floor diverges from the pinned constant", async () => {
    const fixture = createFixture({
      target: { os: "darwin", arch: "arm64", minimumMacOSVersion: "12.0" },
    });
    await expect(
      createNormalHostNarrowProfile({ narrowManifest: fixture.manifestPath }),
    ).rejects.toMatchObject({ code: "normal-host-manifest-target" });
  });

  it("resolves the shell layout and asserts the shell launcher matches the manifest", async () => {
    const fixture = createFixture();
    const layout = resolveShellLayout(join(fixture.root, "Shell.app"));
    expect(layout.narrowManifestPath).toBe(
      join(fixture.root, "Shell.app", "Contents", "Resources", CUA_NARROW_RESOURCES_SLOT, "manifest.json"),
    );
    // 壳内 launcher 与 manifest 摘要一致时通过，不一致时显式失败。
    const prepared = await createNormalHostNarrowProfile({
      narrowManifest: fixture.manifestPath,
    });
    const shellRoot = mkdtempSync(join(tmpdir(), "zody-normal-host-shell-"));
    createdRoots.push(shellRoot);
    const shellLayout = resolveShellLayout(join(shellRoot, "Shell.app"));
    mkdirSync(dirname(shellLayout.launcherPath), { recursive: true });
    writeFileSync(shellLayout.launcherPath, "signed-launcher");
    await expect(
      assertShellNarrowLauncherMatches(shellLayout, prepared.launcherSha256),
    ).resolves.toBe(prepared.launcherSha256);
    writeFileSync(shellLayout.launcherPath, "tampered");
    await expect(
      assertShellNarrowLauncherMatches(shellLayout, prepared.launcherSha256),
    ).rejects.toMatchObject({ code: "normal-host-shell-launcher" });
  });

  it("requires the original prepared manifest instead of minting a pass manifest", () => {
    expect(() => requirePreparedNarrowManifestPath(undefined)).toThrow(
      /prepared cua-narrow manifest/,
    );
    expect(requirePreparedNarrowManifestPath("/tmp/prepared/manifest.json")).toBe(
      "/tmp/prepared/manifest.json",
    );
  });

  it("drops the v1 machine-bound CLI inputs and rejects them as unknown arguments", () => {
    const fixture = createFixture();
    const options = parseArgs([
      "--app-shell",
      join(fixture.root, "Zody Preview.app"),
      "--output",
      join(fixture.root, "candidate"),
    ]);
    expect(options.narrowManifest).toBeUndefined();
    expect(() => requirePreparedNarrowManifestPath(options.narrowManifest)).toThrow(
      /prepared cua-narrow manifest/,
    );

    for (const flag of [
      "--workspace-allowlist",
      "--startup-snapshot",
      "--provider-profile",
      "--network-profile",
      "--tested-macos-version",
    ]) {
      expect(() => parseArgs([flag, "/tmp/value"])).toThrow(/Unknown argument/);
    }
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
});
