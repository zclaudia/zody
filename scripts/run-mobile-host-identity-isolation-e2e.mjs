#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const runId = randomBytes(5).toString("hex");
const prefix = `zody-p8-host-identity-${runId}`;
const workDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
await chmod(workDir, 0o700);
const e2eHome = join(workDir, "electron-home");
const gatewayName = `${prefix}-gateway`;
const sshNames = [`${prefix}-ssh-a`, `${prefix}-ssh-b`];
const volumeName = `${prefix}-gateway-data`;
const gatewayAdmin = randomBytes(32).toString("hex");
const sshPasswords = [randomBytes(24).toString("base64url"), randomBytes(24).toString("base64url")];
let gatewayStarted = false;
const sshStarted = new Set();
let volumeCreated = false;

function docker(args, input) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0]} failed (${result.status}): ${(result.stderr || "").slice(0, 400)}`,
    );
  }
  return result.stdout.trim();
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The isolated Gateway is still starting.
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

function mappedPort(container, key) {
  const mapping = JSON.parse(
    docker(["inspect", container, "--format", "{{json .NetworkSettings.Ports}}"]),
  );
  const value = Number(mapping[key]?.[0]?.HostPort);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`isolated container has no published ${key} port`);
  }
  return value;
}

async function startSshContainer(name, password) {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "zody.p8.host-identity=true",
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
      "mkdir -p /workspace/p8-host-identity",
      "printf 'P8_HOST_IDENTITY_SAME_PATH\\n' > /workspace/p8-host-identity/marker.txt",
      "printf '\\nPermitRootLogin yes\\nPasswordAuthentication yes\\nUsePAM no\\n' >> /etc/ssh/sshd_config",
    ].join(" && "),
  ]);
  docker(["exec", "-i", name, "sh", "-c", "chpasswd"], `root:${password}\n`);
  docker(["exec", "-d", name, "/usr/sbin/sshd", "-D", "-e"]);
}

async function main() {
  await mkdir(e2eHome, { recursive: true, mode: 0o700 });
  docker(["volume", "create", volumeName]);
  volumeCreated = true;
  docker([
    "run",
    "-d",
    "--name",
    gatewayName,
    "--label",
    "zody.p8.host-identity=true",
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
  const gatewayUrl = `http://127.0.0.1:${mappedPort(gatewayName, "3200/tcp")}`;
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

  await Promise.all(sshNames.map((name, index) => startSshContainer(name, sshPasswords[index])));
  const sshPorts = sshNames.map((name) => mappedPort(name, "22/tcp"));
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
  for (const key of [
    "ZCODE_GATEWAY_IT_URL",
    "ZCODE_GATEWAY_BACKEND_CREDENTIAL",
    "ZCODE_GATEWAY_DEVICE_CREDENTIAL",
  ])
    delete env[key];
  Object.assign(env, {
    ZCODE_GATEWAY_ENV_FILE: gatewayEnvFile,
    ZCODE_E2E_HOME_DIR: e2eHome,
    ZCODE_E2E_MANUAL_REVIEW_HOLD_MS: "600000",
    ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE: "replay",
    E2E_PROVIDER_REPLAY_FIXTURE_PATH: [
      join(repoRoot, "packages/desktop/test/e2e/fixtures/upstream/common.json"),
      join(
        repoRoot,
        "packages/desktop/test/e2e/fixtures/upstream/mobile-remote/mobile-host-identity-isolation.json",
      ),
    ].join(","),
    ZCODE_E2E_P8_IDENTITY_WORKSPACE_PATH: "/workspace/p8-host-identity",
    ZCODE_E2E_P8_IDENTITY_A_PORT: String(sshPorts[0]),
    ZCODE_E2E_P8_IDENTITY_B_PORT: String(sshPorts[1]),
    ZCODE_E2E_P8_IDENTITY_A_PASSWORD_FILE: passwordFiles[0],
    ZCODE_E2E_P8_IDENTITY_B_PASSWORD_FILE: passwordFiles[1],
    DOCKER_HOST: dockerHost,
    // Existing onPrepare SSH staging uses target A. The same runner image and path are used by target B.
    ZCODE_E2E_SSH_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_PORT: String(sshPorts[0]),
    ZCODE_E2E_SSH_USERNAME: "root",
    ZCODE_E2E_SSH_PASSWORD: sshPasswords[0],
    ZCODE_E2E_SSH_WORKSPACE_PATH: "/workspace/p8-host-identity",
    ZCODE_E2E_SSH_A_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_A_PORT: String(sshPorts[0]),
    ZCODE_E2E_SSH_A_USERNAME: "root",
    ZCODE_E2E_SSH_A_PASSWORD: sshPasswords[0],
    ZCODE_E2E_SSH_B_HOST: "127.0.0.1",
    ZCODE_E2E_SSH_B_PORT: String(sshPorts[1]),
    ZCODE_E2E_SSH_B_USERNAME: "root",
    ZCODE_E2E_SSH_B_PASSWORD: sshPasswords[1],
  });

  return run(
    "pnpm",
    [
      "--filter",
      "@zcode/desktop",
      "exec",
      "wdio",
      "run",
      "wdio.conf.ts",
      "--spec",
      "./test/e2e/mobile-remote/manual-review/pending/mobile-host-identity-isolation.test.ts",
    ],
    env,
  );
}

try {
  process.exitCode = Number(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : "P8 Host identity isolation setup failed");
  process.exitCode = 1;
} finally {
  for (const name of sshStarted) {
    try {
      docker(["rm", "-f", name]);
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
    /* remove temporary secrets */
  }
}
