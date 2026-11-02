import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { arch, release, type } from "node:os";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  D06_BLOCKED_SCOPE,
  D06_EXPECTED_NODE,
  D06_GATE,
  buildSeatbeltProfile,
  decideFailureTests,
  decideExit,
  describeSeatbeltAllowlist,
  type D06CaseResult,
  type D06FailureTestResult,
} from "./d06-policy.js";
import { runPolicyLoadProbe } from "./d06-preflight.js";
import { createD06ProbeContext, runCase } from "./d06-probe-runtime.js";
import { runD06FailureTests } from "./d06-failure-tests.js";
import { runForkProbes } from "./d06-probes-fork.js";
import { runSeatbeltProbes, SEATBELT_CASE_MANIFEST } from "./d06-probes-seatbelt.js";
import {
  cleanupD06Workspace,
  createD06Workspace,
  errorCode,
  errorText,
  sha256File,
  startD06FixtureServers,
  writeD06Profile,
  type D06FixtureServers,
  type D06Paths,
} from "./d06-resources.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const execFileAsync = promisify(execFile);

interface DiagnosticEvidence {
  schemaVersion: 1;
  tool: "node-repl-d06-diagnostic";
  generatedAt: string;
  status: "satisfied" | "failed" | "blocked";
  exitCode: 0 | 1 | 2;
  d06Gate: typeof D06_GATE;
  reason: string;
  host: {
    node: {
      runtimeVersion: string;
      runtimeExecPath: string;
      selectedPath?: string;
      selectedVersion?: string;
      expected: string;
    };
    os: { platform: NodeJS.Platform; type: string; release: string; arch: string };
  };
  bundle?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  policy: { blockedScope: readonly string[]; network: string; noFallback: boolean };
  preflight?: Record<string, unknown>;
  cases: D06CaseResult[];
  failureTests: D06FailureTestResult[];
  summary: { total: number; passed: number; failed: number; blocked: number };
  failureSummary: { total: number; passed: number; failed: number; blocked: number };
  infrastructure?: { phase: string; error: string; code: string | null; blocked: boolean };
  cleanup?: { removed: boolean; error?: string };
  limitations: string[];
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stderr.write("Usage: d06-diagnostic [--node <absolute-node-24.14.0-path>]\n");
    return 0;
  }
  const evidence = await collectEvidence(options.nodePath);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence.exitCode;
}

async function collectEvidence(requestedNodePath?: string): Promise<DiagnosticEvidence> {
  const evidence: DiagnosticEvidence = {
    schemaVersion: 1,
    tool: "node-repl-d06-diagnostic",
    generatedAt: new Date().toISOString(),
    status: "blocked",
    exitCode: 2,
    d06Gate: D06_GATE,
    reason: "diagnostic did not complete",
    host: {
      node: {
        runtimeVersion: process.version,
        runtimeExecPath: process.execPath,
        expected: D06_EXPECTED_NODE,
      },
      os: { platform: process.platform, type: type(), release: release(), arch: arch() },
    },
    policy: {
      blockedScope: D06_BLOCKED_SCOPE,
      network: "exact synthetic Browser Unix socket only",
      noFallback: true,
    },
    cases: [],
    failureTests: [],
    summary: { total: 0, passed: 0, failed: 0, blocked: 0 },
    failureSummary: { total: 0, passed: 0, failed: 0, blocked: 0 },
    limitations: [
      "D06 remains blocked: this tool verifies only the implemented fork/sealtbelt matrix.",
      "Native addon/FFI, debugger attach, real browser, SEA and descendant reclamation are not verified.",
    ],
  };
  let paths: D06Paths | undefined;
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

    paths = await createD06Workspace();
    const profileInput = {
      nodePath,
      bundlePath: paths.bundlePath,
      canaryRoot: paths.root,
      docsDir: paths.docsDir,
      docsFile: paths.docsFile,
      clientDir: paths.clientDir,
      clientFile: paths.clientFile,
      browserSocketPath: paths.browserSocketPath,
    };
    const profileText = buildSeatbeltProfile(profileInput);
    await writeD06Profile(paths, profileText);
    const profileHash = await sha256File(paths.profilePath);
    evidence.profile = {
      path: paths.profilePath,
      sha256: profileHash.sha256,
      bytes: profileHash.bytes,
      fullText: profileText,
      allowlist: describeSeatbeltAllowlist(profileInput),
    };
    evidence.resources = {
      canaryRoot: paths.root,
      canaryRead: paths.canaryReadPath,
      canaryWrite: paths.canaryWritePath,
      importCanary: paths.importCanaryPath,
      docsFile: paths.docsFile,
      clientFile: paths.clientFile,
      browserSocket: paths.browserSocketPath,
      forbiddenSocket: paths.forbiddenSocketPath,
    };

    const builderUrl = new URL("./build.mjs", import.meta.url).href;
    const builder = (await import(builderUrl)) as {
      buildNodeReplHostBundle(input: { outfile: string; cuaHelperBuildId: string }): Promise<{
        outfile: string;
      }>;
    };
    const built = await builder.buildNodeReplHostBundle({
      outfile: paths.bundlePath,
      cuaHelperBuildId: "",
    });
    const bundleHash = await sha256File(built.outfile);
    evidence.bundle = { path: built.outfile, sha256: bundleHash.sha256, bytes: bundleHash.bytes };
    evidence.failureTests = await runD06FailureTests({ paths, nodePath });
    try {
      servers = await startD06FixtureServers(paths);
    } catch (error) {
      throw new BlockedError(`synthetic fixture sockets unavailable: ${errorText(error)}`);
    }
    const context = createD06ProbeContext({
      nodePath,
      sandboxExec: SANDBOX_EXEC,
      paths,
      tcpPort: servers.tcpPort,
      stats: servers.stats,
    });
    evidence.resources.tcpPort = servers.tcpPort;

    evidence.cases.push(...(await runForkProbes(context)));

    let sandboxReady = true;
    try {
      await access(SANDBOX_EXEC, constants.X_OK);
    } catch (error) {
      sandboxReady = false;
      evidence.cases.push(
        await runCase("seatbelt-policy-load", "seatbelt", "allowed", async () => ({
          outcome: "blocked",
          code: errorCode(error) ?? "ENOENT",
          detail: `sandbox-exec unavailable: ${errorText(error)}`,
        })),
      );
    }
    if (sandboxReady) {
      const preflight = await runPolicyLoadProbe({
        sandboxExec: SANDBOX_EXEC,
        nodePath,
        profilePath: paths.profilePath,
        cwd: paths.root,
        expectedNodeVersion: D06_EXPECTED_NODE,
      });
      const preflightCase = await runCase(
        "seatbelt-policy-load",
        "seatbelt",
        "allowed",
        async () => preflight.observation,
      );
      preflightCase.command = preflight.command;
      evidence.preflight = { command: preflight.command, observation: preflight.observation };
      evidence.cases.push(preflightCase);
      if (preflightCase.status === "passed") {
        evidence.cases.push(...(await runSeatbeltProbes(context)));
      } else {
        evidence.cases.push(
          ...skippedSeatbeltCases("policy load did not pass; seatbelt matrix not executed"),
        );
      }
    } else {
      evidence.cases.push(
        ...skippedSeatbeltCases("sandbox-exec unavailable; seatbelt matrix not executed"),
      );
    }
    evidence.resources.networkStats = { ...servers.stats };
  } catch (error) {
    const blocked = error instanceof BlockedError || isMissingToolError(error);
    infrastructure = {
      phase: "setup",
      error: errorText(error),
      code: errorCode(error),
      blocked,
    };
  } finally {
    evidence.cleanup = await cleanupD06Workspace(paths, servers);
  }

  if (infrastructure) evidence.infrastructure = infrastructure;
  const counts = countCases(evidence.cases);
  evidence.summary = counts;
  evidence.failureSummary = countFailureTests(evidence.failureTests);
  let decision = decideExit(evidence.cases);
  if (infrastructure) {
    decision = infrastructure.blocked
      ? { status: "blocked", exitCode: 2 }
      : { status: "failed", exitCode: 1 };
    evidence.reason = `setup failed: ${infrastructure.error}`;
  } else if (!evidence.cleanup?.removed) {
    decision = { status: "failed", exitCode: 1 };
    evidence.reason = `cleanup failed: ${evidence.cleanup?.error ?? "unknown cleanup error"}`;
  } else {
    const failureDecision = decideFailureTests(evidence.failureTests);
    if (failureDecision.exitCode !== 0) decision = failureDecision;
    evidence.reason =
      decision.exitCode === 0 && failureDecision.exitCode === 0
        ? "implemented matrix satisfied; full D06 gate remains blocked"
        : decision.exitCode !== 0
          ? (evidence.cases.find((item) => item.status !== "passed")?.reason ??
            evidence.failureTests.find((item) => item.status !== "passed")?.reason ??
            "matrix not satisfied")
          : "failure tests not satisfied";
  }
  evidence.status = decision.status;
  evidence.exitCode = decision.exitCode;
  return evidence;
}

function skippedSeatbeltCases(reason: string): D06CaseResult[] {
  return SEATBELT_CASE_MANIFEST.map(({ id, expected }) => ({
    id,
    group: "seatbelt" as const,
    expected,
    status: "blocked" as const,
    reason,
    observed: { outcome: "blocked" as const, detail: reason },
    durationMs: 0,
  }));
}

function countCases(cases: D06CaseResult[]): DiagnosticEvidence["summary"] {
  return {
    total: cases.length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    blocked: cases.filter((item) => item.status === "blocked").length,
  };
}

function countFailureTests(tests: D06FailureTestResult[]): DiagnosticEvidence["failureSummary"] {
  return {
    total: tests.length,
    passed: tests.filter((item) => item.status === "passed").length,
    failed: tests.filter((item) => item.status === "failed").length,
    blocked: tests.filter((item) => item.status === "blocked").length,
  };
}

async function readNodeVersion(nodePath: string): Promise<string> {
  const { stdout } = await execFileAsync(nodePath, ["--version"], {
    timeout: 5_000,
    maxBuffer: 4096,
  });
  return stdout.trim();
}

class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

function isMissingToolError(error: unknown): boolean {
  const text = errorText(error);
  return /Cannot find package ['"]esbuild['"]|ERR_MODULE_NOT_FOUND/u.test(text);
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

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  },
);
