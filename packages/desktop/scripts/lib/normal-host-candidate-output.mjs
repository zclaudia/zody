// Candidate output verification and manifests. These helpers do not own staging creation,
// cleanup, or final rename; the outer assembly transaction remains the only lifecycle owner.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256File } from "../macos-cua-narrow-resources-base.mjs";
import { listAppAsarFiles } from "./normal-host-candidate-asar.mjs";
import { sha256Tree } from "./cua-desktop-candidate-app-files.mjs";
import { NORMAL_HOST_CANDIDATE_RELEASE_FLAGS } from "./normal-host-candidate-identity.mjs";

export function createPublicBuildEvidence(buildEvidence, finalPath) {
  return {
    directory: finalPath(buildEvidence.directory),
    inputs: finalPath(buildEvidence.inputsPath),
    inputsSha256: buildEvidence.inputsSha256,
    builds: Object.fromEntries(
      Object.entries(buildEvidence.builds).map(([name, entry]) => [
        name,
        {
          metafile: finalPath(join(buildEvidence.directory, entry.metafile)),
          metafileSha256: entry.metafileSha256,
          inputCount: entry.inputs.length,
        },
      ]),
    ),
  };
}

export async function writePackagedNarrowManifest({ destination, bytes, expectedSha256 }) {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o600 });
  if ((await sha256File(destination)) !== expectedSha256) {
    throw new Error("packaged cua-narrow manifest does not match the build profile");
  }
}

export async function verifyRepackedAsar({
  appAsarPath,
  sourceAppAsarUnpackedPath,
  copiedAppAsarUnpackedPath,
}) {
  const asarFiles = listAppAsarFiles(appAsarPath);
  for (const required of [
    "/package.json",
    "/out/main/index.js",
    "/out/host/index.js",
    "/out/scheduler/index.js",
    "/out/renderer/index.html",
    "/out/preload/index.cjs",
  ]) {
    if (!asarFiles.includes(required)) throw new Error(`repacked app.asar lacks ${required}`);
  }
  if (!asarFiles.some((entry) => entry.startsWith("/node_modules/"))) {
    throw new Error("repacked app.asar lacks runtime node_modules");
  }

  const nodePtyHelperRelativePath = join(
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  const sourceNodePtyHelperInfo = await stat(
    join(sourceAppAsarUnpackedPath, nodePtyHelperRelativePath),
  );
  const nodePtyHelperInfo = await stat(join(copiedAppAsarUnpackedPath, nodePtyHelperRelativePath));
  if ((sourceNodePtyHelperInfo.mode & 0o777) !== (nodePtyHelperInfo.mode & 0o777)) {
    throw new Error("node-pty spawn-helper mode changed during app.asar repack");
  }
  return { asarFiles, nodePtyHelperInfo };
}

export async function writeHostProfile({ staging, prepared, narrowManifestPath }) {
  const hostProfileSource = `${JSON.stringify(
    {
      profile: prepared.profile,
      generatedManifest: false,
      sourceManifest: narrowManifestPath,
      manifestSha256: prepared.manifestSha256,
      launcherSha256: prepared.launcherSha256,
      normalizedNetworkDigest: prepared.networkDigestSha256,
      profileSource: prepared.profileSource,
    },
    null,
    2,
  )}\n`;
  await writeFile(join(staging, "host-profile.json"), hostProfileSource, { mode: 0o600 });
}

export function createAppAsarManifestFacts({ entries, integrity }) {
  return {
    entries,
    algorithm: integrity.algorithm,
    headerBytes: integrity.headerBytes,
    headerSha256: integrity.headerSha256,
    archiveBytes: integrity.archiveBytes,
    archiveSha256: integrity.archiveSha256,
    embeddedIntegrityUpdated: true,
  };
}

function finalizeCandidateUiIdentity(candidateUiIdentity, finalPath) {
  return {
    ...candidateUiIdentity,
    chromiumHelpers: candidateUiIdentity.chromiumHelpers.map((helper) => ({
      ...helper,
      executable: {
        ...helper.executable,
        path: finalPath(helper.executable.path),
      },
    })),
  };
}

export async function buildNormalHostCandidateManifest({
  options,
  appBundle,
  copiedLayout,
  parsedPackageJson,
  candidateUiIdentity,
  prepared,
  manifestDestination,
  reused,
  packageNames,
  appDir,
  entries,
  asarIntegrity,
  asarFiles,
  nodePtyHelperInfo,
  publicBuildEvidence,
  finalPath,
}) {
  return {
    schemaVersion: 1,
    kind: "zody-normal-utility-host-candidate",
    generatedAt: new Date().toISOString(),
    builderSigned: false,
    launchedUi: false,
    requestedTcc: false,
    ...NORMAL_HOST_CANDIDATE_RELEASE_FLAGS,
    host: {
      kind: "normal-electron-utility-host",
      sourceRebuilt: true,
      entrypoints: {
        main: "src/main/index.ts",
        host: "src/host/index.ts",
        scheduler: "src/scheduler/index.ts",
      },
    },
    app: {
      shell: options.appShell,
      bundle: finalPath(appBundle),
      appAsar: finalPath(copiedLayout.appAsarPath),
      appAsarUnpacked: finalPath(copiedLayout.appAsarUnpackedPath),
      packageMain: parsedPackageJson.main,
      identity: finalizeCandidateUiIdentity(candidateUiIdentity, finalPath),
    },
    buildProfile: {
      kind: prepared.profile.kind,
      schemaVersion: prepared.profile.schemaVersion,
      capability: prepared.profile.capability,
      testedTarget: prepared.profile.testedTarget,
      workspaceAllowlist: prepared.profile.workspaceAllowlist,
      provider: prepared.profile.provider,
      network: prepared.profile.network,
      resourceManifest: prepared.profile.resourceManifest,
      manifestPath: finalPath(manifestDestination),
      profileSource: prepared.profileSource,
    },
    compiled: {
      main: await compiledEntry(entries.main, "main", appDir),
      host: await compiledEntry(entries.host, "host", appDir),
      scheduler: await compiledEntry(entries.scheduler, "scheduler", appDir),
    },
    reusedRenderAssets: reused,
    runtimeNodeModules: {
      source: "app.asar:node_modules",
      complete: true,
      externalSymlinks: 0,
      topLevelEntries: packageNames.length,
    },
    appAsar: createAppAsarManifestFacts({ entries: asarFiles.length, integrity: asarIntegrity }),
    nativeUnpacked: {
      nodePtySpawnHelperMode: (nodePtyHelperInfo.mode & 0o777).toString(8).padStart(4, "0"),
      modePreservedFromShell: true,
    },
    buildEvidence: publicBuildEvidence,
    trustBoundaries: {
      hostOrigin: "ordinary-host-untrusted-transport",
      nativeApproval: "per-capture-native-confirmation",
      hostIdsAreRoutingOnly: true,
      taskTimeProviderGuard: false,
      liveTaskConfigCompatibility: "not-proven",
      fullCliCompatibility: "not-proven",
    },
    notes: [
      "Building this candidate does not sign it, install it, request TCC, launch the UI, or prove a real screenshot.",
      "The controller must sign, perform UI/runtime checks, and run the real capture.",
    ],
  };
}

async function compiledEntry(entry, name, appDir) {
  return {
    path: `app.asar:out/${name}/index.js`,
    bytes: entry.bytes,
    sha256: entry.sha256,
    source: "workspace-source",
    tree: await sha256Tree(join(appDir, "out", name)),
  };
}

export async function writeCandidateManifest({ staging, candidateManifest }) {
  const candidateManifestSource = `${JSON.stringify(candidateManifest, null, 2)}\n`;
  if (candidateManifestSource.includes(staging)) {
    throw new Error("candidate manifest still contains a staging path");
  }
  await writeFile(join(staging, "normal-host-candidate-manifest.json"), candidateManifestSource, {
    mode: 0o600,
  });
}
