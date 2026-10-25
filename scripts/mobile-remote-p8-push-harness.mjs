#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayRoot =
  process.env.ZODY_GATEWAY_REPO?.trim() || resolve(repoRoot, "../zclaudia-gateway");
const statePath = resolve(repoRoot, ".tmp/mobile-remote-p8-push/state.json");
const workspacePath = resolve(repoRoot, ".tmp/mobile-remote-p8-push/workspace");
const image = "binwiederhier/ntfy:v2.14.0";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.signal}): ${result.stderr?.trim() || "no details"}`,
    );
  }
  return result.stdout.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a local port");
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : "unknown error"}`,
  );
}

function androidHostAddress() {
  for (const iface of ["en0", "en1"]) {
    const result = spawnSync("ipconfig", ["getifaddr", iface], {
      encoding: "utf8",
    });
    const address = result.status === 0 ? result.stdout.trim() : "";
    if (address && address !== "127.0.0.1") return address;
  }
  throw new Error(
    "Could not find a LAN IPv4 address using ipconfig; Android needs a reachable Gateway URL",
  );
}

async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(path, 0o600);
}

async function adminRequest(baseUrl, adminToken, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) {
    throw new Error(`Gateway admin ${route} failed (HTTP ${response.status})`);
  }
  return result.data;
}

async function launchGateway({ credentials, gatewayPort, ntfyPort, tempDir }) {
  const gatewayLog = resolve(tempDir, "gateway.log");
  const logFd = await open(gatewayLog, "a", 0o600);
  const env = {
    ...process.env,
    GATEWAY_PORT: String(gatewayPort),
    GATEWAY_ADMIN_TOKEN: credentials.adminToken,
    GATEWAY_TRUST_PROXY: "false",
    NTFY_ENABLED: "true",
    NTFY_URL: `http://127.0.0.1:${ntfyPort}`,
    NTFY_TOPIC: credentials.topic,
    NTFY_AUTH_MODE: "none",
    ZCLAUDIA_DATA_DIR: resolve(tempDir, "gateway-data"),
  };
  for (const key of [
    "NTFY_PUBLISH_TOKEN",
    "NTFY_SUBSCRIBE_TOKEN",
    "NTFY_USERNAME",
    "NTFY_PASSWORD",
    "NTFY_EVENT_ALLOWLIST",
    "NTFY_EVENT_DENYLIST",
    "NTFY_MIN_SEVERITY",
  ])
    delete env[key];
  // The Gateway Docker builder/runtime and CI use Node 22.20.0. Keep this
  // helper aligned with that independently managed package runtime.
  const gateway = spawn("fnm", ["exec", "--using=22.20.0", "pnpm", "exec", "tsx", "src/index.ts"], {
    cwd: gatewayRoot,
    env,
    detached: true,
    stdio: ["ignore", logFd.createWriteStream(), logFd.createWriteStream()],
  });
  gateway.unref();
  return gateway.pid;
}

async function resume() {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const credentials = JSON.parse(await readFile(state.credentialsPath, "utf8"));
  if (!state.topic) {
    // Older harness state did not persist the non-secret ntfy topic. Use a
    // new isolated topic after process recovery; device subscription routing
    // is per backend and is negotiated again through the Gateway.
    state.topic = `p8r${randomBytes(6).toString("hex")}`;
  }
  try {
    await waitFor(`http://127.0.0.1:${state.ntfyPort}/v1/health`, 1_000);
  } catch {
    throw new Error("The isolated ntfy container is not healthy; refusing to replace it");
  }
  try {
    const health = await fetch(`http://127.0.0.1:${state.gatewayPort}/health`);
    if (health.ok) {
      console.log("The isolated Gateway is already healthy.");
      return;
    }
  } catch {}
  const gatewayPid = await launchGateway({
    credentials: { ...credentials, topic: state.topic },
    gatewayPort: state.gatewayPort,
    ntfyPort: state.ntfyPort,
    tempDir: state.tempDir,
  });
  await waitFor(`http://127.0.0.1:${state.gatewayPort}/health`);
  state.gatewayPid = gatewayPid;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(statePath, 0o600);
  console.log("Resumed the isolated Gateway on its existing port and data directory.");
}

async function start() {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  try {
    await readFile(statePath, "utf8");
    throw new Error("P8 push harness state already exists; stop it before starting another run");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const containerName = `zody-p8-push-ntfy-${runId.slice(0, 8)}`;
  const tempDir = await mkdtemp(resolve(tmpdir(), "zody-p8-push-"));
  await chmod(tempDir, 0o700);
  const ntfyPort = await freePort();
  const gatewayPort = await freePort();
  const host = androidHostAddress();
  const gatewayUrl = `http://${host}:${gatewayPort}`;
  const adminToken = `zga_${randomBytes(32).toString("hex")}`;
  const namespace = `p8-${runId.slice(0, 8)}`;
  const topic = `p8${runId.replaceAll("-", "").slice(0, 10)}`;
  const credentialsPath = resolve(tempDir, "credentials.json");
  let gatewayPid;
  let containerStarted = false;
  try {
    run("docker", [
      "run",
      "--detach",
      "--name",
      containerName,
      "--label",
      "zody.p8-push=true",
      "--publish",
      `0.0.0.0:${ntfyPort}:80`,
      "--env",
      `NTFY_BASE_URL=http://${host}:${ntfyPort}`,
      "--volume",
      `${resolve(tempDir, "ntfy-cache")}:/var/cache/ntfy`,
      image,
      "serve",
    ]);
    containerStarted = true;
    await waitFor(`http://127.0.0.1:${ntfyPort}/v1/health`);

    gatewayPid = await launchGateway({
      credentials: { adminToken, topic },
      gatewayPort,
      ntfyPort,
      tempDir,
    });
    await waitFor(`http://127.0.0.1:${gatewayPort}/health`);

    const backend = await adminRequest(
      `http://127.0.0.1:${gatewayPort}`,
      adminToken,
      "/api/admin/credentials",
      {
        type: "backend",
        namespace,
        name: "Zody P8 isolated desktop",
        ttlDays: 1,
      },
    );
    const device = await adminRequest(
      `http://127.0.0.1:${gatewayPort}`,
      adminToken,
      "/api/admin/credentials",
      {
        type: "device",
        namespace,
        name: "Zody P8 Android acceptance",
        ttlDays: 1,
      },
    );
    await privateJson(credentialsPath, {
      gatewayUrl,
      namespace,
      adminToken,
      backendCredentialId: backend.id,
      backendCredential: backend.token,
      deviceCredentialId: device.id,
      deviceCredential: device.token,
    });
    await privateJson(statePath, {
      tempDir,
      gatewayPid,
      containerName,
      credentialsPath,
      gatewayPort,
      ntfyPort,
      topic,
      workspacePath,
    });
    console.log(`Gateway URL for Android: ${gatewayUrl}`);
    console.log(`Private credentials: ${credentialsPath}`);
    console.log(`Case-owned workspace: ${workspacePath}`);
    console.log(
      "Gateway and ntfy are isolated and running. Do not share the credential file in chat or logs.",
    );
  } catch (error) {
    if (gatewayPid) {
      try {
        process.kill(-gatewayPid, "SIGTERM");
      } catch {}
    }
    if (containerStarted) {
      try {
        run("docker", ["rm", "--force", containerName]);
      } catch {}
    }
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function scope(backendId) {
  if (!backendId) throw new Error("Usage: scope <online-backend-id>");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const credentials = JSON.parse(await readFile(state.credentialsPath, "utf8"));
  const backends = await adminRequest(
    `http://127.0.0.1:${state.gatewayPort}`,
    credentials.adminToken,
    "/api/admin/backends",
  );
  if (!backends.some((backend) => backend.backendId === backendId && backend.online)) {
    throw new Error("The supplied backend is not online in this isolated Gateway");
  }
  await fetch(
    `${`http://127.0.0.1:${state.gatewayPort}`}/api/admin/credentials/${credentials.deviceCredentialId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${credentials.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ allowedBackends: [backendId] }),
    },
  ).then(async (response) => {
    const result = await response.json();
    if (!response.ok || result.success !== true)
      throw new Error(`Failed to scope device credential (HTTP ${response.status})`);
  });
  console.log("Device credential is scoped to the selected backend.");
}

async function stop() {
  let state;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("P8 push harness is not running.");
      return;
    }
    throw error;
  }
  try {
    const credentials = JSON.parse(await readFile(state.credentialsPath, "utf8"));
    await fetch(`http://127.0.0.1:${state.gatewayPort}/api/admin/credentials/revoke`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: [credentials.backendCredentialId, credentials.deviceCredentialId],
      }),
    }).catch(() => {});
  } catch {}
  try {
    process.kill(-state.gatewayPid, "SIGTERM");
  } catch {}
  try {
    run("docker", ["rm", "--force", state.containerName]);
  } catch {}
  await rm(state.tempDir, { recursive: true, force: true });
  await rm(state.workspacePath, { recursive: true, force: true });
  await rm(statePath, { force: true });
  console.log(
    "Stopped the isolated Gateway and ntfy container; removed test credentials and data.",
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "start") await start();
  else if (command === "scope") await scope(args[0]);
  else if (command === "resume") await resume();
  else if (command === "stop") await stop();
  else
    throw new Error(
      "Usage: node scripts/mobile-remote-p8-push-harness.mjs <start|resume|scope <backend-id>|stop>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.stack : "Harness failed");
  process.exitCode = 1;
}
