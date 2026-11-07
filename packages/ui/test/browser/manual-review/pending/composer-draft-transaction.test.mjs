/**
 * PA162 组件交互验收（manual-review/pending，未经人工评审不转正；注册于
 * docs/conversation-session-case-catalog.md PA162，产品规格 docs/ui/composer-draft-transaction.md）。
 * 运行：`node --test packages/ui/test/browser/manual-review/pending/composer-draft-transaction.test.mjs`。
 * F28 草稿丢失复现基线：真实 ConversationComposer + 真实 useDraftConfigControl，
 * 夹具可在草稿/task scope 间切换并控制 onSendText 挂起/失败。
 * 基线预期（2026-11-07）：F28E-1/3/4 通过（护栏，四步移植不得回退）、F28E-2 失败
 * （复现步③要修的「提交事务写不回已切换 scope」草稿丢失）；如实记录，不把失败写成通过。
 */
/* oxlint-disable eslint(max-lines) -- e2e-case-lifecycle 以单个 spec 文件为登记/晋升单元，
   PA162 场景共用同一 fixture/server 生命周期，拆文件会割裂案例登记。 */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/composer-draft-transaction.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-draft-transaction-browser");
const baselineMetrics = { hotPathDraftWrites: null, cases: {} };

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-composer-draft-transaction"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "composer-draft-transaction-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: {
      host: "127.0.0.1",
      port: 0,
      hmr: false,
      watch: { ignored: ["**/packages/desktop/out/**", "**/.e2e-artifacts/**"] },
    },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
  await writeFile(
    join(artifacts, "baseline-metrics.json"),
    `${JSON.stringify(baselineMetrics, null, 2)}\n`,
    "utf8",
  );
});

async function openComposer(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}fixture?`);
  const editor = page.getByTestId("v4-composer-input");
  await editor.waitFor({ timeout: 10_000 });
  // E2E bridge 就绪后才能读到真实 Lexical markdown（不直改 DOM）。
  await page.waitForFunction(() => {
    const input = document.querySelector("[data-e2e-lexical-bridge='ready']");
    return Boolean(input?.__zcodeLexicalInputE2E);
  });
  return { editor, errors };
}

async function editorText(page) {
  return page.evaluate(() => {
    const input = document.querySelector("[data-e2e-lexical-bridge='ready']");
    return input?.__zcodeLexicalInputE2E?.getText?.() ?? null;
  });
}

async function waitForEditorText(page, expected, timeout = 4_000) {
  await page.waitForFunction(
    (value) => {
      const input = document.querySelector("[data-e2e-lexical-bridge='ready']");
      return input?.__zcodeLexicalInputE2E?.getText?.() === value;
    },
    expected,
    { timeout, polling: 50 },
  );
}

async function switchScope(page, next) {
  await page.evaluate((target) => window.switchScope(target), next);
}

async function typeDraft(page, editor, text) {
  await editor.click();
  await editor.pressSequentially(text, { delay: 20 });
  await waitForEditorText(page, text);
}

test("F28E-1 护栏：草稿输入后切 task 再切回，正文不丢（含热路径写盘指标）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openComposer(page);
  const editor = page.getByTestId("v4-composer-input");
  const text = "切走不丢的草稿正文";
  await page.evaluate(() => window.resetDraftWriteCount());
  await typeDraft(page, editor, text);
  baselineMetrics.hotPathDraftWrites = await page.evaluate(() => window.draftWriteCount);
  await switchScope(page, "task");
  await waitForEditorText(page, "");
  await switchScope(page, "draft");
  await waitForEditorText(page, text);
  assert.equal(await editorText(page), text);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, "f28e1-switch-roundtrip.png"), fullPage: true });
  await page.close();
});

test("F28E-2 复现：发送挂起中切 task 后失败，草稿无法恢复（步③事务要修的丢失）", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openComposer(page);
  const editor = page.getByTestId("v4-composer-input");
  const text = "等待ACK期间切走的草稿";
  await typeDraft(page, editor, text);
  await page.evaluate(() => window.hangNextSend());
  await editor.press("Enter");
  await page.waitForFunction(() => window.sendStartedCount === 1);
  await switchScope(page, "task");
  await waitForEditorText(page, "");
  // 模拟 transport error：发送失败必须把草稿恢复回提交前 scope。
  await page.evaluate(() => window.settleHungSend("reject"));
  await page.waitForTimeout(150);
  await switchScope(page, "draft");
  // 基线（2026-11-07）实测：claim 已清空 root 草稿且 restore 被 scope 守卫拒绝 → 丢失。
  // 本断言在步③落地后必须通过；当前按复现记录失败（见 baseline-metrics.json）。
  await waitForEditorText(page, text, 2_000).catch(async (error) => {
    baselineMetrics.cases.F28E2 = {
      expected: text,
      actual: await editorText(page),
      persistedDrafts: await page.evaluate(() => window.readPersistedDrafts()),
    };
    await page.screenshot({ path: join(artifacts, "f28e2-draft-lost.png"), fullPage: true });
    await page.close();
    throw error;
  });
  assert.equal(await editorText(page), text);
  assert.deepEqual(errors, []);
  await page.close();
});

test("F28E-3 护栏：同 scope 发送失败，正文恢复且持久草稿还原", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openComposer(page);
  const editor = page.getByTestId("v4-composer-input");
  const text = "同scope失败可恢复";
  await typeDraft(page, editor, text);
  await page.evaluate(() => window.hangNextSend());
  await editor.press("Enter");
  await page.waitForFunction(() => window.sendStartedCount === 1);
  await page.evaluate(() => window.settleHungSend("reject"));
  await waitForEditorText(page, text);
  const drafts = await page.evaluate(() => window.readPersistedDrafts());
  assert.equal(drafts.__draft__?.text, text);
  assert.deepEqual(errors, []);
  await page.close();
});

test("F28E-4 护栏（步④）：compositionend 前切 task 再切回，组合中正文不丢", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openComposer(page);
  const editor = page.getByTestId("v4-composer-input");
  const text = "中文组合输入中";
  await editor.click();
  // 进入 IME 组合态（compositionend 故意不派发：模拟候选窗口未确认时切换任务）。
  await editor.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await page.keyboard.insertText(text);
  await waitForEditorText(page, text);
  await switchScope(page, "task");
  await waitForEditorText(page, "");
  await switchScope(page, "draft");
  await waitForEditorText(page, text);
  assert.equal(await editorText(page), text);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: join(artifacts, "f28e4-composition-roundtrip.png"),
    fullPage: true,
  });
  await page.close();
});
