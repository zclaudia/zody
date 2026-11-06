/**
 * PA160 组件交互验收（manual-review/pending，未经人工评审不转正；注册于
 * docs/conversation-session-case-catalog.md PA160，产品规格 docs/task-restart-and-reload.md）。
 * 运行：`node --test packages/ui/test/browser/manual-review/pending/task-restart.test.mjs`。
 * 覆盖 PA160-01/02（菜单直接重启 vs 兄弟任务运行时先确认）与 A12 布局矩阵；
 * services 契约与 typed /reload 决策由 vitest 单测覆盖。
 */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/task-restart.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/task-restart-browser");
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "task-restart-fixture",
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
    server: { host: "127.0.0.1", port: 0 },
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

for (const width of [390, 1200])
  for (const theme of ["light", "dark"]) {
    test(`PA160 task restart ${width}/${theme}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        const mobile = width === 390;
        const zh = mobile;
        // fixture 的 locale 与 ConfirmDialog 内部文案（common.cancel）随视口切换。
        const confirmWording = zh ? "重启 Agent 进程" : "Restart agent process";
        const cancelWording = zh ? "取消" : "Cancel";
        await page.goto(`${origin}fixture?theme=${theme}&locale=${mobile ? "zh-CN" : "en-US"}`);
        const menuRestart = page.getByTestId("task-restart");
        await menuRestart.waitFor();

        // PA160-01：无 running 兄弟任务 → 不弹确认，直接重启。
        await menuRestart.click();
        await page.waitForFunction(
          () => document.querySelector('[data-testid="restart-log"]')?.textContent === "task-a",
        );
        assert.equal(
          await page.getByTestId("workspace-restart-confirmation").count(),
          0,
          "no sibling running: no confirmation dialog",
        );

        // PA160-02：同 workspace 有 running 兄弟任务 → 先弹确认；取消不动作。
        await page.getByTestId("restart-with-sibling").click();
        const dialog = page.getByTestId("workspace-restart-confirmation");
        await dialog.waitFor();
        // 标题与确认按钮共用同一文案（与上游 a60ba6a7 一致）。
        assert.equal(
          await dialog.getByText(confirmWording).count(),
          2,
          "dialog title + confirm label rendered",
        );
        await dialog.getByRole("button", { name: cancelWording }).click();
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="workspace-restart-confirmation"]'),
        );
        assert.equal(
          await page.getByTestId("restart-log").textContent(),
          "task-a",
          "cancel keeps state untouched",
        );

        // PA160-02 续：确认后走同一 restartTask 单入口。
        await page.getByTestId("restart-with-sibling").click();
        const confirmDialog = page.getByTestId("workspace-restart-confirmation");
        await confirmDialog.waitFor();
        await confirmDialog.getByRole("button", { name: confirmWording }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="restart-log"]')?.textContent === "task-a,task-c",
        );

        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: join(artifacts, `${width}-${theme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  }
