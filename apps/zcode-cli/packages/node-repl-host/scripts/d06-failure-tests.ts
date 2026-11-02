import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CELL_RUN_FLAG } from "../src/cell-protocol.js";
import type { D06FailureTestResult } from "./d06-policy.js";
import { D06_REQUEST_META, createD06CellExecutor } from "./d06-probe-runtime.js";
import { D06_CANARY_CONTENT, errorText, sha256File, type D06Paths } from "./d06-resources.js";

const FAILURE_TEST_TIMEOUT_MS = 10_000;

interface FailureTestContext {
  paths: D06Paths;
  nodePath: string;
}

export async function runD06FailureTests(
  context: FailureTestContext,
): Promise<D06FailureTestResult[]> {
  const corruptedProfile = join(context.paths.root, "corrupted.sb");
  const missingSandbox = join(context.paths.root, "missing-sandbox-exec");
  await writeFile(
    corruptedProfile,
    '(version 1)\n(deny default\n(allow process-exec (literal "no-close-paren"))\n',
    "utf8",
  );
  return [
    await runRejectedLaunch(context, {
      id: "r4-07-corrupted-sbpl",
      command: "/usr/bin/sandbox-exec",
      args: ["-f", corruptedProfile, context.nodePath, context.paths.bundlePath, CELL_RUN_FLAG],
      rejectionMatches: /sandbox-exec:.*(?:syntax|parse|invalid|unexpected|failed|error)/iu,
    }),
    await runRejectedLaunch(context, {
      id: "r4-07-missing-sandbox-executable",
      command: missingSandbox,
      args: [
        "-f",
        context.paths.profilePath,
        context.nodePath,
        context.paths.bundlePath,
        CELL_RUN_FLAG,
      ],
      rejectionMatches: /(?:spawn|ENOENT|no such file)/iu,
    }),
  ];
}

async function runRejectedLaunch(
  context: FailureTestContext,
  input: {
    id: string;
    command: string;
    args: string[];
    rejectionMatches: RegExp;
  },
): Promise<D06FailureTestResult> {
  const started = Date.now();
  await writeFile(context.paths.canaryWritePath, D06_CANARY_CONTENT, "utf8");
  const before = await sha256File(context.paths.canaryWritePath);
  const executor = createD06CellExecutor({
    nodePath: context.nodePath,
    paths: context.paths,
    launch: { command: input.command, args: input.args },
  });
  let executed = false;
  let rejection: string | undefined;
  try {
    await executor({
      code: `require("node:fs").writeFileSync(${JSON.stringify(context.paths.canaryWritePath)}, "D06_FALLBACK_WRITE", "utf8"); return { outcome: "allowed" };`,
      requestMeta: D06_REQUEST_META,
      signal: AbortSignal.timeout(FAILURE_TEST_TIMEOUT_MS),
      syncTimeoutMs: FAILURE_TEST_TIMEOUT_MS - 2_000,
    });
    executed = true;
  } catch (error) {
    rejection = errorText(error);
  }
  const after = await sha256File(context.paths.canaryWritePath);
  const unchanged = before.sha256 === after.sha256;
  const rejectedAtStartup =
    !executed && rejection !== undefined && input.rejectionMatches.test(rejection);
  const passed = rejectedAtStartup && unchanged;
  return {
    id: input.id,
    expected: "startup-rejected-no-execution",
    status: passed ? "passed" : "failed",
    reason: passed
      ? "launcher rejected before cell execution; canary unchanged"
      : `executed=${executed}, canaryUnchanged=${unchanged}, rejectionMatched=${rejectedAtStartup}`,
    command: [input.command, ...input.args],
    canary: { beforeSha256: before.sha256, afterSha256: after.sha256, unchanged },
    ...(rejection ? { rejection } : {}),
    durationMs: Date.now() - started,
  };
}
