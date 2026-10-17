#!/usr/bin/env node
/**
 * T0.2 本地 gateway 测试环境：给集成测试（T3.5）、桌面 E2E 和日常开发提供可复现的 zclaudia-gateway。
 *
 * 1. 起实例：设置 `ZCODE_GATEWAY_IT_URL` 时直接使用该已有实例；否则用 zclaudia-gateway 仓库的
 *    `docker-compose.yml` 起本地实例（目录用 `ZCLAUDIA_GATEWAY_DIR` 覆盖，默认 `../zclaudia-gateway`）。
 * 2. 签凭证：用管理令牌在 `zcode` namespace 下签发一张 backend 凭证（桌面）和一张 device 凭证（手机）。
 *    读回本地配置里仍然有效的凭证直接复用，所以脚本可以重复执行，不会越签越多。
 * 3. 写配置：地址、管理令牌和两张凭证写入 `.env.gateway.local`，命中根 .gitignore 的 `.env.*.local`。
 *
 * 输出约定（方案「日志」一节：不记录 `zgb_`/`zga_`/`zgd_` 与管理令牌）：
 * stdout 只输出写入的文件路径，其余进度信息一律走 stderr，任何凭证都不打印。
 *
 * 用法：
 *   pnpm dev:gateway
 *   set -a; source .env.gateway.local; set +a          # 或：node --env-file=.env.gateway.local <命令>
 *
 * 环境变量：
 *   ZCLAUDIA_GATEWAY_DIR                 zclaudia-gateway 检出目录（默认 ../zclaudia-gateway）
 *   ZCODE_GATEWAY_IT_URL                 已有实例地址；设置后不启动 docker
 *   ZCODE_GATEWAY_IT_ADMIN_TOKEN         已有实例的管理令牌（优先）
 *   GATEWAY_ADMIN_TOKEN                  管理令牌；本地实例模式下也用于启动 docker compose
 *   GATEWAY_PORT                         本地实例端口（默认取网关仓库 .env，再默认 3200）
 *   ZCODE_GATEWAY_NAMESPACE              凭证 namespace（默认 zcode）
 *   ZCODE_GATEWAY_ENV_FILE               本地配置写入路径（默认 .env.gateway.local；测试与多 worktree 并行用）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";

const repoRoot = resolve(import.meta.dirname, "..");
const envFileOverride = process.env.ZCODE_GATEWAY_ENV_FILE?.trim();
const stateFile = envFileOverride
  ? resolve(envFileOverride)
  : resolve(repoRoot, ".env.gateway.local");
const backendCredentialName = "zcode-desktop-dev";
const deviceCredentialName = "zcode-mobile-dev";
const requestTimeoutMs = 15_000;
const healthTimeoutMs = 120_000;

const envValue = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const log = (message) => {
  console.error(`[dev-gateway] ${message}`);
};

const fail = (message) => {
  console.error(`[dev-gateway] 错误：${message}`);
  process.exit(1);
};

/** 读取 dotenv 风格文件；不存在时返回空对象（`parseEnv` 与 `node --env-file` 同一套解析规则）。 */
async function readEnvFile(path) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function requestJson(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function isHealthy(url) {
  const result = await requestJson(`${url}/health`);
  return result.status === 200 && result.body?.status === "ok";
}

async function waitForHealthy(url) {
  const deadline = Date.now() + healthTimeoutMs;
  let last = "无响应";
  while (Date.now() < deadline) {
    const result = await requestJson(`${url}/health`);
    if (result.status === 200 && result.body?.status === "ok") return true;
    last = result.status === 0 ? `无响应（${result.error}）` : `HTTP ${result.status}`;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  log(`${url}/health 在 ${healthTimeoutMs / 1000} 秒内没有就绪，最后一次探测：${last}`);
  return false;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    // 子进程 stdout 接到父进程 stderr：docker 构建日志不能混进只放配置路径的 stdout。
    const child = spawn(command, args, { stdio: ["inherit", 2, "inherit"], ...options });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code));
  });
}

/** 凭证有效性：`/api/discovery/backends` 接受任意有效凭证，返回 200；吊销或过期是 401/403。 */
async function credentialStatus(url, token) {
  const result = await requestJson(`${url}/api/discovery/backends`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return result.status;
}

const externalUrl = envValue("ZCODE_GATEWAY_IT_URL");
const gatewayDir = envValue("ZCLAUDIA_GATEWAY_DIR") ?? resolve(repoRoot, "..", "zclaudia-gateway");
const composeFile = resolve(gatewayDir, "docker-compose.yml");
const gatewayEnvFile = externalUrl ? {} : await readEnvFile(resolve(gatewayDir, ".env"));
const port = envValue("GATEWAY_PORT") ?? gatewayEnvFile.GATEWAY_PORT ?? "3200";
const url = externalUrl ? externalUrl.replace(/\/+$/, "") : `http://127.0.0.1:${port}`;
const namespace = envValue("ZCODE_GATEWAY_NAMESPACE") ?? "zcode";
const stored = await readEnvFile(stateFile);
const storedMatchesUrl = stored.ZCODE_GATEWAY_IT_URL === url;

// 管理令牌优先级：命令行环境 > 网关仓库 .env > 上一次写入的本地配置 > 新生成（仅本地实例模式）。
let adminToken =
  envValue("ZCODE_GATEWAY_IT_ADMIN_TOKEN") ??
  envValue("GATEWAY_ADMIN_TOKEN") ??
  gatewayEnvFile.GATEWAY_ADMIN_TOKEN;
if (!adminToken && storedMatchesUrl) adminToken = stored.ZCODE_GATEWAY_IT_ADMIN_TOKEN;
if (!adminToken) {
  if (externalUrl) {
    fail(
      `使用已有实例 ${url} 需要管理令牌才能签发凭证，请设置 ZCODE_GATEWAY_IT_ADMIN_TOKEN 或 GATEWAY_ADMIN_TOKEN。`,
    );
  }
  adminToken = randomBytes(24).toString("hex");
  log("没有找到管理令牌，本次生成一个写入本地配置（重复执行会复用它）。");
}

if (await isHealthy(url)) {
  log(`${url} 上已有 gateway 实例响应 /health${externalUrl ? "" : "，跳过 docker compose"}。`);
} else if (externalUrl) {
  fail(`ZCODE_GATEWAY_IT_URL 指向的实例 ${url} 无响应（/health 探测失败）。`);
} else {
  if (!existsSync(composeFile)) {
    fail(
      `找不到 ${composeFile}；请用 ZCLAUDIA_GATEWAY_DIR 指向 zclaudia-gateway 检出目录，或用 ZCODE_GATEWAY_IT_URL 指向已有实例。`,
    );
  }
  log(`用 docker compose 启动本地 gateway（首次构建镜像可能需要几分钟）：${composeFile}`);
  let code;
  try {
    code = await run("docker", ["compose", "up", "-d"], {
      cwd: gatewayDir,
      env: { ...process.env, GATEWAY_ADMIN_TOKEN: adminToken, GATEWAY_PORT: port },
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("找不到 docker 命令；请安装 Docker，或用 ZCODE_GATEWAY_IT_URL 指向已有实例。");
    }
    throw error;
  }
  if (code !== 0) fail(`docker compose up -d 失败（退出码 ${code}）。`);
  if (!(await waitForHealthy(url))) fail(`本地实例没有就绪，${url} 不可用。`);
}

async function issueCredential(type, name) {
  const result = await requestJson(`${url}/api/admin/credentials`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ type, namespace, name }),
  });
  if (!result.body?.success) {
    const code = result.body?.error?.code ?? `HTTP ${result.status}`;
    if (result.status === 401 || result.status === 403) {
      const hint = externalUrl
        ? "请确认 ZCODE_GATEWAY_IT_ADMIN_TOKEN 与实例的 GATEWAY_ADMIN_TOKEN 一致。"
        : `本机已运行的实例可能用了另一个管理令牌：设置 GATEWAY_ADMIN_TOKEN，或先 \`docker compose -f ${composeFile} down\` 停掉旧实例。`;
      fail(`管理令牌被拒绝（${code}）。${hint}`);
    }
    fail(`签发 ${type} 凭证失败：${code}`);
  }
  if (typeof result.body.data?.token !== "string" || !result.body.data.token) {
    fail(`签发 ${type} 凭证的响应里没有 token 字段。`);
  }
  log(`已签发 ${type} 凭证（namespace=${namespace}, name=${name}）。`);
  return { token: result.body.data.token, id: result.body.data.id };
}

/** 复用本地配置里仍有效的凭证：只在地址一致、且实例确认凭证有效时复用。 */
async function ensureCredential(type, name, tokenKey, idKey) {
  const storedToken = storedMatchesUrl ? stored[tokenKey] : undefined;
  if (storedToken) {
    const status = await credentialStatus(url, storedToken);
    if (status === 200) {
      log(`复用本地配置里的 ${type} 凭证。`);
      return { token: storedToken, id: stored[idKey] };
    }
    if (status !== 401 && status !== 403) {
      fail(`校验本地配置里的 ${type} 凭证时返回 HTTP ${status}，无法判断凭证状态。`);
    }
    log(`本地配置里的 ${type} 凭证已失效（HTTP ${status}），重新签发。`);
  }
  return issueCredential(type, name);
}

if (!storedMatchesUrl && stored.ZCODE_GATEWAY_IT_URL) {
  log(
    `本地配置里的地址是 ${stored.ZCODE_GATEWAY_IT_URL}，与当前 ${url} 不同，按当前地址重新签发凭证。`,
  );
}

const backend = await ensureCredential(
  "backend",
  backendCredentialName,
  "ZCODE_GATEWAY_BACKEND_CREDENTIAL",
  "ZCODE_GATEWAY_BACKEND_CREDENTIAL_ID",
);
const device = await ensureCredential(
  "device",
  deviceCredentialName,
  "ZCODE_GATEWAY_DEVICE_CREDENTIAL",
  "ZCODE_GATEWAY_DEVICE_CREDENTIAL_ID",
);

/** 用单引号包裹值；引号本身和换行会破坏 dotenv 与 `source` 的解析，凭证值不该出现这些字符。 */
function quote(value) {
  if (typeof value !== "string" || value.includes("'") || /[\r\n]/.test(value)) {
    fail("准备写入的配置值包含不支持的字符。");
  }
  return `'${value}'`;
}

const values = {
  ZCODE_GATEWAY_IT_URL: url,
  ZCODE_GATEWAY_IT_ADMIN_TOKEN: adminToken,
  ZCODE_GATEWAY_NAMESPACE: namespace,
  ZCODE_GATEWAY_BACKEND_CREDENTIAL: backend.token,
  ZCODE_GATEWAY_BACKEND_CREDENTIAL_ID: backend.id,
  ZCODE_GATEWAY_DEVICE_CREDENTIAL: device.token,
  ZCODE_GATEWAY_DEVICE_CREDENTIAL_ID: device.id,
};

const lines = [
  "# 由 `pnpm dev:gateway`（scripts/dev-gateway.mjs）生成：含管理令牌与 gateway 凭证，切勿提交、外发或粘贴到日志。",
  "# 已被根 .gitignore 的 `.env.*.local` 忽略。加载：set -a; source .env.gateway.local; set +a",
];
const written = {};
for (const [key, value] of Object.entries(values)) {
  // 复用旧配置时可能拿不到凭证 id（id 不是凭证本身），缺失就整行不写，避免写出 "undefined"。
  if (value === undefined) continue;
  written[key] = value;
  lines.push(`${key}=${quote(value)}`);
}
const content = `${lines.join("\n")}\n`;
await writeFile(stateFile, content, { mode: 0o600 });

// 回读校验：确认写出的文件能被 dotenv / `node --env-file` 解析回同样的值。
const roundTrip = parseEnv(content);
for (const [key, value] of Object.entries(written)) {
  if (roundTrip[key] !== value) fail(`写入 ${stateFile} 后回读 ${key} 不一致。`);
}

log(`已写入 ${stateFile}（权限 0600，未纳入版本控制）。`);
console.log(stateFile);
