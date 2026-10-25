#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const runId = randomBytes(5).toString("hex");
const prefix = `zody-p8-remote-${runId}`;
const workDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
await chmod(workDir, 0o700);
const e2eHome = join(workDir, "electron-home");
const workspacePath = join(workDir, "workspace");
const gatewayName = `${prefix}-gateway`;
const sshName = `${prefix}-ssh`;
const volumeName = `${prefix}-data`;
const gatewayPortMarker = "3200/tcp";
const gatewayAdmin = randomBytes(32).toString("hex");
const sshPassword = randomBytes(24).toString("base64url");
let gatewayStarted = false;
let sshStarted = false;
let volumeCreated = false;

function docker(args, input) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0]} failed (${result.status}): ${(result.stderr || "").slice(0, 500)}`,
    );
  }
  return result.stdout.trim();
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
    if (child.error) reject(child.error);
    else resolve(child.status ?? 1);
  });
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The isolated container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("isolated Gateway did not become healthy");
}

async function issueCredential(gatewayUrl, type, name) {
  const response = await fetch(`${gatewayUrl}/api/admin/credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${gatewayAdmin}`, "content-type": "application/json" },
    body: JSON.stringify({ type, namespace: "zody", name }),
  });
  const body = await response.json();
  if (!response.ok || !body.success || typeof body.data?.token !== "string") {
    throw new Error(
      `isolated Gateway could not issue ${type} credential (HTTP ${response.status})`,
    );
  }
  return body.data.token;
}

async function main() {
  await mkdir(e2eHome, { recursive: true, mode: 0o700 });
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  await writeFile(join(workspacePath, "mobile-remote.txt"), "LOCAL_SENTINEL_MUST_NEVER_BE_READ\n", {
    mode: 0o600,
  });

  docker(["volume", "create", volumeName]);
  volumeCreated = true;
  docker([
    "run",
    "-d",
    "--name",
    gatewayName,
    "--label",
    "zody.p8.remote=true",
    "-e",
    `GATEWAY_ADMIN_TOKEN=${gatewayAdmin}`,
    "-e",
    "GATEWAY_PORT=3200",
    "-p",
    "127.0.0.1::3200",
    "-v",
    `${volumeName}:/data`,
    "zclaudia-gateway-gateway:latest",
  ]);
  gatewayStarted = true;
  const gatewayPorts = JSON.parse(
    docker(["inspect", gatewayName, "--format", "{{json .NetworkSettings.Ports}}"]),
  );
  const gatewayUrl = `http://127.0.0.1:${Number(gatewayPorts[gatewayPortMarker][0].HostPort)}`;
  await waitForHealth(gatewayUrl);
  const backendCredential = await issueCredential(gatewayUrl, "backend", `${prefix}-backend`);
  const deviceCredential = await issueCredential(gatewayUrl, "device", `${prefix}-device`);
  const gatewayEnvFile = join(workDir, "gateway.env");
  await writeFile(
    gatewayEnvFile,
    [
      `ZCODE_GATEWAY_IT_URL='${gatewayUrl}'`,
      "ZCODE_GATEWAY_NAMESPACE='zody'",
      `ZCODE_GATEWAY_BACKEND_CREDENTIAL='${backendCredential}'`,
      `ZCODE_GATEWAY_DEVICE_CREDENTIAL='${deviceCredential}'`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await chmod(gatewayEnvFile, 0o600);

  docker([
    "run",
    "-d",
    "--name",
    sshName,
    "--label",
    "zody.p8.remote=true",
    "-p",
    "127.0.0.1::22",
    "zcoder-ssh-local-runtime-test:latest",
    "sleep",
    "infinity",
  ]);
  sshStarted = true;
  docker([
    "exec",
    sshName,
    "sh",
    "-lc",
    [
      "ssh-keygen -A >/dev/null 2>&1",
      `mkdir -p '${workspacePath}'`,
      `printf 'REMOTE_SENTINEL_P8_73AC\\n' > '${workspacePath}/mobile-remote.txt'`,
      `printf '\\nPermitRootLogin yes\\nPasswordAuthentication yes\\nUsePAM no\\n' >> /etc/ssh/sshd_config`,
    ].join(" && "),
  ]);
  docker(["exec", "-i", sshName, "sh", "-c", "chpasswd"], `root:${sshPassword}\n`);
  docker(["exec", "-d", sshName, "/usr/sbin/sshd", "-D", "-e"]);
  const sshPorts = JSON.parse(
    docker(["inspect", sshName, "--format", "{{json .NetworkSettings.Ports}}"]),
  );
  const sshPort = Number(sshPorts["22/tcp"][0].HostPort);
  const sshPasswordFile = join(workDir, "ssh-password");
  await writeFile(sshPasswordFile, `${sshPassword}\n`, { mode: 0o600 });
  await chmod(sshPasswordFile, 0o600);
  const deviceCredentialFile = join(workDir, "device-credential");
  await writeFile(deviceCredentialFile, `${deviceCredential}\n`, { mode: 0o600 });
  await chmod(deviceCredentialFile, 0o600);
  // wdio.conf.ts isolates HOME, so child Docker commands cannot resolve the parent user's context.
  const dockerHost = docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  if (!dockerHost) throw new Error("Docker context did not report an endpoint");
  const handoffFile = join(workDir, "handoff.json");
  const releaseFile = join(workDir, "release");

  const env = { ...process.env };
  for (const key of [
    "ZCODE_GATEWAY_IT_URL",
    "ZCODE_GATEWAY_BACKEND_CREDENTIAL",
    "ZCODE_GATEWAY_DEVICE_CREDENTIAL",
  ])
    delete env[key];
  Object.assign(env, {
    ZCODE_GATEWAY_ENV_FILE: gatewayEnvFile,
    ZCODE_E2E_HOME_DIR: e2eHome,
    ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE: "replay",
    ZCODE_E2E_MANUAL_REVIEW_HOLD_MS: "600000",
    E2E_PROVIDER_REPLAY_FIXTURE_PATH: [
      join(repoRoot, "packages/desktop/test/e2e/fixtures/upstream/common.json"),
      join(
        repoRoot,
        "packages/desktop/test/e2e/fixtures/upstream/mobile-remote/mobile-ssh-workspace.json",
      ),
    ].join(","),
    ZCODE_E2E_P8_REMOTE_WORKSPACE: workspacePath,
    ZCODE_E2E_P8_SSH_CONTAINER: sshName,
    ZCODE_E2E_P8_SSH_HOST: "127.0.0.1",
    ZCODE_E2E_P8_SSH_PORT: String(sshPort),
    ZCODE_E2E_P8_SSH_USERNAME: "root",
    ZCODE_E2E_P8_SSH_PASSWORD_FILE: sshPasswordFile,
    ZCODE_E2E_P8_REMOTE_HANDOFF_FILE: handoffFile,
    ZCODE_E2E_P8_REMOTE_RELEASE_FILE: releaseFile,
    ZCODE_E2E_P8_REMOTE_DEVICE_CREDENTIAL_FILE: deviceCredentialFile,
    DOCKER_HOST: dockerHost,
    // wdio.onPrepare 以标准 SSH gate 识别并 stage 本轮 remote runtime assets。
    ZCODE_E2E_SSH_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_PORT: String(sshPort),
    ZCODE_E2E_SSH_USERNAME: "root",
    ZCODE_E2E_SSH_PASSWORD: sshPassword,
    ZCODE_E2E_SSH_WORKSPACE_PATH: workspacePath,
  });
  const status = await run(
    "pnpm",
    [
      "--filter",
      "@zcode/desktop",
      "exec",
      "wdio",
      "run",
      "wdio.conf.ts",
      "--spec",
      "./test/e2e/mobile-remote/manual-review/pending/mobile-ssh-workspace.test.ts",
    ],
    env,
  );
  process.exitCode = Number(status);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "P8 SSH E2E setup failed");
  process.exitCode = 1;
} finally {
  if (sshStarted) {
    try {
      docker(["rm", "-f", sshName]);
    } catch {
      /* already removed */
    }
  }
  if (gatewayStarted) {
    try {
      docker(["rm", "-f", gatewayName]);
    } catch {
      /* already removed */
    }
  }
  if (volumeCreated) {
    try {
      docker(["volume", "rm", volumeName]);
    } catch {
      /* already removed */
    }
  }
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    /* temporary secrets must be removed */
  }
}
