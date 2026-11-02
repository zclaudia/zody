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
const sharedDir = resolve(repoRoot, ".tmp/mobile-remote-p8-multihost-click");
const runId = randomBytes(5).toString("hex");
const prefix = `zody-p8-multihost-notification-${runId}`;
const workDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
await chmod(workDir, 0o700);
const e2eHome = join(workDir, "electron-home");
const sshNames = [`${prefix}-ssh-a`, `${prefix}-ssh-b`];
const sshPasswords = [randomBytes(24).toString("base64url"), randomBytes(24).toString("base64url")];
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
    "zody.p8-multihost-notification=true",
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
      "mkdir -p /workspace/p8-multihost-notification",
      "printf 'P8_MULTIHOST_NOTIFICATION_SAME_PATH\\n' > /workspace/p8-multihost-notification/marker.txt",
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
  // 清掉上次手工交接文件后再启动 Desktop，避免设备操作人员误把旧 ready/trigger 当成本轮状态。
  const handoffLabels = ["A", "B", "revoked", "recovered"];
  await Promise.all(
    [
      "ready.json",
      "release.json",
      "stage.json",
      "verification.json",
      "final-receipts.json",
      "final-host-pids.json",
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
  await Promise.all(sshNames.map((name, index) => startSSH(name, sshPasswords[index])));
  const ports = sshNames.map((name) => mappedPort(name, "22/tcp"));
  const passwordFiles = await Promise.all(
    sshPasswords.map(async (password, index) => {
      const path = join(workDir, `ssh-${index}-password`);
      await writeFile(path, `${password}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    }),
  );
  const dockerHost = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerHost) throw new Error("Docker context did not report an endpoint");

  const env = { ...process.env };
  Object.assign(env, {
    ZCODE_P8_CREDENTIAL_FILE: credentialsPath,
    ZCODE_P8_MULTIHOST_HANDOFF_DIR: sharedDir,
    ZCODE_E2E_HOME_DIR: e2eHome,
    ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE: "replay",
    E2E_PROVIDER_REPLAY_FIXTURE_PATH: [
      resolve(repoRoot, "packages/desktop/test/e2e/fixtures/upstream/common.json"),
      resolve(
        repoRoot,
        "packages/desktop/test/e2e/fixtures/upstream/mobile-remote/mobile-multihost-notification-click.json",
      ),
    ].join(","),
    ZCODE_E2E_P8_MULTIHOST_WORKSPACE_PATH: "/workspace/p8-multihost-notification",
    ZCODE_E2E_P8_MULTIHOST_A_PORT: String(ports[0]),
    ZCODE_E2E_P8_MULTIHOST_B_PORT: String(ports[1]),
    ZCODE_E2E_P8_MULTIHOST_A_PASSWORD_FILE: passwordFiles[0],
    ZCODE_E2E_P8_MULTIHOST_B_PASSWORD_FILE: passwordFiles[1],
    // Let onPrepare stage this run's current SSH runtime assets before either host connects.
    ZCODE_E2E_SSH_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_PORT: String(ports[0]),
    ZCODE_E2E_SSH_USERNAME: "root",
    ZCODE_E2E_SSH_PASSWORD: sshPasswords[0],
    ZCODE_E2E_SSH_WORKSPACE_PATH: "/workspace/p8-multihost-notification",
    ZCODE_E2E_SSH_A_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_A_PORT: String(ports[0]),
    ZCODE_E2E_SSH_A_USERNAME: "root",
    ZCODE_E2E_SSH_A_PASSWORD: sshPasswords[0],
    ZCODE_E2E_SSH_B_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_B_PORT: String(ports[1]),
    ZCODE_E2E_SSH_B_USERNAME: "root",
    ZCODE_E2E_SSH_B_PASSWORD: sshPasswords[1],
    ZCODE_E2E_SKIP_AGENT_BUILD: "1",
    ZCODE_E2E_MANUAL_REVIEW_HOLD_MS: "5400000",
    DOCKER_HOST: dockerHost,
  });
  console.log(
    `Two isolated SSH targets are ready for workspace /workspace/p8-multihost-notification.`,
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
      "./test/e2e/mobile-remote/manual-review/pending/mobile-multihost-notification-click.test.ts",
    ],
    env,
  );
}

try {
  process.exitCode = Number(await main());
  preserveDiagnostics = process.exitCode !== 0 && process.env.ZCODE_P8_MULTIHOST_PRESERVE_DIAGNOSTICS === "1";
} catch (error) {
  console.error(error instanceof Error ? error.message : "P8 multi-Host notification setup failed");
  process.exitCode = 1;
  preserveDiagnostics = process.env.ZCODE_P8_MULTIHOST_PRESERVE_DIAGNOSTICS === "1";
} finally {
  if (preserveDiagnostics) {
    console.error(`Preserving isolated SSH targets and private E2E home for diagnosis: ${workDir}`);
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
