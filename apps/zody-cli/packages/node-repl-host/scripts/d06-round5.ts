import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { arch, release, type } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { D06_EXPECTED_NODE } from "./d06-policy.js";
import { runPolicyLoadProbe } from "./d06-preflight.js";
import {
  judgeAbortProbe,
  judgeBrowserProbe,
  judgeDebuggerProbe,
  judgeFfiProbe,
  judgeIntegrityProbe,
  judgeNativeAddonProbe,
  type D06Round5CaseResult,
  type D06Round5Observation,
} from "./d06-round5-policy.js";
import { buildD06Round5Profile, describeRound5ProfileDelta } from "./d06-round5-profile.js";
import { buildNativeProbe, type KoffiStaged } from "./d06-round5-native.js";
import {
  createD06Round5Workspace,
  isD06Round5CleanupError,
  sha256File,
  type D06Round5Paths,
} from "./d06-round5-resources.js";
import {
  runIntegrityPrecheck,
  verifyThenExecute,
  type D06ResourceManifest,
} from "./d06-round5-manifest.js";
import {
  createRound5ProbeContext,
  runRound5Case,
  type D06Round5ProbeContext,
} from "./d06-round5-probe-common.js";
import { runNativeAddonProbe, runFfiProbe } from "./d06-round5-native-probes.js";
import { runBrowserProbe } from "./d06-round5-browser-probe.js";
import { runAbortProbe } from "./d06-round5-abort-probe.js";
import { runDebuggerProbe } from "./d06-round5-debugger-probe.js";
import {
  buildBrowserAssets,
  buildManifest,
  prepareKoffi,
  profileExtras,
  type BrowserAssets,
} from "./d06-round5-build-assets.js";
import {
  boundedCompile,
  createEvidence,
  finalize,
  judgeRound5Preflight,
  profileObservation,
  type DiagnosticEvidence,
} from "./d06-round5-evidence.js";
import {
  cleanupD06Workspace,
  errorCode,
  errorText,
  startD06FixtureServers,
  type D06FixtureServers,
} from "./d06-resources.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const execFileAsync = promisify(execFile);

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stderr.write("Usage: d06-round5 [--node <absolute-node-24.14.0-path>]\n");
    return 0;
  }
  const evidence = await collectEvidence(options.nodePath);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence.exitCode;
}

async function collectEvidence(requestedNodePath?: string): Promise<DiagnosticEvidence> {
  const evidence = createEvidence();
  evidence.host.os = { platform: process.platform, type: type(), release: release(), arch: arch() };
  let paths: D06Round5Paths | undefined;
  let servers: D06FixtureServers | undefined;
  let infrastructure: DiagnosticEvidence["infrastructure"];
  try {
    if (process.platform !== "darwin") throw new BlockedError("macOS is required for seatbelt");
    const nodePath = await realpath(resolve(requestedNodePath ?? process.execPath));
    const nodeVersion = await readNodeVersion(nodePath);
    evidence.host.node.selectedPath = nodePath;
    evidence.host.node.selectedVersion = nodeVersion;
    if (nodeVersion !== `v${D06_EXPECTED_NODE}`) {
      throw new BlockedError(`selected Node must be ${D06_EXPECTED_NODE}, got ${nodeVersion}`);
    }
    await access(SANDBOX_EXEC, constants.X_OK).catch(() => {
      throw new BlockedError("sandbox-exec is unavailable");
    });
    paths = await createD06Round5Workspace({
      indexPath: "/nonexistent/koffi-index.js",
      nativePath: "/nonexistent/koffi.node",
    });
    const koffi = await prepareKoffi(paths);
    evidence.toolchain = {
      koffi: koffi
        ? { source: koffi.source, staged: koffi.staged }
        : { available: false, reason: "koffi 2.15.6 files not found" },
    };
    const native = await buildNativeProbe({ paths, nodePath });
    evidence.native = {
      command: native.command,
      includeHeader: native.includeHeader,
      status: native.status,
      addon: native.addon,
      compile: boundedCompile(native.compile),
    };
    const builder = (await import(new URL("./build.mjs", import.meta.url).href)) as {
      buildNodeReplHostBundle(input: {
        outfile: string;
        cuaHelperBuildId: string;
      }): Promise<{ outfile: string }>;
    };
    const built = await builder.buildNodeReplHostBundle({
      outfile: paths.bundlePath,
      cuaHelperBuildId: "",
    });
    evidence.bundle = { path: built.outfile, ...(await sha256File(built.outfile)) };
    const browser = await buildBrowserAssets(paths);
    evidence.browserAssets = browser.evidence;
    const profile = buildD06Round5Profile(
      {
        nodePath,
        bundlePath: paths.bundlePath,
        canaryRoot: paths.root,
        docsDir: paths.browserDocsDir,
        docsFile: paths.browserApiPath,
        clientDir: paths.browserDocsDir,
        clientFile: paths.browserClientPath,
        browserSocketPath: paths.browserSocketPath,
      },
      profileExtras(paths, native.addon, koffi?.staged),
    );
    await writeFile(paths.profilePath, profile.text, "utf8");
    evidence.profile = {
      path: paths.profilePath,
      ...(await sha256File(paths.profilePath)),
      fullText: profile.text,
      delta: profile.delta,
      deltaDescription: describeRound5ProfileDelta(profile.delta),
    };
    try {
      servers = await startD06FixtureServers(paths);
    } catch (error) {
      throw new BlockedError(`synthetic fixture sockets unavailable: ${errorText(error)}`);
    }
    const manifest = await buildManifest(paths, native.addon?.path, koffi?.staged);
    evidence.resources = { manifest: manifest.entries, tcpPort: servers.tcpPort };
    const integrity = await runIntegrityPrecheck(paths.root, manifest);
    const integrityObservation: D06Round5Observation = {
      outcome: "allowed",
      stage: "verified",
      checks: integrity.checks,
      raw: { baseline: integrity.baseline, issues: integrity.issues },
    };
    evidence.integrity = integrity;
    const integrityCase = await runRound5Case(
      "r5-05-temporary-resource-integrity",
      "integrity",
      "verified",
      judgeIntegrityProbe,
      async () => integrityObservation,
    );
    evidence.cases.push(integrityCase);
    if (integrityCase.status !== "passed") {
      evidence.executionSkipped = "temporary resource integrity precheck did not pass";
    } else {
      const preflight = await runPolicyLoadProbe({
        sandboxExec: SANDBOX_EXEC,
        nodePath,
        profilePath: paths.profilePath,
        cwd: paths.root,
        expectedNodeVersion: D06_EXPECTED_NODE,
      });
      const profileCase = await runRound5Case(
        "r5-round5-profile-load",
        "integrity",
        "verified",
        judgeRound5Preflight,
        async () => profileObservation(preflight.observation),
      );
      profileCase.command = preflight.command;
      evidence.cases.push(profileCase);
      if (profileCase.status !== "passed") {
        evidence.executionSkipped = "round 5 profile preflight did not pass";
      } else {
        const round5Paths = paths;
        const fixtureServers = servers;
        if (!round5Paths || !fixtureServers) {
          throw new BlockedError("round 5 workspace or fixture server missing");
        }
        const guarded = await verifyThenExecute(manifest, async () => {
          await runProbes({
            evidence,
            paths: round5Paths,
            nodePath,
            servers: fixtureServers,
            native: native.addon,
            nativeObservation: native.observation,
            koffi: koffi?.staged,
            manifest,
            browser,
          });
          return true;
        });
        const guardCase = await runRound5Case(
          "r5-05-execution-guard",
          "integrity",
          "verified",
          (observed) =>
            observed.outcome === "allowed" && observed.checks?.["execute invoked"] === true
              ? { status: "passed", reason: "manifest re-verified immediately before execution" }
              : { status: "failed", reason: "manifest changed or execution was refused" },
          async () => ({
            outcome: guarded.executed ? "allowed" : "error",
            stage: "verified",
            checks: { "execute invoked": guarded.executed },
            raw: { issues: guarded.issues },
          }),
        );
        evidence.cases.push(guardCase);
        if (!guarded.executed) {
          evidence.executionSkipped = "resource manifest changed before execution";
        }
      }
    }
  } catch (error) {
    if (isD06Round5CleanupError(error)) {
      evidence.cleanup = { removed: false, error: error.message };
    }
    infrastructure = {
      phase: "setup",
      error: errorText(error),
      code: errorCode(error),
      blocked: error instanceof BlockedError || isMissingToolError(error),
    };
  } finally {
    if (!evidence.cleanup) {
      evidence.cleanup = await cleanupD06Workspace(paths, servers);
    }
  }
  return finalize(evidence, infrastructure);
}

async function runProbes(input: {
  evidence: DiagnosticEvidence;
  paths: D06Round5Paths;
  nodePath: string;
  servers: D06FixtureServers;
  native: { path: string; sha256: string; bytes: number } | undefined;
  nativeObservation: D06Round5Observation;
  koffi: KoffiStaged | undefined;
  manifest: D06ResourceManifest;
  browser: BrowserAssets;
}): Promise<void> {
  const context = createRound5ProbeContext({
    nodePath: input.nodePath,
    sandboxExec: SANDBOX_EXEC,
    paths: input.paths,
    tcpPort: input.servers.tcpPort,
    stats: input.servers.stats,
  });
  input.evidence.cases.push(
    await nativeCaseFor(context, input.native, input.nativeObservation),
    await ffiCase(context, input.koffi, input.manifest),
    await runRound5Case("r5-04-built-browser-client", "browser", "allowed", judgeBrowserProbe, () =>
      runBrowserProbe(context, input.browser.asset),
    ),
    await runRound5Case("r5-06-direct-cell-abort", "abort", "allowed", judgeAbortProbe, () =>
      runAbortProbe(context),
    ),
    await runRound5Case("r5-07-debugger-status", "debugger", "allowed", judgeDebuggerProbe, () =>
      runDebuggerProbe({ cwd: input.paths.root }),
    ),
  );
}

async function nativeCaseFor(
  context: D06Round5ProbeContext,
  addon: { path: string; sha256: string; bytes: number } | undefined,
  buildObservation: D06Round5Observation,
): Promise<D06Round5CaseResult> {
  return await runRound5Case(
    "r5-03-native-napi-c-probe",
    "native",
    "allowed",
    judgeNativeAddonProbe,
    async () => (addon ? await runNativeAddonProbe(context, addon) : buildObservation),
  );
}

async function ffiCase(
  context: D06Round5ProbeContext,
  koffi: KoffiStaged | undefined,
  manifest: D06ResourceManifest,
): Promise<D06Round5CaseResult> {
  return await runRound5Case(
    "r5-03-fixed-hash-ffi-probe",
    "ffi",
    "allowed",
    judgeFfiProbe,
    async () =>
      koffi
        ? await runFfiProbe(context, {
            indexPath: koffi.indexPath,
            nativePath: koffi.nativePath,
            indexSha256: manifestEntryHash(manifest, "koffi-index"),
            nativeSha256: manifestEntryHash(manifest, "koffi-native"),
          })
        : { outcome: "blocked", detail: "koffi 2.15.6 not installed" },
  );
}

function manifestEntryHash(manifest: D06ResourceManifest, id: string): string {
  const entry = manifest.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`resource manifest is missing ${id}`);
  return entry.sha256;
}

async function readNodeVersion(nodePath: string): Promise<string> {
  const { stdout } = await execFileAsync(nodePath, ["--version"], {
    timeout: 5_000,
    maxBuffer: 4096,
  });
  return stdout.trim();
}

function parseArgs(args: string[]): { help: boolean; nodePath?: string } {
  let nodePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--node") {
      nodePath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--node=")) {
      nodePath = arg.slice("--node=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { help: false, nodePath };
}

class BlockedError extends Error {}

function isMissingToolError(error: unknown): boolean {
  return /Cannot find package ['"]esbuild['"]|ERR_MODULE_NOT_FOUND/u.test(errorText(error));
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  },
);
