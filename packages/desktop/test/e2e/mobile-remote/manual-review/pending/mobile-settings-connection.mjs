// MC-SETTINGS-01: real browser SettingsPage + injected fake mobileConnectionSettings.
// Synthetic services/transport: verifies React composition and browser history only.
// Run: pnpm exec tsx packages/desktop/test/e2e/mobile-remote/manual-review/pending/mobile-settings-connection.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
const artifactDir = resolve(repoRoot, ".tmp/mobile-settings-connection-e2e");
await mkdir(artifactDir, { recursive: true });

const entryId = "\0mobile-settings-connection-e2e-entry";
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Event} from '@zody/rpc';
import {ServiceProvider} from '@/hooks/useServices.js';
import {PlatformProvider} from '@/hooks/usePlatform.js';
import {StoreProvider} from '@/store/StoreProvider.js';
import {TabStoreProvider} from '@/store/TabStoreProvider.js';
import {ZodyIntlProvider} from '@/i18n/IntlProvider.js';
import {SettingsPage} from '@/SettingsPage.js';
import {TooltipProvider} from '@/components/ui/tooltip.js';
import '@/styles.css';

const plain = new URLSearchParams(location.search).get('plain') === '1';
localStorage.clear();
sessionStorage.clear();
// 默认落在连接分区；设置首页仍展示索引。避免隐藏渲染重型 General 内容。
if (!plain) localStorage.setItem('zody-settings-last-section', 'connection');

window.__saveCalls = [];
window.__saveMode = 'no-change';
window.__reconnectCalls = 0;
window.__settingsBackCalls = 0;
window.__backHandlers = [];

const broadcastService = {onMessage: Event.None, send: async () => {}};
const services = {
  broadcastService,
  settingService: {
    get: async () => ({}),
    update: async () => {},
    updateDataBaseDir: async () => {},
  },
  zcodeAgentService: {syncAppRuntimePreferences: async () => ({})},
  systemService: {
    info: async () => ({homedir: '/tmp', platform: 'darwin'}),
    listIntegratedTerminalShells: async () => [],
  },
};
const platform = {
  selectDirectory: async () => null,
  selectFile: async () => null,
  syncAppSettings: () => {},
  onSettingsChanged: () => () => {},
  onBackPressed: (handler) => {
    window.__backHandlers.push(handler);
    return () => {
      const index = window.__backHandlers.indexOf(handler);
      if (index >= 0) window.__backHandlers.splice(index, 1);
    };
  },
};
const mobileConnectionSettings = {
  initial: {
    gatewayUrl: 'https://gateway.example.com',
    namespace: 'zody',
    credentialConfigured: true,
  },
  allowInsecureTransport: true,
  save: async (draft) => {
    window.__saveCalls.push(draft);
    if (window.__saveMode === 'failure') throw new Error('fixture save failed');
    return {scopeChanged: window.__saveMode === 'change'};
  },
  reconnect: () => {
    window.__reconnectCalls += 1;
  },
};

function App() {
  return React.createElement(
    TooltipProvider,
    null,
    React.createElement(
    ServiceProvider,
    {services},
    React.createElement(
      PlatformProvider,
      {platform},
      React.createElement(
        StoreProvider,
        {broadcastService},
        React.createElement(
          TabStoreProvider,
          null,
          React.createElement(
            ZodyIntlProvider,
            {initialLocale: 'en-US'},
            React.createElement(SettingsPage, {
              isWebRemoteControl: true,
              ...(plain ? {} : {mobileConnectionSettings}),
              onBack: () => {
                window.__settingsBackCalls += 1;
              },
            }),
          ),
        ),
      ),
    ),
    ),
  );
}

window.__dispatchBack = () => {
  for (const handler of window.__backHandlers) if (handler()) return true;
  return false;
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

const vite = await createServer({
  configFile: false,
  root: repoRoot,
  plugins: [
    {
      name: "mobile-settings-connection-fixture",
      resolveId: (id) => (id === "/mobile-settings-connection-e2e-entry.jsx" ? entryId : undefined),
      load: (id) => (id === entryId ? entry : undefined),
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/mobile-settings-connection-fixture")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              req.url,
              '<!doctype html><div id="root"></div><script type="module" src="/mobile-settings-connection-e2e-entry.jsx"></script>',
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

const CONNECTION_ITEM = '[data-testid="mobile-settings-section-connection"]';
const SETTINGS_PAGE = '[data-testid="settings-page"]';
const INDEX = '[data-mobile-settings-index="true"]';
const GATEWAY = "#mobile-remote-gateway-url";
const NAMESPACE = "#mobile-remote-namespace";
const CREDENTIAL = "#mobile-remote-credential";
const SAVE = '[data-mobile-connection-settings-submit="true"]';

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

  async function waitForIndex() {
    await page.waitForSelector(`${SETTINGS_PAGE}[data-mobile-settings-view="index"]`);
    await page.waitForSelector(INDEX);
  }

  async function openConnection() {
    await page.click(CONNECTION_ITEM);
    await page.waitForSelector(`${SETTINGS_PAGE}[data-mobile-settings-view="section"]`);
  }

  async function fillDraft() {
    await page.fill(GATEWAY, "https://unsaved.example.com");
    await page.fill(NAMESPACE, "unsaved");
    await page.fill(CREDENTIAL, "zgd_unsaved");
  }

  async function expectDraftReset() {
    await waitForIndex();
    await openConnection();
    assert.equal(await page.inputValue(GATEWAY), "https://gateway.example.com");
    assert.equal(await page.inputValue(NAMESPACE), "zody");
    assert.equal(await page.inputValue(CREDENTIAL), "");
  }

  try {
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await page.goto(`${origin}/mobile-settings-connection-fixture`);
    await waitForIndex();
    assert.equal(await page.locator(CONNECTION_ITEM).count(), 1);
    // 已保存凭证不回显。
    await openConnection();
    assert.equal(await page.inputValue(CREDENTIAL), "");
    assert.equal(await page.locator(CREDENTIAL).getAttribute("type"), "password");
    assert.equal((await page.textContent("body")).includes("zgd_"), false);

    // 1) 分区顶部返回：回设置首页并清空草稿。
    await fillDraft();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expectDraftReset();
    assert.equal(await page.evaluate(() => window.__reconnectCalls), 0);

    // 2) 浏览器返回：popstate 落回设置首页，同样清空草稿。
    await fillDraft();
    await page.evaluate(() => window.history.back());
    await expectDraftReset();

    // 3) Android 返回：由 SettingsPage 处理器消费并清空草稿。
    await fillDraft();
    assert.equal(await page.evaluate(() => window.__dispatchBack()), true);
    await expectDraftReset();

    // 4) 保存失败：留在分区并保留草稿，不重连。
    await page.evaluate(() => {
      window.__saveMode = "failure";
    });
    await page.fill(GATEWAY, "https://failure.example.com");
    await page.fill(CREDENTIAL, "zgd_failure");
    await page.click(SAVE);
    await page.waitForSelector('[role="alert"]');
    assert.match(await page.textContent('[role="alert"]'), /fixture save failed/);
    assert.equal(await page.inputValue(GATEWAY), "https://failure.example.com");
    assert.equal(await page.inputValue(CREDENTIAL), "zgd_failure");
    assert.equal(await page.evaluate(() => window.__reconnectCalls), 0);

    // 5) 无有效变化：保存成功回设置首页，不重连，草稿丢弃。
    await page.evaluate(() => {
      window.__saveMode = "no-change";
    });
    await page.click(SAVE);
    await waitForIndex();
    assert.equal(await page.evaluate(() => window.__reconnectCalls), 0);
    await openConnection();
    assert.equal(await page.inputValue(GATEWAY), "https://gateway.example.com");
    assert.equal(await page.inputValue(CREDENTIAL), "");

    // 6) 有效变化：先回收设置 history，落回宿主后 reconnect 恰好一次。
    await page.evaluate(() => {
      window.__saveMode = "change";
    });
    await page.fill(GATEWAY, "https://changed.example.com");
    await page.click(SAVE);
    await page.waitForFunction(() => window.__reconnectCalls === 1);
    await page.waitForFunction(() => window.__settingsBackCalls === 1);
    assert.equal(await page.evaluate(() => window.__reconnectCalls), 1);
    assert.equal(
      await page.evaluate(() => Boolean(window.history.state?.zcodeMobileSettings)),
      false,
    );
    const saveCalls = await page.evaluate(() => window.__saveCalls);
    assert.equal(saveCalls.at(-1).gatewayUrl, "https://changed.example.com");

    // 7) 桌面宽度：同一 SettingsPage 即使注入连接能力也不出现手机连接分区。
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(`${origin}/mobile-settings-connection-fixture`);
    await page.waitForSelector(SETTINGS_PAGE);
    assert.equal(await page.getByRole("button", { name: "Connection", exact: true }).count(), 0);

    // 8) 普通 Web 手机宽度但未注入连接能力：设置首页仍可用，连接分区隐藏。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/mobile-settings-connection-fixture?plain=1`);
    await waitForIndex();
    assert.equal(await page.locator(CONNECTION_ITEM).count(), 0);

    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(artifactDir, "mobile-settings-connection.png") });
    console.log(
      "PASS MC-SETTINGS-01 settings index/connection entry, draft reset on top/browser/Android back, save failure, no-change, effective history recycle + one reconnect, desktop hidden",
    );
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  await vite.close();
}
