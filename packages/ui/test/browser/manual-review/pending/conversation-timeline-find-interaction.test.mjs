// F17 步骤⑤ 交互 E2E（上游 a60ba6a7 查找改进）：真实 Chromium + 真实 ConversationTimeline。
// 覆盖 spec docs/ui/chat-virtual-scroll.md「步骤⑤契约」验收场景 2：
// 激活查找自动定位首个命中并居中可见 → 流式期间命中高亮保持 → 视口宽度变化并稳定后
// 活动命中仍在视口（isMountedLayoutMeasured 交接）。数据复用 perf 基线夹具
// （conversation-timeline-perf-baseline.fixture.tsx，确定性合成、不依赖 provider）。
// 桌面对齐用例（coverage matrix session-find-highlight W01-W06）在 packages/desktop，
// 本卡落点外，缺口已在 spec 登记。
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/conversation-timeline-perf-baseline.fixture.tsx";
const artifacts = join(
  root,
  "packages/desktop/.e2e-artifacts/conversation-timeline-find-interaction",
);
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "timeline-find-fixture",
        enforce: "pre",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
      tailwindcss(),
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
});

const NEEDLE = "F17_NEEDLE_MARKER";

async function findState(page) {
  return page.evaluate((needle) => {
    const timeline = document.querySelector('[data-testid="v4-timeline"]');
    // CSS Custom Highlight API（Chrome 156 支持）：查找命中与活动命中的注册表。
    const highlightNames = timeline ? Array.from(window.CSS?.highlights?.keys?.() ?? []) : [];
    // 首个命中的行：turn-1 的 userInput（含 needle）。检查它是否在滚动视口内。
    const row = document.querySelector(`[data-v4-timeline-virtual-history] [data-row-id="2"]`);
    const timelineRect = timeline?.getBoundingClientRect();
    const rowRect = row?.getBoundingClientRect();
    const rowVisible = Boolean(
      timelineRect &&
      rowRect &&
      rowRect.bottom > timelineRect.top &&
      rowRect.top < timelineRect.bottom &&
      row.textContent?.includes(needle),
    );
    return {
      following: timeline?.dataset.following ?? null,
      scrollTop: timeline?.scrollTop ?? -1,
      highlightNames,
      rowVisible,
      rowTextHasNeedle: row?.textContent?.includes(needle) ?? false,
    };
  }, NEEDLE);
}

const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );

test("F17⑤ find interaction: 定位首个命中、流式保持、宽度校正后仍在视口", async () => {
  const page = await browser.newPage({ viewport: { width: 1250, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${origin}fixture?theme=dark&turns=500`);
    await page.getByTestId("v4-timeline").waitFor();
    await settle(page);
    // 基线：吸底（首个命中在历史顶部，离当前视口很远）。
    assert.equal((await findState(page)).following, "true");

    // 1) 激活查找：自动定位首个命中（turn-1），离底且高亮注册表收到命中。
    await page.evaluate((needle) => window.__timelinePerf.setFind(needle), NEEDLE);
    await settle(page);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="v4-timeline"]')?.dataset.following === "false",
    );
    const located = await findState(page);
    assert.equal(located.following, "false");
    assert.ok(located.highlightNames.length > 0, "CSS highlight registry must receive matches");
    assert.ok(located.rowTextHasNeedle, "first match row must be mounted");
    assert.ok(located.rowVisible, "first match row must be inside the viewport");
    assert.ok(located.scrollTop < 400, `first match should be near the top: ${located.scrollTop}`);

    // 2) 流式期间命中保持：尾轮增量不丢历史高亮与活动命中行。
    const streamed = await page.evaluate(() =>
      window.__timelinePerf.streamFrames({
        frames: 30,
        chunkChars: 256,
        rafBetweenFrames: true,
        warmupFrames: 5,
        mode: "replace",
      }),
    );
    assert.equal(streamed.scroll.following, "false", JSON.stringify(streamed.scroll));
    const duringStream = await findState(page);
    assert.ok(duringStream.highlightNames.length > 0);
    assert.ok(duringStream.rowVisible, "active match row stays visible during streaming");

    // 3) 宽度校正后定位：视口收窄再放宽，等测高 settle（CONTENT_WIDTH_RESIZE_SETTLE_MS
    //    + 批量测高提交）后，活动命中行仍在视口内（measured 交接不丢）。
    for (const width of [900, 1250]) {
      await page.setViewportSize({ width, height: 800 });
      await settle(page);
      await page.waitForTimeout(200);
      await settle(page);
    }
    const afterResize = await findState(page);
    assert.ok(
      afterResize.rowVisible,
      `active match row must stay visible after width correction: ${JSON.stringify(afterResize)}`,
    );
    assert.ok(afterResize.highlightNames.length > 0);

    await page.screenshot({ path: join(artifacts, "find-interaction.png") });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
