import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceCollection } from "@zody/services";
import { SERVER_REMOTE_PROTOCOL_VERSION } from "@zody/shared";
import { createHttpServer } from "../src/http.js";

async function boundAddress(server: ReturnType<typeof createHttpServer>): Promise<AddressInfo> {
  if (!server.listening) await once(server, "listening");
  return server.address() as AddressInfo;
}

describe("server info HTTP endpoint", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("binds only to loopback when no host is configured", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    expect((await boundAddress(server)).address).toBe("127.0.0.1");
  });

  it.each(["0.0.0.0", "::"])(
    "rejects an unauthenticated network listener on %s before listening",
    (host) => {
      expect(() => {
        const server = createHttpServer(new ServiceCollection(), 0, { host });
        servers.push(server);
      }).toThrow("Non-loopback HTTP listeners require an authToken");
    },
  );

  it("rejects a declared authentication requirement without a token", () => {
    expect(() => {
      const server = createHttpServer(new ServiceCollection(), 0, { authRequired: true });
      servers.push(server);
    }).toThrow("authRequired requires an authToken");
  });

  it("rejects cross-site browser requests and rebinding hosts before capability issuance", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = await boundAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const origin of ["https://untrusted.example", "null"]) {
      const rejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
        method: "POST",
        headers: { origin },
      });
      expect(rejected.status).toBe(403);
      const upgrade = await fetch(`${baseUrl}/ws`, { headers: { origin } });
      expect(upgrade.status).toBe(403);
    }
    // Node fetch 会规范化 Host；使用真实 HTTP 请求验证重绑定头。
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        `${baseUrl}/api/rpc-host-capability`,
        {
          method: "POST",
          headers: { host: `untrusted.example:${address.port}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(reboundStatus).toBe(403);
    const accepted = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    expect(accepted.status).toBe(200);
  });

  it("returns desktop connector bootstrap metadata", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      serverId: "studio",
      name: "Studio Server",
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
    });
    servers.push(server);
    const address = await boundAddress(server);

    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      serverId: "studio",
      name: "Studio Server",
      version: expect.any(String),
      protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
      authRequired: false,
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });
  });

  it("requires the lite token for protected API routes", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      authToken: "secret-token",
    });
    servers.push(server);
    const address = await boundAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rejected = await fetch(`${baseUrl}/api/server-info`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/server-info?token=secret-token`);
    expect(accepted.status).toBe(200);
    await expect(accepted.clone().json()).resolves.toMatchObject({ authRequired: true });
    expect(accepted.headers.get("set-cookie")).toContain("zody_lite_token=");

    const cookieAccepted = await fetch(`${baseUrl}/api/server-info`, {
      headers: {
        cookie: "zody_lite_token=secret-token",
      },
    });
    expect(cookieAccepted.status).toBe(200);

    const capabilityRejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(capabilityRejected.status).toBe(401);
    const capabilityAccepted = await fetch(
      `${baseUrl}/api/rpc-host-capability?token=secret-token`,
      { method: "POST" },
    );
    expect(capabilityAccepted.status).toBe(200);
    await expect(capabilityAccepted.json()).resolves.toMatchObject({
      capability: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("serves static web files with SPA fallback", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>lite</html>", "utf8");
    await writeFile(join(staticRoot, "app.js"), "console.log('lite');", "utf8");

    const server = createHttpServer(new ServiceCollection(), 0, {
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    const address = await boundAddress(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const asset = await fetch(`${baseUrl}/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    await expect(asset.text()).resolves.toBe("console.log('lite');");

    const fallback = await fetch(`${baseUrl}/workspace/deep/link`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    await expect(fallback.text()).resolves.toBe("<html>lite</html>");

    // F4.10：`/web-remote` 不再有 OAuth 登录门，必须由 SPA fallback 直接返回 Web 入口。
    const webRemoteEntry = await fetch(`${baseUrl}/web-remote`);
    expect(webRemoteEntry.status).toBe(200);
    expect(webRemoteEntry.headers.get("content-type")).toContain("text/html");
    await expect(webRemoteEntry.text()).resolves.toBe("<html>lite</html>");

    const apiFallback = await fetch(`${baseUrl}/api/missing`);
    expect(apiFallback.status).toBe(404);
  });
});
