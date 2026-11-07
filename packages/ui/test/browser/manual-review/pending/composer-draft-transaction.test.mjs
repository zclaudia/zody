/**
 * PA162 组件交互验收（manual-review/pending，未经人工评审不转正；注册于
 * docs/conversation-session-case-catalog.md PA162，产品规格 docs/ui/composer-draft-transaction.md）。
 * 运行：`node --test packages/ui/test/browser/manual-review/pending/composer-draft-transaction.test.mjs`。
 * F28 草稿丢失复现基线：真实 ConversationComposer + 真实 useDraftConfigControl，
 * 夹具可在草稿/task scope 间切换并控制 onSendText 挂起/失败。
 * 预期（步③落地后 2026-11-08）：F28E-1/2/3/4/5 全部通过——F28E-2 已由复现翻转为护栏
 * （事务 restore 写回提交 scope）；F28E-5 为 PA162-05（F15 附件路径 claim/restore）。
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
  // 预热：首个字符吸收冷启动的事件派发抖动，并等它的防抖落盘完成——保证计量窗口内
  // 任何写盘都只能来自热路径本身，而不是迟到的预热定时器。
  await editor.click();
  await editor.pressSequentially("预", { delay: 20 });
  await page.waitForFunction(() => window.readPersistedDrafts().__draft__?.text === "预", {
    timeout: 5_000,
    polling: 100,
  });
  await editor.press("Backspace");
  await page.evaluate(() => window.resetDraftWriteCount());
  await typeDraft(page, editor, text);
  // 步①断言（2026-11-08 落地）：连续击键期间草稿键不做逐击键写盘——热路径只 staged
  // 暂存（基线为 9 写/10 字符，见 spec 指标表）。正常为 0；机器负载导致某次击键间隔
  // 超过 350ms 时防抖合法落盘一次（产品行为），故上界取 1——旧热路径每次击键同步写
  // 盘（≥10 次），与 0/1 有数量级区分。Backspace 的防抖定时器被后续击键持续重置。
  const hotPathDraftWrites = await page.evaluate(() => window.draftWriteCount);
  baselineMetrics.hotPathDraftWrites = hotPathDraftWrites;
  assert.ok(
    hotPathDraftWrites <= 1,
    `staged hot path should not write per keystroke, got ${hotPathDraftWrites}`,
  );
  // 防抖空闲窗结束后，staged 正文（含 editorStateJson）合并落盘一次。
  await page.waitForFunction(
    () => window.readPersistedDrafts().__draft__?.text === "切走不丢的草稿正文",
    { timeout: 3_000, polling: 100 },
  );
  const writesAfterDebounce = await page.evaluate(() => window.draftWriteCount);
  assert.ok(
    writesAfterDebounce >= 1,
    `debounce flush should persist once, got ${writesAfterDebounce}`,
  );
  await switchScope(page, "task");
  await waitForEditorText(page, "");
  await switchScope(page, "draft");
  await waitForEditorText(page, text);
  assert.equal(await editorText(page), text);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, "f28e1-switch-roundtrip.png"), fullPage: true });
  await page.close();
});

test("F28E-2 护栏（步③翻转）：发送挂起中切 task 后失败，草稿经事务恢复回提交 scope", async () => {
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
  // 模拟 transport error：失败 restore 经事务自己的 scope target 写回提交前 scope
  // （基线 2026-11-07 复现 B3：claim 删记录且 restore 被旧闭包守卫拒绝 → 永久丢失；
  // 步③事务落地后本用例翻转为通过——见 baseline-metrics.json 历史记录）。
  await page.evaluate(() => window.settleHungSend("reject"));
  await page.waitForFunction(
    () => window.readPersistedDrafts().__draft__?.text === "等待ACK期间切走的草稿",
    { timeout: 3_000, polling: 100 },
  );
  // 事务只写提交 scope：task scope 不被失败回包污染。
  const drafts = await page.evaluate(() => window.readPersistedDrafts());
  assert.equal(drafts["task-b"], undefined);
  await switchScope(page, "draft");
  await waitForEditorText(page, text);
  assert.equal(await editorText(page), text);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, "f28e2-transaction-restore.png"), fullPage: true });
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

test("F28E-5 护栏（PA162-05，F15 附件路径）：图片标注入草稿后发送失败，正文与附件一并恢复、零重发", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openComposer(page);
  const editor = page.getByTestId("v4-composer-input");
  // 经 F15 真实捕获通道播种草稿图片（图片标注保存 → addAttachmentFiles 入队路径）。
  await page.evaluate(() => window.seedDraftImage());
  await page.waitForFunction(() => window.draftAttachmentFilenames().includes("shot.png"), {
    timeout: 5_000,
    polling: 100,
  });
  const text = "正文与附件一起恢复";
  await typeDraft(page, editor, text);
  await page.evaluate(() => window.hangNextSend());
  await editor.press("Enter");
  await page.waitForFunction(() => window.sendStartedCount === 1);
  await page.evaluate(() => window.settleHungSend("reject"));
  // 失败恢复：正文回到输入框与持久草稿；附件 chip 不被清除（只在成功结算 adopt/clear）。
  await waitForEditorText(page, text);
  await page.waitForFunction(
    () => window.readPersistedDrafts().__draft__?.text === "正文与附件一起恢复",
    { timeout: 3_000, polling: 100 },
  );
  const filenames = await page.evaluate(() => window.draftAttachmentFilenames());
  assert.deepEqual(filenames, ["shot.png"]);
  // 零重发：失败后不自动再次发送。
  const sentCount = await page.evaluate(() => window.sendStartedCount);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.sendStartedCount), sentCount);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(artifacts, "f28e5-attachment-restore.png"), fullPage: true });
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
