import { createServer } from "node:http";
import type { GatewayE2EConfig } from "./mobile-remote-gateway.js";
import { mobileCuaGatewayOrigin } from "./mobile-cua-url.js";

/** 仅模拟 Android 资源代理，所有字节均由当前候选 backend 经真实 gateway 返回。 */
export async function startMobileCuaAssetProxy(config: GatewayE2EConfig, backendId: string) {
  const stats = { retry429: 0, status200: 0, otherStatus: 0 };
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (active >= 4) await new Promise<void>((done) => queue.push(done));
    else active++;
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  const gatewayOrigin = mobileCuaGatewayOrigin(config.gatewayUrl);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (
      req.method !== "GET" ||
      !(url.pathname.startsWith("/assets/remote/") || url.pathname === "/mobile-ui/release")
    ) {
      res.writeHead(404).end();
      return;
    }
    await acquire();
    try {
      const endpoint = `${gatewayOrigin}/api/proxy/${encodeURIComponent(backendId)}${url.pathname}${url.search}`;
      const options = {
        headers: {
          authorization: `Bearer ${config.deviceCredential}`,
          "accept-encoding": "identity",
        },
        signal: AbortSignal.timeout(20_000),
      };
      let response = await fetch(endpoint, options);
      for (let attempt = 0; response.status === 429 && attempt < 2; attempt++) {
        const header = response.headers.get("retry-after");
        if (header === null || !/^\d+$/u.test(header)) break;
        const seconds = Number(header);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) break;
        stats.retry429++;
        await new Promise((done) => setTimeout(done, (seconds + 1) * 1000));
        response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(20_000) });
      }
      if (response.status === 200) stats.status200++;
      else stats.otherStatus++;
      const headers: Record<string, string> = {};
      for (const name of [
        "content-type",
        "cache-control",
        "content-security-policy",
        "x-content-type-options",
        "referrer-policy",
      ]) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, headers).end(bytes);
    } catch {
      stats.otherStatus++;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally {
      release();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local mobile asset proxy failed to bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stats,
    async close() {
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
