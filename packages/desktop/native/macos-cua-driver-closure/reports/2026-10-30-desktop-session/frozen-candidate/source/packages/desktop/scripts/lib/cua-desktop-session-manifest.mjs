// 构建清单与 CLI 报告的纯输出 helper；入口只保留编排，避免超过行数上限。
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_BINARY_NAME,
  APP_NAME,
  BUNDLE_ID,
  ENTRY_NAMES,
  FIXED_ARCH,
  FIXED_DEPLOYMENT_TARGET,
} from "./cua-desktop-session-config.mjs";
import { sha256File } from "./cua-desktop-session-toolchain.mjs";

export async function createBuildManifest(context) {
  return {
    schemaVersion: 1,
    kind: "zody-cua-desktop-session-native-candidate",
    status: "pass",
    generatedAt: new Date().toISOString(),
    unsigned: true,
    defaultDisabled: true,
    placeholderDefault: true,
    signing: {
      performed: false,
      acceptance: "blocked",
      reason: "builder does not sign, alter certificates/TCC, request UI grant, or capture",
    },
    interface: {
      stdin: "sealed ESM until EOF",
      fd3: "native<->entry NDJSON control; session-ready first",
      fd5: "host bridge",
      fd6: "CLI input",
      fd7: "CLI output",
      fd4: "reserved",
      entryAllowlist: ENTRY_NAMES,
      bootstrapPayload: "{}",
      captureResultDirection: "native->TS same authority connection, after real release",
      nodeSpawn: {
        argv: ["--jitless", "--no-warnings", "--input-type=module"],
        stdout: "explicitly inherited under POSIX_SPAWN_CLOEXEC_DEFAULT",
        stderr: "explicitly inherited under POSIX_SPAWN_CLOEXEC_DEFAULT",
        order: "spawn -> verify loaded code for actual child PID -> write sealed JS to stdin",
      },
    },
    outputRoot: context.outputRoot,
    app: { name: APP_NAME, path: `helper/${APP_NAME}`, bundleIdentifier: BUNDLE_ID },
    toolchain: context.toolchain,
    node: {
      path: context.nodePath,
      sha256: context.nodeSha256,
      version: context.nodeVersion,
      license: context.nodeLicensePresent ? "licenses/node-LICENSE.txt" : "missing",
    },
    identityPins: { path: context.identityPinsPath, values: context.identityPins },
    sourceStage: context.stageReport,
    entries: context.entries.map((entry) => ({
      name: entry.name,
      path: `Contents/Resources/${entry.name}`,
      sha256: entry.sha256,
      bytes: entry.bytes,
      maxBytes: entry.maxBytes,
      inputCount: entry.inputCount,
      runtimeExternals: entry.runtimeExternals,
      webAssemblyReferences: entry.webAssemblyReferences,
      licenses: entry.licenses
        ? {
            packageCount: entry.licenses.packageCount,
            missing: entry.licenses.missing,
          }
        : undefined,
    })),
    entryPins: context.entryPins,
    auxiliaryResources: context.auxiliaryResources.map((resource) => ({
      name: resource.name,
      path: `Contents/Resources/${resource.name}`,
      sha256: resource.sha256,
      bytes: resource.bytes,
      maxBytes: resource.maxBytes,
      capability: resource.capability,
      inputCount: resource.inputCount,
      runtimeExternals: resource.runtimeExternals,
      webAssemblyReferences: resource.webAssemblyReferences,
      licenses: resource.licenses
        ? {
            packageCount: resource.licenses.packageCount,
            missing: resource.licenses.missing,
          }
        : undefined,
    })),
    embeddedResources: Object.fromEntries(
      Object.entries(context.embeddedResources).map(([key, resource]) => [
        key,
        {
          name: resource.name,
          sha256: resource.sha256,
          bytes: resource.bytes,
          maxBytes: resource.maxBytes,
          inputCount: resource.inputCount,
          runtimeExternals: resource.runtimeExternals,
          webAssemblyReferences: resource.webAssemblyReferences,
          licenses: resource.licenses
            ? {
                packageCount: resource.licenses.packageCount,
                missing: resource.licenses.missing,
              }
            : undefined,
          embeddedIn: "host-entry.mjs",
        },
      ]),
    ),
    candidateFetch: context.candidateFetch,
    acceptance: {
      nativeBuild: "pass",
      nativeTests: context.runTests ? "pass" : "not-run",
      signedHostStartup: "not-verified-by-builder",
      signedHostFullLoad: "blocked",
      reason:
        "controller signed-host evidence showed a Node WebAssembly failure; hello or immediate Dispose is not full Host load evidence, and the builder cannot sign or run the Host",
      requiredEvidence:
        "controller signed app start plus a real Host session/tool/network flow; native builder alone cannot supply it",
      licenseInventory:
        "real missing licenses retained per entry/embedded resource; this build does not claim zero missing",
    },
    runtimeCompatibility: {
      nodeMode: "--jitless",
      webAssemblyAvailable: false,
      hostLoad: {
        status: "blocked",
        reason:
          "host sealed bundle still contains WebAssembly references; under --jitless they must not be reached at import or request time, and the builder does not claim full Host load",
      },
      networkAdapter:
        "real node-fetch@3.3.2 installed by host-entry/cli-entry before startup; proxy/custom CA explicitly rejected, no silent direct fallback",
      evidence: "output/cua-desktop-session/independent-checks/signed-host-recheck.json",
    },
    closureBoundary: {
      pureJavaScript: "inlined by esbuild; no runtime package resolution",
      runtimeExternals: [...new Set(context.entries.flatMap((entry) => entry.runtimeExternals))].sort(),
      requireBase: "process.execPath (signed Node), never process.cwd()",
      nodeReplCell: {
        serverPathSource:
          "process.execPath sibling node-repl-server.mjs, sha256 verified by cli-entry",
        toctou: "hash verification and cell exec are separate path operations; not closed this round",
        authorityFd: "cell does not inherit the authority fd; per-call broker capability only",
        claim: "not full D06 isolation",
      },
      unsupportedNativeCapabilities: Object.fromEntries(
        Object.entries(context.unsupportedModules).map(([name, value]) => [
          name,
          { capability: value.capability, shim: value.path, sha256: value.sha256 },
        ]),
      ),
      notClaimed: [
        "full Host dependency closure",
        "node-pty terminal",
        "ssh2 remote transport",
        "optional native ws accelerators",
        "Node builtin fetch/undici model-session network readiness under --jitless",
        "full D06 cell isolation",
        "signed or TCC-authorized acceptance",
      ],
    },
    build: {
      command: [context.toolchain.compiler.path, ...context.compileArgs].join(" "),
      warnings: context.compileResult.stderr.trim(),
      target: { architecture: FIXED_ARCH, minimumMacOSVersion: FIXED_DEPLOYMENT_TARGET },
    },
    artifact: {
      path: `helper/${APP_NAME}/Contents/MacOS/${APP_BINARY_NAME}`,
      absolutePath: context.finalBinary,
      sha256: await sha256File(context.finalBinary),
      sizeBytes: (await stat(context.finalBinary)).size,
      architectures: context.finalArtifact.architectures,
      minosValues: context.finalArtifact.minos,
      rpaths: context.finalArtifact.rpaths,
      linked: context.finalArtifact.linked,
    },
    resources: {
      staticlib: { path: context.staticlib, sha256: await sha256File(context.staticlib) },
      visualHeader: {
        path: context.visualHeader,
        sha256: await sha256File(context.visualHeader),
      },
      infoPlist: {
        path: context.infoPlistPath,
        sha256: await sha256File(context.infoPlistPath),
      },
      pinsHeader: {
        path: context.persistedPinsPath,
        sha256: await sha256File(context.persistedPinsPath),
        note: "build stage only; not distributed",
      },
      entryAuditRoot: context.auditRoot,
    },
    tests: context.testResults,
  };
}

export async function writeBuildManifest(buildRoot, manifest) {
  await writeFile(join(buildRoot, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function summarizeBuildManifest(manifest) {
  return {
    status: "pass",
    outputRoot: manifest.outputRoot,
    artifact: manifest.artifact.absolutePath,
    artifactSha256: manifest.artifact.sha256,
    architectures: manifest.artifact.architectures,
    minimumMacOSVersion:
      manifest.build.target?.minimumMacOSVersion ?? FIXED_DEPLOYMENT_TARGET,
    entries: manifest.entries.map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      sha256: entry.sha256,
    })),
    runtimeExternals: manifest.closureBoundary.runtimeExternals,
    acceptance: manifest.acceptance,
    runtimeCompatibility: manifest.runtimeCompatibility,
    candidateFetch: {
      name: manifest.candidateFetch.name,
      version: manifest.candidateFetch.version,
      license: manifest.candidateFetch.license,
      installedBy: manifest.candidateFetch.installedBy,
      bundledIn: manifest.candidateFetch.bundledIn,
    },
    auxiliaryResources: manifest.auxiliaryResources.map((resource) => ({
      name: resource.name,
      bytes: resource.bytes,
      sha256: resource.sha256,
    })),
    embeddedResources: Object.fromEntries(
      Object.entries(manifest.embeddedResources).map(([key, resource]) => [
        key,
        { name: resource.name, bytes: resource.bytes, sha256: resource.sha256 },
      ]),
    ),
    tests: manifest.tests.map((test) => `${test.name}:${test.status}`),
  };
}
