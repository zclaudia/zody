// MN-UI-01: real notification UI with a case-local fake reader and route callback.
// This does not exercise Gateway, Host persistence, ntfy, or Android delivery.
// Run: pnpm exec tsx packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-notification-center.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const fixture = JSON.parse(
  await readFile(
    resolve(
      repoRoot,
      "packages/desktop/test/e2e/fixtures/cases/mobile-remote/notification-center.json",
    ),
    "utf8",
  ),
);
const artifactDir = resolve(repoRoot, ".tmp/mobile-notification-center-e2e");
await mkdir(artifactDir, { recursive: true });
const entryId = "\0mobile-notification-center-e2e-entry";
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Emitter} from '@zcode/rpc';
import {PlatformProvider} from '@/hooks/usePlatform.js';
import {ZCodeIntlProvider} from '@/i18n/IntlProvider.js';
import {MobileNotificationsFeature} from '@/MobileNotificationsFeature.js';
const fixture = ${JSON.stringify(fixture)};
const changed = new Emitter();
const items = fixture.notifications.map((item) => ({...item, target:fixture.workspace, read:false, deliveryState:'accepted'}));
let deferNextPage = true;
const markReadCalls = [];
const reader = {
  listFeed: async ({before} = {}) => {
    if (!before) { window.__feedRefreshCalls=(window.__feedRefreshCalls||0)+1; return {items:[items[0]], nextCursor:{occurredAt:items[0].occurredAt, notificationId:items[0].notificationId}, unreadCount:items.filter((item) => !item.read).length}; }
    const page = {items:[items[0], items[1]], unreadCount:items.filter((item) => !item.read).length};
    if (deferNextPage) {
      deferNextPage = false;
      return new Promise((resolve) => { window.__resolvePage = () => { window.__pageResolved=true; resolve(page); }; });
    }
    return page;
  },
  onFeedChanged: changed.event,
  markRead: async ({notificationId}) => { markReadCalls.push(notificationId); const item=items.find((value)=>value.notificationId===notificationId); if(item) item.read=true; changed.fire(); },
  markAllRead: async () => {},
};
let openAttempts = 0;
const switcher = {
  getNotificationReader: () => reader,
  openNotification: async (id) => {
    openAttempts++;
    if (openAttempts === 1) throw new Error('fixture route failed');
    await new Promise((resolve) => { window.__resolveOpen = resolve; });
    if (id !== 'notification-recovered') throw new Error('wrong notification target');
    await reader.markRead({notificationId:id});
  },
};
createRoot(document.getElementById('root')).render(
  React.createElement(React.Fragment, null,
    React.createElement('button', {type:'button', onClick:()=>changed.fire()}, 'Simulate feed change'),
    React.createElement(PlatformProvider, {platform:undefined},
      React.createElement(ZCodeIntlProvider, null,
        React.createElement(MobileNotificationsFeature, {switcher, onBack:()=>{}})))),
);
window.__markReadCalls = markReadCalls;
`;
const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "mobile-notification-center-fixture",
      resolveId: (id) => (id === "/mobile-notification-center-e2e-entry.jsx" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/mobile-notification-center-fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><div id="root"></div><script type="module" src="/mobile-notification-center-e2e-entry.jsx"></script>',
            ),
          );
        });
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": resolve(repoRoot, "packages/ui/src"),
      "@zcode/rpc": resolve(repoRoot, "packages/rpc/src/index.ts"),
    },
  },
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react/jsx-runtime"] },
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.goto(
    `http://127.0.0.1:${vite.httpServer.address().port}/mobile-notification-center-fixture`,
  );
  const recovered = page.getByRole("button", { name: /Recovered build/ });
  await recovered.waitFor();
  assert.equal(await recovered.getByText("Recovered", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Load more" }).click();
  await page.waitForFunction(() => typeof window.__resolvePage === "function");
  await page.getByRole("button", { name: "Simulate feed change" }).click();
  await page.waitForFunction(() => window.__feedRefreshCalls === 2);
  await page.evaluate(() => window.__resolvePage());
  await page.waitForFunction(() => window.__pageResolved === true);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Load more" && !button.disabled,
    ),
  );
  assert.equal(
    await page.getByRole("button", { name: /Resolved question/ }).count(),
    0,
    "refresh invalidates a stale page request",
  );
  await page.getByRole("button", { name: "Load more" }).click();
  const resolved = page.getByRole("button", { name: /Resolved question/ });
  await resolved.waitFor();
  assert.equal(await resolved.getByText("Resolved", { exact: true }).count(), 1);
  assert.equal(
    await page.getByRole("button", { name: /Recovered build/ }).count(),
    1,
    "duplicate page item is removed",
  );

  await recovered.click();
  await page.getByRole("alert").filter({ hasText: "Could not open this notification" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: /Recovered build.*Unread/ }).count(),
    1,
    "failed navigation preserves unread state",
  );
  await page.getByRole("button", { name: /Recovered build/ }).click();
  await page.waitForFunction(() => typeof window.__resolveOpen === "function");
  assert.equal(
    await page.getByRole("button", { name: /Recovered build.*Unread/ }).count(),
    1,
    "read waits for route completion",
  );
  assert.deepEqual(await page.evaluate(() => window.__markReadCalls), []);
  await page.evaluate(() => window.__resolveOpen());
  await page
    .getByRole("button", { name: /Recovered build.*Unread/ })
    .waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__markReadCalls), ["notification-recovered"]);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(artifactDir, "notification-center.png"), fullPage: true });
  console.log(
    "PASS MN-UI-01 pagination/dedup, recovered/resolved badges, failed route unread retention, and deferred read acknowledgment",
  );
} finally {
  await browser?.close();
  await vite.close();
}
