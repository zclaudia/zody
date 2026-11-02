#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const credentialsPath = process.env.ZCODE_P8_CREDENTIAL_FILE?.trim();
if (!credentialsPath)
  throw new Error("Set ZCODE_P8_CREDENTIAL_FILE to the private push-harness credential file");
const pushStatePath = resolve(repoRoot, ".tmp/mobile-remote-p8-push/state.json");
const sharedDir = resolve(repoRoot, ".tmp/mobile-remote-p8-owner-boundary");
const runId = randomBytes(5).toString("hex");
const prefix = `zody-p8-owner-boundary-${runId}`;
const workDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
await chmod(workDir, 0o700);
const e2eHome = join(workDir, "electron-home");
const sshName = `${prefix}-ssh`;
const sshPassword = randomBytes(24).toString("base64url");
const sshStarted = new Set();
let preserveDiagnostics = false;

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function docker(args, input) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0]} failed (${result.status}): ${(result.stderr || "").slice(0, 400)}`,
    );
  }
  return result.stdout.trim();
}

function mappedPort(container, key) {
  const mapping = JSON.parse(
    docker(["inspect", container, "--format", "{{json .NetworkSettings.Ports}}"]),
  );
  const value = Number(mapping[key]?.[0]?.HostPort);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`isolated SSH container has no published ${key} port`);
  }
  return value;
}

async function startSSH(name, password) {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "zody.p8-owner-boundary=true",
    "-p",
    "127.0.0.1::22",
    "zcoder-ssh-local-runtime-test:latest",
    "sleep",
    "infinity",
  ]);
  sshStarted.add(name);
  docker([
    "exec",
    name,
    "sh",
    "-lc",
    [
      "ssh-keygen -A >/dev/null 2>&1",
      "mkdir -p /workspace/p8-owner-boundary",
      "printf 'P8_OWNER_BOUNDARY_SAME_IDENTITY\\n' > /workspace/p8-owner-boundary/marker.txt",
      "printf '\\nPermitRootLogin yes\\nPasswordAuthentication yes\\nUsePAM no\\n' >> /etc/ssh/sshd_config",
    ].join(" && "),
  ]);
  docker(["exec", "-i", name, "sh", "-c", "chpasswd"], `root:${password}\n`);
  docker(["exec", "-d", name, "/usr/sbin/sshd", "-D", "-e"]);
}

async function main() {
  const pushState = JSON.parse(
    await (await import("node:fs/promises")).readFile(pushStatePath, "utf8"),
  );
  if (pushState.credentialsPath !== credentialsPath) {
    throw new Error("ZCODE_P8_CREDENTIAL_FILE does not match the active push-harness state");
  }
  // 清掉上次交接文件，避免设备操作人员误把旧 ready/trigger 当成本轮状态。
  const handoffLabels = ["owner", "taskdeleted", "workspaceclosed"];
  await Promise.all(
    [
      "ready.json",
      "release.json",
      "stage.json",
      "verification.json",
      "final-receipts.json",
      "final-host-pids.json",
      "placeholder-evidence.json",
      ...handoffLabels.flatMap((label) => [
        `result-${label}.json`,
        `trigger-${label}.json`,
        `click-${label}.json`,
        `diagnostic-${label}.json`,
      ]),
    ].map((name) => rm(join(sharedDir, name), { force: true })),
  );
  await mkdir(e2eHome, { recursive: true, mode: 0o700 });
  await mkdir(sharedDir, { recursive: true, mode: 0o700 });
  await startSSH(sshName, sshPassword);
  const port = mappedPort(sshName, "22/tcp");
  const passwordFile = join(workDir, "ssh-password");
  await writeFile(passwordFile, `${sshPassword}\n`, { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  const dockerHost = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerHost) throw new Error("Docker context did not report an endpoint");

  const env = { ...process.env };
  Object.assign(env, {
    ZCODE_P8_CREDENTIAL_FILE: credentialsPath,
    ZCODE_P8_OWNER_HANDOFF_DIR: sharedDir,
    ZCODE_E2E_HOME_DIR: e2eHome,
    ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE: "replay",
    E2E_PROVIDER_REPLAY_FIXTURE_PATH: [
      resolve(repoRoot, "packages/desktop/test/e2e/fixtures/upstream/common.json"),
      resolve(
        repoRoot,
        "packages/desktop/test/e2e/fixtures/upstream/mobile-remote/mobile-notification-owner-boundary.json",
      ),
    ].join(","),
    ZCODE_E2E_P8_OWNER_WORKSPACE_PATH: "/workspace/p8-owner-boundary",
    ZCODE_E2E_P8_OWNER_PORT: String(port),
    ZCODE_E2E_P8_OWNER_PASSWORD_FILE: passwordFile,
    // Let onPrepare stage this run's current SSH runtime assets before the host connects.
    ZCODE_E2E_SSH_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_PORT: String(port),
    ZCODE_E2E_SSH_USERNAME: "root",
    ZCODE_E2E_SSH_PASSWORD: sshPassword,
    ZCODE_E2E_SSH_WORKSPACE_PATH: "/workspace/p8-owner-boundary",
    ZCODE_E2E_SKIP_AGENT_BUILD: "1",
    ZCODE_E2E_MANUAL_REVIEW_HOLD_MS: "5400000",
    DOCKER_HOST: dockerHost,
  });
  console.log(
    `One isolated SSH target is ready for workspace /workspace/p8-owner-boundary on port ${port}.`,
  );
  console.log(`Manual Android handoff directory: ${sharedDir}`);
  console.log(
    "The WDIO case will write ready.json and hold for Android triggers/click acknowledgements.",
  );

  return run(
    "fnm",
    [
      "exec",
      "--using=24.14.0",
      "pnpm",
      "--filter",
      "@zody/desktop",
      "exec",
      "wdio",
      "run",
      "wdio.conf.ts",
      "--spec",
      "./test/e2e/mobile-remote/manual-review/pending/mobile-notification-owner-boundary.test.ts",
    ],
    env,
  );
}

try {
  process.exitCode = Number(await main());
  preserveDiagnostics =
    process.exitCode !== 0 && process.env.ZCODE_P8_OWNER_PRESERVE_DIAGNOSTICS === "1";
} catch (error) {
  console.error(error instanceof Error ? error.message : "P8 owner-boundary setup failed");
  process.exitCode = 1;
  preserveDiagnostics = process.env.ZCODE_P8_OWNER_PRESERVE_DIAGNOSTICS === "1";
} finally {
  if (preserveDiagnostics) {
    console.error(`Preserving isolated SSH target and private E2E home for diagnosis: ${workDir}`);
  } else {
    for (const name of sshStarted) {
      try {
        docker(["rm", "-f", name]);
      } catch {
        /* already removed */
      }
    }
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* remove temporary secrets */
    }
  }
}
