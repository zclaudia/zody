// F17 基线测量（upstream v3.17.1 a60ba6a7「会话时间线分区渲染与查找改进」基线步）：
// 真实 Chromium + vite 编译的真实 ConversationTimeline，对长会话流式/挂载/跳转/查找
// 建立可复现量化基线。指标定义与当前数值见 docs/ui/chat-virtual-scroll.md 与
// docs/ui/chat-virtual-scroll-perf-baseline.md；墙钟只记录趋势，不做 CI pass/fail 门禁
//（与 docs/testing/conversation-session-e2e-coverage-matrix.md PERF03 口径一致）。
//
// 运行：node --test packages/ui/test/browser/manual-review/pending/conversation-timeline-perf-baseline.test.mjs
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
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
  "packages/desktop/.e2e-artifacts/conversation-timeline-perf-baseline",
);
let server, browser, origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "timeline-perf-fixture",
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

const RUN_LABEL = process.env.F17_BASELINE_RUN_LABEL ?? "run";
const VIEWPORT = { width: 1250, height: 800 };
const STREAM_FRAMES = Number(process.env.F17_BASELINE_STREAM_FRAMES ?? 120);
const STREAM_CHUNK_CHARS = 256;
// replace：尾轮等长替换，隔离历史规模变量（M1 主口径）；append：真实增长语义。
const STREAM_MODE = process.env.F17_BASELINE_STREAM_MODE === "append" ? "append" : "replace";

function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function summarizeDurations(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    frames: durations.length,
    p50Ms: Number(percentile(sorted, 50).toFixed(2)),
    p95Ms: Number(percentile(sorted, 95).toFixed(2)),
    maxMs: Number(percentile(sorted, 100).toFixed(2)),
  };
}

async function openFixture(turns) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}fixture?theme=dark&turns=${turns}`);
  await page.getByTestId("v4-timeline").waitFor();
  const meta = await page.evaluate(() => window.__timelinePerf.meta);
  const ready = await page.evaluate(() => window.__timelinePerf.ready());
  return { page, errors, meta, ready };
}

const record = {
  label: RUN_LABEL,
  startedAt: new Date().toISOString(),
  node: process.version,
  viewport: VIEWPORT,
  streamFrames: STREAM_FRAMES,
  streamChunkChars: STREAM_CHUNK_CHARS,
  streamMode: STREAM_MODE,
  metrics: {},
};

// M2 挂载基线：1500 终态轮（4503 行）初始挂载耗 时+挂载量 + 吸底断言。
// 挂载耗时口径：page.goto 返回后到 v4-timeline 出现 + 双 rAF 稳定的整页墙钟，
// 含 vite 首次转换与 React 挂载，因此该值只用于同机同 harness 前后对比。
test("F17 baseline mount@1500-turns", async () => {
  const mountStart = Date.now();
  const { page, errors, meta, ready } = await openFixture(1500);
  const mountMs = Date.now() - mountStart;
  // 行为断言（非墙钟）：新会话默认吸底；虚拟滚动只挂载窗口附近轮次。
  assert.equal(ready.scroll.following, "true");
  assert.ok(Math.abs(ready.scroll.gap) <= 1, JSON.stringify(ready.scroll));
  assert.ok(
    ready.stats.historyTurnUnits < 40,
    `mounted turn units should stay virtualized: ${ready.stats.historyTurnUnits}`,
  );
  record.metrics.mount = {
    terminalTurns: meta.terminalTurns,
    totalRows: meta.totalRows,
    mountMs,
    statsAfterMount: ready.stats,
  };
  console.log(
    `[F17-baseline][${RUN_LABEL}] mount@${meta.terminalTurns}turns/${meta.totalRows}rows: mountMs=${mountMs} historyTurnUnits=${ready.stats.historyTurnUnits} mountedTurnUnits=${ready.stats.mountedTurnUnits} historyElements=${ready.stats.historyElements}`,
  );
  const pageErrors = await page.evaluate(() => window.__timelineErrors);
  await page.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(pageErrors, []);
});

// M1 流式每帧成本基线：三档历史规模 × 固定帧数。核心回归指标是
// growth = p50(1000 turns)/p50(50 turns)：分区前应显著 >1（成本随历史增长），
// 分区步合入后应收敛到 1 附近。这里只记录与断言环境 sanity 上限。
test("F17 baseline stream-frame cost across history sizes", async () => {
  const sizes = [50, 500, 1000];
  const results = {};
  for (const turns of sizes) {
    const { page, errors, meta } = await openFixture(turns);
    const streamed = await page.evaluate((options) => {
      return window.__timelinePerf.streamFrames(options);
    }, { frames: STREAM_FRAMES, chunkChars: STREAM_CHUNK_CHARS, rafBetweenFrames: true, warmupFrames: 10, mode: STREAM_MODE });
    // 行为断言：流式全程保持吸底、无页面错误。
    assert.equal(streamed.scroll.following, "true", JSON.stringify(streamed.scroll));
    assert.ok(
      Math.abs(streamed.scroll.gap) <= 2,
      `bottom lock must hold after streaming: ${JSON.stringify(streamed.scroll)}`,
    );
    const summary = summarizeDurations(streamed.durations);
    // 环境 sanity 上限（远高于预期值，只拦截 harness/环境损坏，不是性能门禁）。
    assert.ok(
      summary.p95Ms < 250,
      `sanity ceiling breached at ${turns} turns: ${JSON.stringify(summary)}`,
    );
    results[turns] = {
      totalRows: meta.totalRows,
      ...summary,
      statsAfterStream: streamed.stats,
    };
    console.log(
      `[F17-baseline][${RUN_LABEL}] stream@${turns}turns/${meta.totalRows}rows: p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms historyTurnUnits=${streamed.stats.historyTurnUnits}`,
    );
    await page.close();
    assert.deepEqual(errors, []);
  }
  const growth =
    Number((results[1000].p50Ms / results[50].p50Ms).toFixed(2)) || null;
  record.metrics.stream = { sizes: results, growth1000Over50: growth };
  console.log(
    `[F17-baseline][${RUN_LABEL}] stream growth p50(1000turns)/p50(50turns)=${growth}`,
  );
});

// M3 定位跳转挂载量基线：从底部 locate 到中段后，已挂载 turn group 数与
// 虚拟历史 DOM 元素总数。该计数对 ROW_OVERSCAN（当前 8）确定性敏感：
// overscan 步（8→2）后应稳定下降。
test("F17 baseline locate-jump mount footprint@500-turns", async () => {
  const { page, errors, meta } = await openFixture(500);
  const targetUnitIndex = Math.floor(meta.terminalTurns / 2);
  const targetRowId = targetUnitIndex * 3 + 2; // 该轮 userInput 行
  const jumped = await page.evaluate(
    ([unitIndex, rowId]) => window.__timelinePerf.jumpTo(unitIndex, rowId),
    [targetUnitIndex, targetRowId],
  );
  // 行为断言：定位后离底，目标行已挂载（虚拟窗口覆盖目标）。
  assert.equal(jumped.scroll.following, "false", JSON.stringify(jumped.scroll));
  const targetVisible = await page.evaluate((rowId) => {
    const history = document.querySelector("[data-v4-timeline-virtual-history]");
    // 与 scrollToQuery 内部一致按 data-row-id 查询，避免 testid 拼接差异。
    return Boolean(history?.querySelector(`[data-row-id="${rowId}"]`));
  }, targetRowId);
  assert.ok(targetVisible, "locate target row must be mounted after jump");
  record.metrics.locateJump = {
    terminalTurns: meta.terminalTurns,
    totalRows: meta.totalRows,
    targetUnitIndex,
    targetRowId,
    statsAfterJump: jumped.stats,
  };
  console.log(
    `[F17-baseline][${RUN_LABEL}] locateJump@${meta.terminalTurns}turns→unit${targetUnitIndex}: historyTurnUnits=${jumped.stats.historyTurnUnits} historyElements=${jumped.stats.historyElements} mountedTurnUnits=${jumped.stats.mountedTurnUnits}`,
  );
  await page.close();
  assert.deepEqual(errors, []);
});

// M4 查找激活时的流式成本基线：conversationFindQuery 命中全部历史轮时，
// useConversationTimelineFind 的每帧索引合并成本随历史增长；查找分区缓存
//（F17 查找步）合入后复测此项。注意：查询激活会自动定位到首个命中（定位型
// 滚动），因此流式全程保持离底是预期行为，不做吸底断言。
test("F17 baseline find-active stream cost@500-turns", async () => {
  const { page, errors, meta } = await openFixture(500);
  await page.evaluate(() => window.__timelinePerf.setFind("F17_NEEDLE_MARKER"));
  const streamed = await page.evaluate((options) => {
    return window.__timelinePerf.streamFrames(options);
  }, { frames: Math.min(60, STREAM_FRAMES), chunkChars: STREAM_CHUNK_CHARS, rafBetweenFrames: true, warmupFrames: 10, mode: STREAM_MODE });
  const summary = summarizeDurations(streamed.durations);
  assert.ok(
    summary.p95Ms < 250,
    `sanity ceiling breached (find-active): ${JSON.stringify(summary)}`,
  );
  record.metrics.findActiveStream = {
    terminalTurns: meta.terminalTurns,
    totalRows: meta.totalRows,
    query: "F17_NEEDLE_MARKER",
    ...summary,
  };
  console.log(
    `[F17-baseline][${RUN_LABEL}] findActiveStream@${meta.terminalTurns}turns: p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms max=${summary.maxMs}ms`,
  );
  await page.close();
  assert.deepEqual(errors, []);
});

test("write baseline artifact", async () => {
  record.finishedAt = new Date().toISOString();
  const path = join(artifacts, `baseline-${RUN_LABEL}.json`);
  await writeFile(path, JSON.stringify(record, null, 2));
  console.log(`[F17-baseline][${RUN_LABEL}] artifact: ${path}`);
});
