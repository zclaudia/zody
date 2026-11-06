// MC-SHELL-01: real mobile shell and overlay components with synthetic services; no Gateway/Android claims.
// Run: pnpm exec tsx packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-shell-routing.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const artifactDir = resolve(repoRoot, ".tmp/mobile-shell-routing-e2e");
const fixture = JSON.parse(
  await readFile(
    resolve(
      repoRoot,
      "packages/desktop/test/e2e/fixtures/cases/mobile-remote/mobile-shell-routing.json",
    ),
    "utf8",
  ),
);
await mkdir(artifactDir, { recursive: true });

const entryId = "\0mobile-shell-routing-e2e-entry";
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Event} from '@zcode/rpc';
import {ServiceProvider} from '@/hooks/useServices.js';
import {PlatformProvider} from '@/hooks/usePlatform.js';
import {StoreProvider} from '@/store/StoreProvider.js';
import {TabStoreProvider} from '@/store/TabStoreProvider.js';
import {ZCodeIntlProvider} from '@/i18n/IntlProvider.js';
import {WebRemoteControlMobileShell} from '@/WebRemoteControlMobileShell.js';
import '@/styles.css';
const fixture = ${JSON.stringify(fixture)};
const workspace = fixture.workspace;
const workspaces = [workspace];
const readCalls = [];
const searchCalls = [];
let refreshHarness = () => {};
const backHandlers = new Set();
let workspaceListListener;
const fileService = {
  readdir: async ({path, includeHidden, mobileBudget}) => {
    readCalls.push({path, includeHidden, mobileBudget});
    refreshHarness();
    return fixture.directories[path] ?? [];
  },
  stat: async ({path}) => ({path, type: fixture.directories[path] ? 'directory' : 'file', size: 12, mtimeMs: 1}),
  readTextFile: async ({path}) => ({path, content: 'fixture content', offset: 0, bytesRead: 16, totalBytes: 16, truncated: false, isBinary: false}),
  readMediaPreview: async ({path}) => ({path, mediaType: 'image/png', dataBase64: '', totalBytes: 0}),
  readBinaryPreview: async ({path}) => ({path, dataBase64: '', totalBytes: 0}),
  readFileRange: async () => new Uint8Array(),
};
const fileWatcherService = {watch: async () => ({id: 'watch'}), unwatch: async () => {}, onDynamicChange: () => Event.None};
const services = new Proxy({fileService, fileWatcherService}, {get: (target, key) => key in target ? target[key] : new Proxy({}, {get: () => async () => undefined})});
const platform = {
  getDeviceId: async () => 'mobile-shell-fixture',
  getInstalledEditors: async () => [],
  onBackPressed: (handler) => { backHandlers.add(handler); return () => backHandlers.delete(handler); },
};
const broadcastService = {onMessage: Event.None, send: async () => {}};
function outcome(request, items) {
  return {zcode_type: 'mobile-history-search-outcome', requestId: request.requestId, context: request.context,
    queryGeneration: request.queryGeneration, scopeSignature: request.scopeSignature, status: 'ok', items};
}
function makeItem(target, result) {
  return {workspaceKey: target.workspaceIdentity || target.workspacePath,
    remoteSessionId: target.remoteSessionId,
    task: {taskId: result.taskId, traceId: 'trace-' + result.taskId, title: result.title,
      workspacePath: target.workspacePath, workspaceIdentity: target.workspaceIdentity,
      workspacePurpose: 'project', createdAt: 1, updatedAt: 2, mode: 'default'},
    snippets: [result.snippet]};
}
const switcher = {
  getMobileCapabilities: () => ({fileBrowser: 1, historySearch: 1}),
  getMobileConnection: () => ({backendId: 'backend-fixture', connectionGeneration: 1}),
  listWorkspaces: async () => ({workspaces}),
  onWorkspaceListUpdated: (listener) => { workspaceListListener = listener; return () => {workspaceListListener = undefined;}; },
  switchWorkspace: async (workspaceKey, options) => { window.__switches.push({workspaceKey, options}); refreshHarness(); },
  searchMobileHistory: async (request) => {
    searchCalls.push(request);
    refreshHarness();
    const target = [...workspaces, fixture.addedWorkspace].find((item) => (item.workspaceIdentity || item.workspacePath) === request.context.workspaceKey);
    const result = fixture.results[request.context.workspaceKey];
    return outcome(request, target && result ? [makeItem(target, result)] : []);
  },
  updateMobileViewState: async () => {},
  onNavigationMounted: () => {},
};
window.__switches = [];
function Harness() {
  const [request, setRequest] = useState(null);
  const [, updateCalls] = useState(0);
  refreshHarness = () => updateCalls((value) => value + 1);
  window.__updateHarness = refreshHarness;
  return React.createElement(React.Fragment, null,
    React.createElement('button', {type:'button', 'data-testid':'open-reveal', onClick: () => setRequest({id:1, target:{...workspace, workspaceName:'Fixture', revealPath:'/fixture/workspace/src'}})}, 'Open reveal request'),
    React.createElement('button', {type:'button', 'data-testid':'open-remote-reveal', onClick: () => setRequest({id:2, target:{...fixture.addedWorkspace, workspaceName:'Added', workspaceRemoteSessionId:fixture.addedWorkspace.remoteSessionId, revealPath:'/fixture/workspace/src'}})}, 'Open another identity reveal'),
    React.createElement('button', {type:'button', 'data-testid':'add-workspace', onClick: () => {workspaces.push(fixture.addedWorkspace); workspaceListListener?.({workspaces}); window.__updateHarness();}}, 'Add open workspace'),
    React.createElement(WebRemoteControlMobileShell, {
      switcher, activeWorkspacePath:workspace.workspacePath, activeWorkspaceIdentity:workspace.workspaceIdentity,
      workspaceRemoteSessionId:workspace.workspaceRemoteSessionId, activeTaskId:'task-current',
      initialNavigationIntent:'chat', fileTreeOpenRequest:request,
      // 设置入口统一进入应用设置；这里验证齿轮按钮点击一次直接进入，不再展开菜单。
      onOpenAppSettings:() => { window.__settingsMenuOpened = true; },
      onSelectTask:() => {}, renderChatHeader:() => null,
      chatContent:React.createElement('textarea', {'data-testid':'composer', defaultValue:'draft stays in chat'}),
    }),
    React.createElement('output', {'data-testid':'read-calls'}, JSON.stringify(readCalls)),
    React.createElement('output', {'data-testid':'search-calls'}, JSON.stringify(searchCalls)),
    React.createElement('output', {'data-testid':'switches'}, JSON.stringify(window.__switches)));
}
createRoot(document.getElementById('root')).render(
  React.createElement(ServiceProvider, {services},
    React.createElement(TabStoreProvider, null,
      React.createElement(StoreProvider, {broadcastService},
        React.createElement(PlatformProvider, {platform},
          React.createElement(ZCodeIntlProvider, null, React.createElement(Harness)))))));
window.__dispatchBack = () => { for (const handler of backHandlers) if (handler()) return true; return false; };
`;

const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "mobile-shell-routing-fixture",
      resolveId: (id) => (id === "/mobile-shell-routing-e2e-entry.jsx" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/mobile-shell-routing-fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><div id="root"></div><script type="module" src="/mobile-shell-routing-e2e-entry.jsx"></script>',
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
  try {
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await page.goto(`${origin}/mobile-shell-routing-fixture`);
    const composer = page.getByTestId("composer");
    await composer.fill("composer draft to preserve");
    // MC-SHELL-02：齿轮按钮点击一次直接进入应用设置，不再先展开单项菜单。
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(await page.getByRole("menuitem").count(), 0, "settings button opens no menu");
    await page.waitForFunction(() => window.__settingsMenuOpened === true);
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "src", exact: true }).waitFor();
    assert.equal(
      await page.locator('[data-mobile-feature-overlay="files"][role="dialog"]').count(),
      1,
    );
    const reads = JSON.parse(await page.getByTestId("read-calls").innerText());
    assert.deepEqual(reads[0].mobileBudget, { maxEntries: 5000, maxResponseBytes: 1048576 });
    assert.equal(await page.locator("[data-mobile-feature-overlay] ~ *").count(), 0);
    assert.equal(
      await page.evaluate(() => window.__dispatchBack()),
      true,
      "file browser consumes Android back after shell yields",
    );
    await page.getByRole("button", { name: "Files", exact: true }).waitFor();
    await page.getByTestId("open-reveal").click();
    await page.getByRole("button", { name: "read me.txt", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await composer.inputValue(), "composer draft to preserve");

    await page.getByTestId("open-remote-reveal").click();
    await page.waitForFunction(() =>
      JSON.parse(document.querySelector("[data-testid=switches]")?.textContent || "[]").some(
        (item) => item.options.mobileNavigationIntent === "files",
      ),
    );
    const fileSwitch = JSON.parse(await page.getByTestId("switches").innerText()).at(-1);
    assert.equal(
      fileSwitch.workspaceKey,
      fixture.addedWorkspace.workspaceIdentity,
      "same path with another identity routes to that workspace",
    );
    assert.equal(fileSwitch.options.mobileNavigationIntent, "files");

    await page.getByRole("button", { name: "Search history", exact: true }).click();
    await page.getByRole("textbox", { name: "Search titles and messages" }).fill(fixture.query);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByText("Current workspace task", { exact: false }).waitFor();
    await page.getByTestId("add-workspace").click();
    await page.getByText("Newly opened workspace task", { exact: false }).waitFor();
    const searchCalls = JSON.parse(await page.getByTestId("search-calls").innerText());
    assert.ok(
      searchCalls.some(
        (call) => call.context.workspaceKey === fixture.addedWorkspace.workspaceIdentity,
      ),
    );
    await page.getByRole("button", { name: /Newly opened workspace task/ }).click();
    const switches = JSON.parse(await page.getByTestId("switches").innerText());
    assert.equal(switches.at(-1).workspaceKey, fixture.addedWorkspace.workspaceIdentity);
    assert.equal(switches.at(-1).options.mobileNavigationIntent, "chat");
    assert.equal(await composer.inputValue(), "composer draft to preserve");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(artifactDir, "mobile-shell-routing.png") });
    console.log(
      "PASS MC-SHELL-01/02 file entry/reveal/back, composer preservation, live search scope update, task navigation, and single settings entry",
    );
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
