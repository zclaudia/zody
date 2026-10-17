import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(import.meta.dirname, "dev-gateway.mjs");
const adminToken = "test-admin-token";
const tempDirs = [];

/** 用假 gateway 驱动 dev-gateway.mjs：只实现它用到的 /health、discovery 与 admin 签发接口。 */
async function startFakeGateway() {
  const state = { issued: [], valid: new Set(), discoveryCalls: [] };
  const server = createServer((req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /u, "");
    if (req.url === "/health") {
      respond(200, { status: "ok" });
      return;
    }
    if (req.url === "/api/discovery/backends") {
      state.discoveryCalls.push(token);
      respond(
        state.valid.has(token) ? 200 : 401,
        state.valid.has(token)
          ? { success: true, data: { items: [] } }
          : { success: false, error: { code: "UNAUTHORIZED" } },
      );
      return;
    }
    if (req.url === "/api/admin/credentials" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        if (token !== adminToken) {
          respond(401, { success: false, error: { code: "UNAUTHORIZED" } });
          return;
        }
        const { type, namespace, name } = JSON.parse(body);
        const issued = {
          type,
          namespace,
          name,
          id: `cred-${state.issued.length + 1}`,
          token: `${type === "backend" ? "zgb" : "zgd"}_test${state.issued.length + 1}`,
        };
        state.issued.push(issued);
        state.valid.add(issued.token);
        respond(201, { success: true, data: issued });
      });
      return;
    }
    respond(404, { success: false, error: { code: "NOT_FOUND" } });
  });
  const url = await new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${server.address().port}`));
  });
  return { state, url, close: () => new Promise((done) => server.close(done)) };
}

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "dev-gateway-test-"));
  tempDirs.push(dir);
  return dir;
}

/** 清掉环境里可能存在的 gateway 变量，避免宿主机配置影响断言。 */
function cleanEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:ZCODE_GATEWAY_|GATEWAY_|ZCLAUDIA_GATEWAY_)/u.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function runScript(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [scriptPath], { env: cleanEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function expectNoCredentialLeak(output, credentials) {
  for (const credential of credentials) {
    expect(output).not.toContain(credential);
  }
  expect(output).not.toMatch(/zg[bad]_/u);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("dev-gateway.mjs", () => {
  it("签发 backend 与 device 凭证，stdout 只输出配置路径", async () => {
    const gateway = await startFakeGateway();
    const envFile = join(await tempDir(), "gateway.env");
    try {
      const result = await runScript({
        ZCODE_GATEWAY_IT_URL: gateway.url,
        ZCODE_GATEWAY_IT_ADMIN_TOKEN: adminToken,
        ZCODE_GATEWAY_ENV_FILE: envFile,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${envFile}\n`);
      expect(gateway.state.issued.map(({ type }) => type)).toEqual(["backend", "device"]);
      expect(gateway.state.issued.map(({ namespace }) => namespace)).toEqual(["zcode", "zcode"]);
      expectNoCredentialLeak(result.stdout + result.stderr, [
        adminToken,
        ...gateway.state.issued.map(({ token }) => token),
      ]);

      const written = parseEnv(await readFile(envFile, "utf8"));
      expect(written.ZCODE_GATEWAY_IT_URL).toBe(gateway.url);
      expect(written.ZCODE_GATEWAY_IT_ADMIN_TOKEN).toBe(adminToken);
      expect(written.ZCODE_GATEWAY_NAMESPACE).toBe("zcode");
      expect(written.ZCODE_GATEWAY_BACKEND_CREDENTIAL).toBe(gateway.state.issued[0].token);
      expect(written.ZCODE_GATEWAY_DEVICE_CREDENTIAL).toBe(gateway.state.issued[1].token);
    } finally {
      await gateway.close();
    }
  });

  it("重复执行复用仍然有效的凭证", async () => {
    const gateway = await startFakeGateway();
    const envFile = join(await tempDir(), "gateway.env");
    try {
      const env = {
        ZCODE_GATEWAY_IT_URL: gateway.url,
        ZCODE_GATEWAY_IT_ADMIN_TOKEN: adminToken,
        ZCODE_GATEWAY_ENV_FILE: envFile,
      };
      await runScript(env);
      const first = await readFile(envFile, "utf8");
      const second = await runScript(env);

      expect(second.code).toBe(0);
      expect(second.stdout).toBe(`${envFile}\n`);
      expect(gateway.state.issued).toHaveLength(2);
      expect(await readFile(envFile, "utf8")).toBe(first);
      expect(gateway.state.discoveryCalls).toEqual(
        expect.arrayContaining(gateway.state.issued.map(({ token }) => token)),
      );
    } finally {
      await gateway.close();
    }
  });

  it("本地配置里的凭证已失效时重新签发", async () => {
    const gateway = await startFakeGateway();
    const envFile = join(await tempDir(), "gateway.env");
    try {
      const env = {
        ZCODE_GATEWAY_IT_URL: gateway.url,
        ZCODE_GATEWAY_IT_ADMIN_TOKEN: adminToken,
        ZCODE_GATEWAY_ENV_FILE: envFile,
      };
      await runScript(env);
      const [backend, device] = gateway.state.issued;
      gateway.state.valid.delete(device.token);

      const result = await runScript(env);
      expect(result.code).toBe(0);
      expect(gateway.state.issued).toHaveLength(3);
      const written = parseEnv(await readFile(envFile, "utf8"));
      expect(written.ZCODE_GATEWAY_DEVICE_CREDENTIAL).toBe(gateway.state.issued[2].token);
      expect(written.ZCODE_GATEWAY_BACKEND_CREDENTIAL).toBe(backend.token);
      expect(gateway.state.issued[2].namespace).toBe("zcode");
    } finally {
      await gateway.close();
    }
  });

  it("已有实例模式下没有管理令牌时失败且不写配置", async () => {
    const gateway = await startFakeGateway();
    const envFile = join(await tempDir(), "gateway.env");
    try {
      const result = await runScript({
        ZCODE_GATEWAY_IT_URL: gateway.url,
        ZCODE_GATEWAY_ENV_FILE: envFile,
      });

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("ZCODE_GATEWAY_IT_ADMIN_TOKEN");
      expect(existsSync(envFile)).toBe(false);
      expect(gateway.state.issued).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });

  it("管理令牌被拒绝时不写出凭证", async () => {
    const gateway = await startFakeGateway();
    const envFile = join(await tempDir(), "gateway.env");
    try {
      const result = await runScript({
        ZCODE_GATEWAY_IT_URL: gateway.url,
        ZCODE_GATEWAY_IT_ADMIN_TOKEN: "wrong-admin-token",
        ZCODE_GATEWAY_ENV_FILE: envFile,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("管理令牌被拒绝");
      expect(existsSync(envFile)).toBe(false);
      expect(gateway.state.issued).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });
});
