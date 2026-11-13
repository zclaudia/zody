import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { mobileCuaBridgeScript } from "./mobile-cua-url.js";
import { resolveGatewayE2EConfig } from "./mobile-remote-gateway.js";

// 本地制品仅用于隔离启动故障，不证明 gateway 资源链、Host 或 03d 验收。
const root = process.env.ZODY_MOBILE_SMOKE_ASSETS;
if (!root) throw new Error("ZODY_MOBILE_SMOKE_ASSETS required");
const config = await resolveGatewayE2EConfig();
if (!config) throw new Error("Gateway config unavailable");
const base = resolve(root);
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const relative =
    path === "/mobile-ui/release" ? "release.json" : path.replace(/^\/assets\/remote\//u, "");
  const target = resolve(base, relative);
  if (!target.startsWith(`${base}${sep}`)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": mime[extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Smoke server unavailable");
const b = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ...(process.env.ZODY_MOBILE_SMOKE_SPKI
    ? { args: [`--ignore-certificate-errors-spki-list=${process.env.ZODY_MOBILE_SMOKE_SPKI}`] }
    : {}),
});
try {
  const c = await b.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await c.newPage();
  const counts = { socketCreated: 0, socketErrors: 0, pageErrors: 0, consoleErrors: 0 };
  const errorKinds = new Set<string>();
  const wsErrors: string[] = [];
  page.on("websocket", (socket) => {
    counts.socketCreated++;
    socket.on("socketerror", () => counts.socketErrors++);
  });
  page.on("pageerror", () => counts.pageErrors++);
  page.on("console", (event) => {
    if (event.type() === "error") {
      counts.consoleErrors++;
      const message = event.text();
      for (const code of [
        "ERR_CERT_AUTHORITY_INVALID",
        "ERR_CERT_COMMON_NAME_INVALID",
        "ERR_CONNECTION_CLOSED",
        "ERR_CONNECTION_RESET",
        "Content Security Policy",
        "Mixed Content",
        "WebSocket",
      ])
        if (message.includes(code)) errorKinds.add(code);
      if (message.includes("WebSocket"))
        wsErrors.push(
          message
            .replace(/(?:https?|wss?):\/\/[^\s'"]+/gu, "<gateway>")
            .replaceAll(config.deviceCredential, "<redacted>")
            .slice(0, 250),
        );
    }
  });
  await page.addInitScript({
    content: mobileCuaBridgeScript({
      schemaVersion: 1,
      sessionId: "smoke",
      gatewayUrl: config.gatewayUrl,
      namespace: config.namespace,
      credential: config.deviceCredential,
      backendId: "offline-diagnostic",
      clientInstanceId: "smoke",
      appVersion: "1.0.0",
      bridgeCapabilities: {
        schemaVersion: 1,
        bridgeVersion: 1,
        appVersion: "1.0.0",
        capabilities: ["session-context"],
      },
    }),
  });
  await page.addInitScript({
    content: `(function(){const d={attempts:0,throws:0,rejections:0};globalThis.__smoke=d;const Original=globalThis.WebSocket;globalThis.WebSocket=new Proxy(Original,{construct:function(target,args,newTarget){d.attempts++;try{return Reflect.construct(target,args,newTarget)}catch(e){d.throws++;throw e}}});addEventListener('unhandledrejection',function(){d.rejections++})})()`,
  });
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const origin =
    process.env.ZODY_MOBILE_SMOKE_TLS_ORIGIN === "1"
      ? new URL(config.gatewayUrl).origin
      : localOrigin;
  if (origin !== localOrigin)
    await page.route(
      (url) =>
        url.origin === origin &&
        (url.pathname.startsWith("/assets/remote/") || url.pathname === "/mobile-ui/release"),
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        const response = await route.fetch({ url: `${localOrigin}${path}` });
        await route.fulfill({ response });
      },
    );
  await page.goto(`${origin}/assets/remote/index.html`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.waitForTimeout(8_000);
  const state = await page.evaluate(() => (globalThis as unknown as { __smoke: unknown }).__smoke);
  process.stdout.write(
    JSON.stringify({
      diagnosticOnly: true,
      localAssetsAndRelease: true,
      ...counts,
      errorKinds: [...errorKinds],
      wsErrors,
      state,
    }) + "\n",
  );
} finally {
  await b.close();
  server.close();
}
