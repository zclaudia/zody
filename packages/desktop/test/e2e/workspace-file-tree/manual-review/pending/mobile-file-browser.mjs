// MF-COMP-01：移动文件浏览组件与 FileService 契约；不覆盖真实 Gateway、SSH Host 或 Android 下载桥。
// 运行：pnpm exec tsx packages/desktop/test/e2e/workspace-file-tree/manual-review/pending/mobile-file-browser.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const artifactDir = resolve(repoRoot, ".tmp/mobile-file-browser-e2e");
const fixturePath = resolve(
  repoRoot,
  "packages/desktop/test/e2e/fixtures/cases/workspace-file-tree/mobile-file-browser.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
await mkdir(artifactDir, { recursive: true });

const entryId = "\0mobile-file-browser-e2e-entry";
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Event } from '@zody/rpc';
import { ServiceProvider } from '@/hooks/useServices.js';
import { PlatformProvider } from '@/hooks/usePlatform.js';
import { StoreProvider } from '@/store/StoreProvider.js';
import { TabStoreProvider } from '@/store/TabStoreProvider.js';
import { ZCodeIntlProvider } from '@/i18n/IntlProvider.js';
import { MobileWorkspaceFileBrowser } from '@/MobileWorkspaceFileBrowser.js';
import '@/styles.css';
const fixture = ${JSON.stringify(fixture)};
const readCalls = [];
let updateReadCalls = () => {};
const fileService = {
  readdir: async ({path, includeHidden, mobileBudget}) => {
    readCalls.push({path, includeHidden, mobileBudget});
    updateReadCalls([...readCalls]);
    if (new URLSearchParams(location.search).has('large')) {
      const error = new Error('DIRECTORY_TOO_LARGE: fixture cap');
      error.code = 'DIRECTORY_TOO_LARGE';
      throw error;
    }
    return fixture.directories[path] ?? [];
  },
  stat: async ({path}) => ({path, type: fixture.directories[path] ? 'directory' : 'file', size: 16, mtimeMs: 1}),
  readTextFile: async ({path}) => ({path, content: fixture.textFiles[path] ?? 'Fixture content', offset: 0, bytesRead: 20, totalBytes: 20, truncated: false, isBinary: false}),
  readMediaPreview: async ({path}) => ({path, mediaType: 'image/png', dataBase64: '', totalBytes: 0}),
  readBinaryPreview: async ({path}) => ({path, dataBase64: '', totalBytes: 0}),
  readFileRange: async () => new Uint8Array(),
};
const fileWatcherService = {
  watch: async () => ({id: 'fixture-watch'}),
  unwatch: async () => {},
  onDynamicChange: () => Event.None,
};
const services = new Proxy({fileService, fileWatcherService}, {
  get(target, key) {
    if (key in target) return target[key];
    return new Proxy({}, {get: () => async () => undefined});
  },
});
const platform = {
  onBackPressed: undefined,
  saveFile: undefined,
  openInEditor: async () => ({success: true}),
  getDeviceId: async () => 'mobile-file-browser-fixture',
  getInstalledEditors: async () => [],
};
const broadcastService = {onMessage: Event.None, send: async () => {}};
function Harness() {
  const [request, setRequest] = useState(null);
  const [, setReadCallState] = useState([]);
  updateReadCalls = setReadCallState;
  const target = new URLSearchParams(location.search).has('target-mismatch')
    ? {backendId: 'fixture', workspaceKey: '/fixture/wrong', workspacePath: '/fixture/wrong'}
    : {backendId: 'fixture', workspaceKey: fixture.workspacePath, workspacePath: fixture.workspacePath};
  return React.createElement(React.Fragment, null,
    React.createElement('button', {onClick: () => setRequest({id: 1, target: {workspacePath: fixture.workspacePath, workspaceName: 'Fixture', revealPath: fixture.workspacePath + '/src'}})}, 'Open source directory from request'),
    React.createElement(MobileWorkspaceFileBrowser, {
      workspacePath: fixture.workspacePath,
      workspaceName: 'Fixture',
      target,
      openRequest: request,
      onClose: () => {},
    }),
    React.createElement('output', {'data-testid': 'read-call-count'}, String(readCalls.length)),
    React.createElement('output', {'data-testid': 'read-calls'}, JSON.stringify(readCalls)));
}
createRoot(document.getElementById('root')).render(
  React.createElement(ServiceProvider, {services},
    React.createElement(TabStoreProvider, null,
      React.createElement(StoreProvider, {broadcastService},
        React.createElement(PlatformProvider, {platform},
          React.createElement(ZCodeIntlProvider, null, React.createElement(Harness)))))));
`;

const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "mobile-file-browser-fixture",
      resolveId: (id) => (id === "/mobile-file-browser-e2e-entry.jsx" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/mobile-file-browser-fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<div id="root"></div><script type="module" src="/mobile-file-browser-e2e-entry.jsx"></script>',
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
    await page.goto(`${origin}/mobile-file-browser-fixture`);
    await page.getByRole("button", { name: "src", exact: true }).waitFor();
    assert.equal(
      await page.locator("[data-mobile-file-row]").count(),
      4,
      "initial directory entries render",
    );
    assert.equal(
      await page.getByRole("button", { name: /Save original/ }).count(),
      0,
      "ordinary web has no native save control",
    );
    assert.equal(
      await page.getByText("Symbolic link", { exact: true }).count(),
      1,
      "symlink has an accessible badge",
    );
    await page.waitForFunction(
      () => Number(document.querySelector("[data-testid=read-call-count]")?.textContent) > 0,
    );
    const readCalls = JSON.parse(await page.getByTestId("read-calls").innerText());
    assert.deepEqual(readCalls[0].mobileBudget, { maxEntries: 5000, maxResponseBytes: 1048576 });

    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "read me.txt" }).click();
    await page.getByText("A preview opened from a mobile directory.").waitFor();
    assert.equal(
      await page.getByRole("button", { name: /Open in/ }).count(),
      0,
      "read-only preview hides editor actions",
    );
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "read me.txt" }).waitFor();

    await page.getByRole("button", { name: "Open source directory from request" }).click();
    await page.getByRole("button", { name: "read me.txt" }).waitFor();
    const callsAfterRequest = JSON.parse(await page.getByTestId("read-calls").innerText());
    assert.ok(callsAfterRequest.some((call) => call.path === `${fixture.workspacePath}/src`));
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: resolve(artifactDir, "mobile-file-browser.png") });
    console.log("PASS MF-COMP-01 browse/preview/reveal budget and read-only capability");
  } finally {
    await context.close();
  }

  const oversizedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  const oversizedPage = await oversizedContext.newPage();
  await oversizedPage.goto(`${origin}/mobile-file-browser-fixture?large`);
  await oversizedPage.getByRole("alert").waitFor();
  assert.match(await oversizedPage.getByRole("alert").innerText(), /Directory exceeds/);
  assert.equal(
    await oversizedPage.getByRole("button", { name: "src", exact: true }).count(),
    0,
    "partial directory contents are not presented as complete",
  );
  await oversizedPage.screenshot({
    path: resolve(artifactDir, "mobile-file-browser-oversized.png"),
  });
  await oversizedContext.close();

  const mismatchContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "en-US",
  });
  const mismatchPage = await mismatchContext.newPage();
  await mismatchPage.goto(`${origin}/mobile-file-browser-fixture?target-mismatch`);
  await mismatchPage.getByRole("alert").waitFor();
  assert.equal(
    await mismatchPage.getByTestId("read-call-count").innerText(),
    "0",
    "mismatched target does not read another workspace",
  );
  await mismatchContext.close();
  console.log("PASS MF-COMP-01 oversize and target-scope rejection");
} finally {
  await browser?.close();
  await vite.close();
}
