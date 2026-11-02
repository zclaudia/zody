import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNormalHostCandidateManifest,
  writeCandidateManifest,
} from "../scripts/lib/normal-host-candidate-output.mjs";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zody-normal-host-manifest-"));
  createdRoots.push(root);
  return root;
}

function createCompiledEntries(appDir: string) {
  return Object.fromEntries(
    ["main", "host", "scheduler"].map((name) => {
      const outDir = join(appDir, "out", name);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "index.js"), `${name}\n`);
      return [name, { bytes: 1, sha256: "a".repeat(64) }];
    }),
  );
}

describe("normal Host candidate manifest identity", () => {
  it("normalizes every Chromium helper executable path to the final output", async () => {
    const root = createRoot();
    const staging = join(root, ".normal-host-candidate-fixture");
    const finalRoot = join(root, "normal-host-candidate-final");
    const appBundle = join(staging, "Zody CUA Normal Host Candidate.app");
    const appDir = join(staging, "app-runtime");
    const copiedLayout = {
      appAsarPath: join(appBundle, "Contents", "Resources", "app.asar"),
      appAsarUnpackedPath: join(appBundle, "Contents", "Resources", "app.asar.unpacked"),
    };
    const targetHelperName = "Zody CUA Normal Host Candidate Helper";
    const stagingExecutablePath = join(
      appBundle,
      "Contents",
      "Frameworks",
      `${targetHelperName}.app`,
      "Contents",
      "MacOS",
      targetHelperName,
    );
    const candidateUiIdentity = {
      appBundleName: "Zody CUA Normal Host Candidate.app",
      displayName: "Zody CUA Normal Host Candidate",
      bundleIdentifier: "io.github.zclaudia.zody.cua-normal-host-candidate",
      packageName: "zody-cua-normal-host-candidate",
      chromiumHelpers: [
        {
          from: "Zody Preview Helper.app",
          to: `${targetHelperName}.app`,
          executable: {
            path: stagingExecutablePath,
            bytes: 1234,
            sha256: "b".repeat(64),
            mode: "0755",
            entitlementsSha256: "c".repeat(64),
          },
        },
      ],
    };
    const finalPath = (path: string) => {
      const relativePath = relative(staging, path);
      if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        throw new Error(`candidate manifest path is outside staging: ${path}`);
      }
      return join(finalRoot, relativePath);
    };
    const candidateManifest = await buildNormalHostCandidateManifest({
      options: { appShell: join(root, "Zody Preview.app") },
      appBundle,
      copiedLayout,
      parsedPackageJson: { main: "out/main/index.js" },
      candidateUiIdentity,
      prepared: {
        profile: {
          kind: "zody-cua-narrow-agent-profile",
          schemaVersion: 1,
          capability: "screenshot.single-window",
          testedTarget: { os: "darwin", arch: "arm64" },
          workspaceAllowlist: [],
          provider: { revisionSha256: "d".repeat(64) },
          network: { digestSha256: "e".repeat(64) },
          resourceManifest: { sha256: "f".repeat(64) },
        },
        manifestSha256: "f".repeat(64),
        launcherSha256: "0".repeat(64),
        networkDigestSha256: "e".repeat(64),
        profileSource: "fixture",
      },
      manifestDestination: join(appBundle, "Contents", "Resources", "cua-narrow", "manifest.json"),
      reused: {},
      packageNames: ["node-pty"],
      appDir,
      entries: createCompiledEntries(appDir),
      asarIntegrity: {
        algorithm: "SHA256",
        headerBytes: 512,
        headerSha256: "1".repeat(64),
        archiveBytes: 4096,
        archiveSha256: "2".repeat(64),
      },
      asarFiles: ["/package.json"],
      nodePtyHelperInfo: { mode: 0o100755 },
      publicBuildEvidence: {
        directory: "build-evidence",
        inputs: "build-evidence/inputs.json",
        inputsSha256: "3".repeat(64),
        builds: {},
      },
      finalPath,
    });

    await writeCandidateManifest({ staging, candidateManifest });

    const manifestSource = readFileSync(
      join(staging, "normal-host-candidate-manifest.json"),
      "utf8",
    );
    const serialized = JSON.parse(manifestSource);
    const helper = serialized.app.identity.chromiumHelpers[0];
    const expectedExecutablePath = join(finalRoot, relative(staging, stagingExecutablePath));

    expect(manifestSource).not.toContain(staging);
    expect(helper.executable.path).toBe(expectedExecutablePath);
    expect(helper.executable).toMatchObject({
      bytes: 1234,
      sha256: "b".repeat(64),
      mode: "0755",
      entitlementsSha256: "c".repeat(64),
    });
    expect(helper).toMatchObject({
      from: "Zody Preview Helper.app",
      to: `${targetHelperName}.app`,
    });
  });
});
