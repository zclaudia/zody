import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_ARGUMENTS,
  DEFAULT_ARTIFACT_ROOT,
  EXPECTED_TOOLCHAIN,
  MANIFEST_KIND,
  NATIVE_ROOT,
  NATIVE_SOURCE_RELATIVE_FILES,
  PRODUCT,
  sha256File,
  validateManifestSchema,
} from "../scripts/lib/cua-helper-diagnostic-core.mjs";
import {
  parseHealthOutput,
  validateArtifactBeforeExecution,
} from "../scripts/lib/cua-helper-diagnostic-verify.mjs";
import {
  assertMachOFacts,
  parseLinkedDependencies,
} from "../scripts/lib/cua-helper-diagnostic-artifacts.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const INFO_SOURCE = join(NATIVE_ROOT, "Info.plist");
const TEST_LICENSE = "Apache License 2.0 fixture\n";
const TEST_STDLIB_LICENSE = "Rust standard library license fixture\n";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function makeTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "zody-cua-helper-diagnostic-test-"));
  tempDirs.push(directory);
  return directory;
}

async function sourceHashes() {
  return Promise.all(
    NATIVE_SOURCE_RELATIVE_FILES.map(async (relativePath) => ({
      path: relativePath,
      sha256: await sha256File(join(NATIVE_ROOT, relativePath)),
    })),
  );
}

function manifestFixture({
  infoPlistSha256,
  executableSha256,
  sources,
}: {
  infoPlistSha256: string;
  executableSha256: string;
  sources: Array<{ path: string; sha256: string }>;
}) {
  return {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    status: "pass",
    diagnosticOnly: true,
    driverLinked: false,
    generatedAt: "2026-10-27T00:00:00.000Z",
    product: {
      name: PRODUCT.name,
      bundleId: PRODUCT.bundleId,
      shortVersion: PRODUCT.shortVersion,
      bundleVersion: PRODUCT.bundleVersion,
      minimumMacOSVersion: PRODUCT.minimumMacOSVersion,
      runtimeSupportVerified: false,
    },
    artifact: {
      relativePath: PRODUCT.appName,
      infoPlistRelativePath: "Contents/Info.plist",
      executableRelativePath: `Contents/MacOS/${PRODUCT.name}`,
      infoPlistSha256,
      executableSha256,
      architecture: "arm64",
      minimumMacOS: "12.0",
    },
    build: {
      target: "aarch64-apple-darwin",
      deploymentTarget: "12.0",
      cargoArguments: [
        "build",
        "--locked",
        "--offline",
        "--release",
        "--target",
        "aarch64-apple-darwin",
      ],
      isolatedCargoHome: true,
      environmentPolicy: "allowlist",
      cargoConfigIsolation: {
        sourceCopyOutsideRepo: true,
        cwdOutsideRepo: true,
        cargoHomeConfigPresent: false,
        ancestorConfigFilesFound: [],
      },
    },
    arguments: {
      accepted: [...ACCEPTED_ARGUMENTS],
      exitCodes: { success: 0, invalidArguments: 2 },
    },
    sources,
    toolchain: {
      selected: "stable",
      rustc: { release: EXPECTED_TOOLCHAIN.rustVersion, commit: EXPECTED_TOOLCHAIN.rustCommit },
      cargo: { release: EXPECTED_TOOLCHAIN.cargoVersion, commit: EXPECTED_TOOLCHAIN.cargoCommit },
      sysroot: "/fixture/sysroot",
      target: "aarch64-apple-darwin",
    },
    sdk: { path: "/fixture/sdk", version: "fixture" },
    dependencies: {
      stdOnly: true,
      driverLinked: false,
      crateDependencies: [],
      linkedDynamicLibraries: ["/usr/lib/libSystem.B.dylib"],
    },
    licenses: {
      firstParty: {
        spdx: "Apache-2.0",
        path: "Contents/Resources/LICENSE",
        sha256: "0".repeat(64),
      },
      rustStandardLibrary: {
        spdx: "Apache-2.0 OR MIT",
        path: "Contents/Resources/COPYRIGHT-library.html",
        sha256: "0".repeat(64),
      },
      thirdPartyCrates: [],
      thirdPartyCratesMeaning: "Cargo dependencies only; Rust std is separate.",
      closureComplete: false,
    },
    upstreamComparison: {
      declaredRustVersion: "1.97.1",
      buildRustVersion: EXPECTED_TOOLCHAIN.rustVersion,
      driverSourceIncluded: false,
      patchIncluded: false,
      licenseClosureComplete: false,
      status: "delta-not-closed",
    },
    signature: {
      binary: {
        kind: "unsigned",
        verified: false,
        identifier: null,
        teamIdentifier: null,
        cdhash: null,
        authorities: [],
      },
      app: {
        kind: "unsigned",
        verified: false,
        identifier: null,
        teamIdentifier: null,
        cdhash: null,
        authorities: [],
      },
      localSelfSignedClaim: false,
      signingPerformed: false,
    },
    health: {
      inputCapable: false,
      driverLinked: false,
      tccRequested: false,
      nativeCapabilityProven: false,
    },
    limits: {
      minosIsBuildTargetOnly: true,
      nativeCapabilityProven: false,
      d06IsolationProven: false,
      defaultLauncherWired: false,
    },
  };
}

async function createArtifactFixture({ tamperHash = false } = {}) {
  const root = await makeTempDir();
  const appPath = join(root, PRODUCT.appName);
  const macos = join(appPath, "Contents", "MacOS");
  const resources = join(appPath, "Contents", "Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  const info = await readFile(INFO_SOURCE);
  const executable = Buffer.from("fixture executable\n", "utf8");
  await writeFile(join(appPath, "Contents", "Info.plist"), info);
  await writeFile(join(macos, PRODUCT.name), executable, { mode: 0o755 });
  await writeFile(join(resources, "LICENSE"), TEST_LICENSE);
  await writeFile(join(resources, "COPYRIGHT-library.html"), TEST_STDLIB_LICENSE);
  const infoPlistSha256 = await sha256File(join(appPath, "Contents", "Info.plist"));
  const executableSha256 = tamperHash
    ? "f".repeat(64)
    : await sha256File(join(macos, PRODUCT.name));
  const sources = await sourceHashes();
  const manifest = manifestFixture({ infoPlistSha256, executableSha256, sources });
  manifest.licenses.firstParty.sha256 = await sha256File(join(resources, "LICENSE"));
  manifest.licenses.rustStandardLibrary.sha256 = await sha256File(
    join(resources, "COPYRIGHT-library.html"),
  );
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, appPath, manifest };
}

describe("macOS CUA diagnostic contract", () => {
  it("pins the diagnostic product and default ignored output root", async () => {
    expect(PRODUCT).toMatchObject({
      name: "Zody Computer Use Diagnostic",
      bundleId: "io.github.zclaudia.zody.cua-helper-diagnostic",
      appName: "Zody Computer Use Diagnostic.app",
    });
    expect(DEFAULT_ARTIFACT_ROOT).toBe(
      join(REPO_ROOT, "output", "cua-helper-diagnostic", "darwin-arm64"),
    );
    expect(await readFile(join(REPO_ROOT, ".gitignore"), "utf8")).toMatch(/^\/output\/$/m);
  });

  it("pins Rust 1.93.1 and a std-only locked source tree", async () => {
    expect(EXPECTED_TOOLCHAIN).toMatchObject({
      rustVersion: "1.93.1",
      rustCommit: "01f6ddf7588f42ae2d7eb0a2f21d44e8e96674cf",
      cargoVersion: "1.93.1",
      cargoCommit: "083ac5135f967fd9dc906ab057a2315861c7a80d",
    });
    const cargoToml = await readFile(join(NATIVE_ROOT, "Cargo.toml"), "utf8");
    const cargoLock = await readFile(join(NATIVE_ROOT, "Cargo.lock"), "utf8");
    const toolchain = await readFile(join(NATIVE_ROOT, "rust-toolchain.toml"), "utf8");
    expect(cargoToml).toContain('edition = "2024"');
    expect(cargoToml).toContain('license = "Apache-2.0"');
    expect(cargoToml).not.toMatch(/^\[dependencies\]/m);
    expect(cargoLock).not.toContain('source = "registry');
    expect(cargoLock).not.toContain("checksum =");
    expect(toolchain).toContain('channel = "1.93.1"');
  });

  it("pins bundle identity and only diagnostic arguments", async () => {
    const info = await readFile(INFO_SOURCE, "utf8");
    expect(info).toContain("<string>io.github.zclaudia.zody.cua-helper-diagnostic</string>");
    expect(info).toContain("<string>Zody Computer Use Diagnostic</string>");
    expect(info).toContain("<string>12.0</string>");
    expect(ACCEPTED_ARGUMENTS).toEqual(["--health", "--help", "--version"]);
  });
});

describe("manifest schema", () => {
  it("rejects missing or unknown manifest facts", async () => {
    expect(validateManifestSchema({}).ok).toBe(false);
    const { manifest } = await createArtifactFixture();
    expect(validateManifestSchema(manifest).ok).toBe(true);
    expect(validateManifestSchema({ ...manifest, kind: "other" }).ok).toBe(false);
    expect(validateManifestSchema({ ...manifest, driverLinked: true }).ok).toBe(false);
    expect(
      validateManifestSchema({
        ...manifest,
        product: { ...manifest.product, runtimeSupportVerified: true },
      }).ok,
    ).toBe(false);
    expect(
      validateManifestSchema({
        ...manifest,
        licenses: { ...manifest.licenses, closureComplete: true },
      }).ok,
    ).toBe(false);
    expect(
      validateManifestSchema({
        ...manifest,
        limits: { ...manifest.limits, d06IsolationProven: true },
      }).ok,
    ).toBe(false);
    expect(
      validateManifestSchema({
        ...manifest,
        signature: { ...manifest.signature, signingPerformed: true },
      }).ok,
    ).toBe(false);
    expect(
      validateManifestSchema({
        ...manifest,
        sources: manifest.sources.filter((source) => source.path !== "rust-toolchain.toml"),
      }).ok,
    ).toBe(false);
  });
});

describe("artifact validation before execution", () => {
  it("rejects every non-system otool dependency including @rpath and spaces", () => {
    const output = [
      "/tmp/Zody Diagnostic:",
      "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1343.0.0)",
      "\t@rpath/Driver With Spaces.dylib (compatibility version 1.0.0, current version 2.0.0)",
      "\t@loader_path/libinput.dylib (compatibility version 1.0.0, current version 3.0.0)",
    ].join("\n");
    expect(parseLinkedDependencies(output)).toEqual([
      "/usr/lib/libSystem.B.dylib",
      "@rpath/Driver With Spaces.dylib",
      "@loader_path/libinput.dylib",
    ]);
    expect(() =>
      assertMachOFacts({
        architectures: ["arm64"],
        minimumMacOS: "12.0",
        linkedDynamicLibraries: parseLinkedDependencies(output),
      }),
    ).toThrow(/non-system/);
    expect(() =>
      assertMachOFacts({
        architectures: ["arm64"],
        minimumMacOS: "12.0",
        linkedDynamicLibraries: ["/usr/lib/../private/Driver.dylib"],
      }),
    ).toThrow(/non-system/);
  });

  it("fails on missing artifacts without spawning", async () => {
    const root = await makeTempDir();
    await expect(validateArtifactBeforeExecution({ artifactRoot: root })).rejects.toThrow(
      /manifest/i,
    );
  });

  it("fails on schema errors without spawning", async () => {
    const { root } = await createArtifactFixture();
    await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    await expect(validateArtifactBeforeExecution({ artifactRoot: root })).rejects.toThrow(
      /schema/i,
    );
  });

  it("fails on executable hash tamper without spawning", async () => {
    const { root } = await createArtifactFixture({ tamperHash: true });
    await expect(validateArtifactBeforeExecution({ artifactRoot: root })).rejects.toThrow(
      /executable.*sha256/i,
    );
  });

  it("rejects a symlinked app before hashing or spawning", async () => {
    const { root, appPath } = await createArtifactFixture();
    const redirected = join(root, "redirected.app");
    await rename(appPath, redirected);
    await symlink(redirected, appPath);
    await expect(validateArtifactBeforeExecution({ artifactRoot: root })).rejects.toThrow(
      /symlink/i,
    );
  });

  it("requires health to be explicitly non-capable", () => {
    expect(
      parseHealthOutput(
        JSON.stringify({
          schemaVersion: 1,
          kind: "zody-cua-helper-diagnostic-health",
          diagnosticOnly: true,
          inputCapable: false,
          driverLinked: false,
          tccRequested: false,
          stdinRead: false,
          networkUsed: false,
          applicationFileIoUsed: false,
          subprocessSpawned: false,
          systemInputUsed: false,
          nativeCapabilityProven: false,
        }),
      ),
    ).toMatchObject({ inputCapable: false, driverLinked: false, tccRequested: false });
    expect(() =>
      parseHealthOutput(
        JSON.stringify({
          schemaVersion: 1,
          kind: "zody-cua-helper-diagnostic-health",
          diagnosticOnly: true,
          inputCapable: true,
          driverLinked: false,
          tccRequested: false,
          stdinRead: false,
          networkUsed: false,
          applicationFileIoUsed: false,
          subprocessSpawned: false,
          systemInputUsed: false,
          nativeCapabilityProven: false,
        }),
      ),
    ).toThrow(/inputCapable/);
  });
});

it("has all required diagnostic source files", () => {
  for (const relativePath of NATIVE_SOURCE_RELATIVE_FILES) {
    expect(existsSync(join(NATIVE_ROOT, relativePath)), relativePath).toBe(true);
  }
  expect(dirname(NATIVE_ROOT)).toContain("native");
});
