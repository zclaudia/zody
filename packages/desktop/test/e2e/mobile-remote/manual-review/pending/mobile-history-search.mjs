// MS-COMP-01: deterministic mobile search UI harness. It does not claim Gateway/Host routing coverage.
// Run: pnpm exec tsx packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-history-search.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const artifactDir = resolve(repoRoot, ".tmp/mobile-history-search-e2e");
const fixturePath = resolve(
  repoRoot,
  "packages/desktop/test/e2e/fixtures/cases/mobile-remote/mobile-history-search.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
await mkdir(artifactDir, { recursive: true });

const entryId = "\0mobile-history-search-e2e-entry";
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Event } from '@zody/rpc';
import { ServiceProvider } from '@/hooks/useServices.js';
import { PlatformProvider } from '@/hooks/usePlatform.js';
import { StoreProvider } from '@/store/StoreProvider.js';
import { ZodyIntlProvider } from '@/i18n/IntlProvider.js';
import { WebRemoteControlMobileSearch } from '@/WebRemoteControlMobileSearch.js';
import '@/styles.css';
const fixture = ${JSON.stringify(fixture)};
const workspaces = fixture.workspaces;
const calls = [];
function makeOutcome(request, status, items = []) {
  return { zcode_type: 'mobile-history-search-outcome', requestId: request.requestId,
    context: request.context, queryGeneration: request.queryGeneration,
    scopeSignature: request.scopeSignature, status, ...(status === 'ok' ? {items} : {errorCode: 'fixture-offline'}) };
}
function makeItem(workspace, result) {
  const workspaceKey = workspace.workspaceIdentity || workspace.workspacePath;
  return { workspaceKey, ...(workspace.remoteSessionId ? {remoteSessionId: workspace.remoteSessionId} : {}),
    task: { taskId: result.taskId, traceId: 'trace-' + result.taskId, title: result.title,
      workspacePath: workspace.workspacePath, ...(workspace.workspaceIdentity ? {workspaceIdentity: workspace.workspaceIdentity} : {}),
      workspacePurpose: 'project', createdAt: 1, updatedAt: 2, mode: 'default' }, snippets: [result.snippet] };
}
const send = (request) => {
  calls.push(request);
  if (request.query === 'stale-marker' && request.context.backendId === 'backend-old') {
    return new Promise((resolve) => { window.__stalePending = true; window.__resolveStale = () => resolve(makeOutcome(request, 'ok', [makeItem(workspaces[0], {taskId:'stale-task',title:'stale-marker old result',snippet:'stale-marker old body'})])); });
  }
  const workspace = workspaces.find((candidate) => (candidate.workspaceIdentity || candidate.workspacePath) === request.context.workspaceKey);
  if (workspace === workspaces[0] && request.context.backendId === 'backend-new') return Promise.resolve(makeOutcome(request, 'offline'));
  if (request.query === 'stale-marker' && request.context.backendId === 'backend-new') {
    return Promise.resolve(makeOutcome(request, 'ok', [makeItem(workspace, {taskId:'fresh-task',title:'stale-marker fresh result',snippet:'stale-marker fresh body'})]));
  }
  const result = fixture.results[request.context.workspaceKey];
  return Promise.resolve(makeOutcome(request, 'ok', result ? [makeItem(workspace, result)] : []));
};
const platform = { getDeviceId: async () => 'mobile-search-fixture' };
const broadcastService = { onMessage: Event.None, send: async () => {} };
const services = new Proxy({}, { get: (_target, key) => key === 'settingService'
  ? { get: async () => ({locale: 'en-US'}), update: async () => {} }
  : new Proxy({}, {get: () => async () => undefined}) });
function Harness() {
  const [backendId, setBackendId] = useState('backend-fixture');
  const [selected, setSelected] = useState(null);
  return React.createElement(React.Fragment, null,
    React.createElement('button', {type: 'button', onClick: () => setBackendId('backend-old'), 'data-testid': 'old-backend'}, 'Old backend'),
    React.createElement('button', {type: 'button', onClick: () => setBackendId('backend-new'), 'data-testid': 'new-backend'}, 'Reconnect'),
    React.createElement(WebRemoteControlMobileSearch, {
      workspaces, connection: {backendId, connectionGeneration: backendId === 'backend-fixture' ? 1 : 2},
      send, createRequestId: (() => { let id = 0; return () => 'fixture-' + (++id); })(),
      onBack: () => {}, onSelectTask: (target) => setSelected(target),
    }),
    React.createElement('output', {'data-testid': 'selected-target'}, JSON.stringify(selected)),
    React.createElement('output', {'data-testid': 'request-count'}, String(calls.length)));
}
createRoot(document.getElementById('root')).render(React.createElement(ServiceProvider, {services},
  React.createElement(StoreProvider, {broadcastService}, React.createElement(PlatformProvider, {platform},
    React.createElement(ZodyIntlProvider, null, React.createElement(Harness))))));
`;

const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "mobile-history-search-fixture",
      resolveId: (id) => (id === "/mobile-history-search-e2e-entry.jsx" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/mobile-history-search-fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<div id="root"></div><script type="module" src="/mobile-history-search-e2e-entry.jsx"></script>',
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
      "@zody/rpc": resolve(repoRoot, "packages/rpc/src/index.ts"),
    },
  },
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { entries: [], include: ["react", "react-dom/client", "react/jsx-runtime"] },
});

let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.setDefaultTimeout(15_000);
  try {
    await page.goto(`${origin}/mobile-history-search-fixture`);
    const query = page.getByRole("textbox", { name: "Search titles and messages" });
    await query.fill(fixture.query);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .locator('[data-mobile-page="search"]')
      .getByText("remote body E2E_MOBILE_PHASE1_SEARCH", { exact: false })
      .waitFor();
    await page.getByText("local body E2E_MOBILE_PHASE1_SEARCH", { exact: false }).waitFor();
    assert.equal(
      await page.locator("mark").count(),
      4,
      "query is highlighted in titles and snippets",
    );
    await page.getByRole("button", { name: /remote task/ }).click();
    const selected = JSON.parse(await page.getByTestId("selected-target").innerText());
    assert.deepEqual(selected, {
      workspaceKey: "remote:fixture:workspace",
      workspacePath: "/fixture/remote",
      workspaceIdentity: "remote:fixture:workspace",
      remoteSessionId: "session-fixture",
      taskId: "task-remote",
      search: {
        query: fixture.query,
        snippet: fixture.results["remote:fixture:workspace"].snippet,
        snippetIndex: 0,
      },
    });

    await page.getByTestId("old-backend").click();
    await page.getByRole("button", { name: "Search", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector('[data-mobile-page="search"] button[type="submit"]')?.disabled,
    );
    await page.getByRole("textbox", { name: "Search titles and messages" }).fill("stale-marker");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForFunction(() => window.__stalePending === true);
    await page.getByTestId("new-backend").click();
    await page.getByText("A workspace is offline; its results are unavailable.").waitFor();
    await page
      .locator('[data-mobile-page="search"]')
      .getByText("stale-marker fresh body", { exact: false })
      .waitFor();
    assert.equal(
      await page.evaluate(() => typeof window.__resolveStale),
      "function",
      "old-generation request was held pending",
    );
    await page.evaluate(() => window.__resolveStale());
    await page.waitForTimeout(0);
    assert.equal(
      await page.getByText("stale-marker old result", { exact: false }).count(),
      0,
      "outcome from old backend generation is ignored",
    );
    assert.equal(
      await page
        .locator('[data-mobile-page="search"]')
        .getByText("stale-marker fresh result", { exact: false })
        .count(),
      1,
      "latest backend outcome is visible after stale response settles",
    );
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: resolve(artifactDir, "mobile-history-search.png") });
    console.log(
      "PASS MS-COMP-01 cross-workspace search, partial source state, stale response, navigation target, and highlight",
    );
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
