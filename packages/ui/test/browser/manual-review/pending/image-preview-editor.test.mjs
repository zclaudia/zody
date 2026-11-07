/**
 * PA161 组件交互验收（manual-review/pending，未经人工评审不转正；注册于
 * docs/conversation-session-case-catalog.md PA161，产品规格 docs/ui/image-preview-editor.md）。
 * 运行：`node --test packages/ui/test/browser/manual-review/pending/image-preview-editor.test.mjs`。
 * 覆盖 PA161-01～09（假 receiver 断言 append 合同与自然尺寸导出；真实 Composer 链路由
 * 桌面 conversation-session E2E 补齐，缺口已在 catalog 登记）。
 */
/* oxlint-disable eslint(max-lines) -- e2e-case-lifecycle 以单个 spec 文件为登记/晋升单元，
   PA161 九个场景共用同一 fixture/server 生命周期，拆文件会割裂案例登记。 */
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
const entry = "/packages/ui/test/browser/manual-review/pending/image-preview-editor.fixture.tsx";
let server, browser, origin;
const artifacts = join(root, "packages/desktop/.e2e-artifacts/image-preview-editor-browser");

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, "node_modules/.vite-image-preview-editor"),
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "image-preview-editor-fixture",
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
});

const LABELS = {
  "zh-CN": {
    pen: "画笔",
    tools: "图片编辑工具",
    textValue: "标注文字",
    noComposer: "当前没有可接收图片的输入框",
    saveFailed: "图片保存失败，请重试",
    zoomIn: "放大",
    zoomOut: "缩小",
    undo: "撤销",
    redo: "重做",
  },
  "en-US": {
    pen: "Pen",
    tools: "Image editing tools",
    textValue: "Annotation text",
    noComposer: "No chat input is available for this image",
    saveFailed: "Could not save the image. Try again.",
    zoomIn: "放大",
    zoomOut: "缩小",
    undo: "撤销",
    redo: "重做",
  },
};

async function openDialog(page, query = "") {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 夹具中间件只应答 /fixture?<query>；无参数时补空 `?` 保持命中。
  await page.goto(`${origin}fixture${query || "?"}`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator("[role=dialog]").waitFor({ timeout: 5000 });
  // 等图片解码完成（工具从 disabled 转可用）再驱动交互。
  await page.waitForFunction(() => {
    const pen = document.querySelector('[data-image-preview-tool="pen"]');
    return pen instanceof HTMLButtonElement && !pen.disabled;
  });
  return errors;
}

async function draw(page, tool = "pen", start = { x: 0.2, y: 0.2 }, end = { x: 0.6, y: 0.6 }) {
  await page.locator(`[data-image-preview-tool="${tool}"]`).click();
  const box = await page.locator("[data-image-preview-surface]").boundingBox();
  await page.mouse.move(box.x + box.width * start.x, box.y + box.height * start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * end.x, box.y + box.height * end.y, { steps: 8 });
  await page.mouse.up();
}

const annotationCount = (page) =>
  page.locator("[data-image-preview-viewport] [data-annotation-id]").count();

/** 在页面内解码最后保存的 PNG，返回尺寸与默认红（#ef4444）标注像素计数。 */
const analyzeSaved = (page) =>
  page.evaluate(async () => {
    const files = window.savedFiles;
    const file = files.at(-1);
    if (!file) return null;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let red = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - 239) < 24 &&
        Math.abs(data[i + 1] - 68) < 24 &&
        Math.abs(data[i + 2] - 68) < 24
      )
        red += 1;
    }
    return { name: file.name, type: file.type, width: bitmap.width, height: bitmap.height, red };
  });

/**
 * 冻结 PNG 编码步骤直到 finishExport()：把异步导出窗口变成确定性的受控区间，
 * 使 scope 换代 / 关闭 / 防重入断言不与快速编码竞速（上游 a60ba6a7 同款手法）。
 */
async function deferExport(page) {
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) {
      window.finishExport = () => toBlob.apply(this, args);
    };
  });
}

test("PA161-01 工具链：绘制/选择移动/擦除/撤销重做往返，标注元素一一对应", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    const errors = await openDialog(page);
    await draw(page);
    assert.equal(await annotationCount(page), 1);
    // select 工具：命中标注中点 → 出现选择框；拖拽移动后 points 变化。
    await page.locator('[data-image-preview-tool="select"]').click();
    const mark = page.locator("[data-annotation-id] polyline");
    const center = await mark.boundingBox();
    const before = await mark.getAttribute("points");
    await page.mouse.move(center.x + center.width / 2, center.y + center.height / 2);
    await page.mouse.down();
    await page.mouse.move(center.x + center.width / 2 + 60, center.y + center.height / 2 + 60, {
      steps: 5,
    });
    await page.mouse.up();
    await page.locator("[data-selection]").waitFor({ timeout: 3000 });
    const after = await mark.getAttribute("points");
    assert.notEqual(before, after, "选择并拖拽后标注位置应改变");
    // 橡皮擦整条移除；undo 恢复；redo 再移除（历史往返一致）。
    await page.locator('[data-image-preview-tool="eraser"]').click();
    const moved = await mark.boundingBox();
    await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
    assert.equal(await annotationCount(page), 0, "橡皮擦应整条移除标注");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    assert.equal(await annotationCount(page), 1);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    assert.equal(await annotationCount(page), 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("PA161-02 平移缩放：滚轮锚定 + 有界平移 + 双指捏合 + 按钮夹紧 50%–300%", async () => {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    const errors = await openDialog(page);
    const surface = page.locator("[data-image-preview-surface]");
    const initial = await surface.boundingBox();
    const anchor = { x: initial.x + initial.width * 0.65, y: initial.y + initial.height * 0.5 };
    await page.mouse.move(anchor.x, anchor.y);
    // 源 wheel 事件按单次 |delta|≤300 截断（e^0.6≈1.82）。第一档 1.82× 仍在视口内，
    // 图片按 fit 语义居中（锚点不保持属预期）；第二档到 300% 溢出视口后，锚定缩放
    // 生效——断言第二档前后指针下的图像分数不变。
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() =>
      document.querySelector("[data-image-preview-surface]").style.transform.includes("scale(1.8"),
    );
    const first = await surface.boundingBox();
    const fraction = (anchor.x - first.x) / first.width;
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => {
      const element = document.querySelector("[data-image-preview-surface]");
      return (
        element.style.transform.includes("scale(3)") && getComputedStyle(element).cursor === "grab"
      );
    });
    const second = await surface.boundingBox();
    assert.ok(
      Math.abs((anchor.x - second.x) / second.width - fraction) < 0.01,
      "溢出视口后的滚轮缩放应以指针为锚点",
    );
    // 有界平移：拖拽后图片仍覆盖视口（垂直方向溢出被夹紧）。
    await page.mouse.move(550, 420);
    await page.mouse.down();
    await page.mouse.move(950, 600, { steps: 5 });
    await page.mouse.up();
    const box = await surface.boundingBox();
    const viewport = await page.locator("[data-image-preview-viewport]").boundingBox();
    assert.ok(
      box.x <= viewport.x + 1 && box.x + box.width >= viewport.x + viewport.width - 1,
      "水平方向始终覆盖视口",
    );
    assert.ok(
      box.y <= viewport.y + 1 && box.y + box.height >= viewport.y + viewport.height - 1,
      "垂直平移被夹紧在视口内",
    );
    // 双指外扩捏合放大：先把缩放退回 1.5×（300% 上限会吞掉捏合增量），再外扩 1.5×→2.25×。
    for (let i = 0; i < 3; i += 1)
      await page.getByRole("button", { name: "缩小", exact: true }).click();
    const pinchBase = await surface.boundingBox();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: 400, y: 400, id: 1 },
        { x: 600, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: 350, y: 400, id: 1 },
        { x: 650, y: 400, id: 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(
      (previous) =>
        document.querySelector("[data-image-preview-surface]").getBoundingClientRect().width >
        previous,
      pinchBase.width,
    );
    // 按钮夹紧到 50%/300% 边界并禁用（仅在可用时点击，避免对禁用按钮等待超时）。
    const zoomOut = page.getByRole("button", { name: "缩小", exact: true });
    const zoomIn = page.getByRole("button", { name: "放大", exact: true });
    for (let i = 0; i < 12 && (await zoomOut.isEnabled()); i += 1) await zoomOut.click();
    assert.equal(await zoomOut.isDisabled(), true, "缩放到达 50% 下限后应禁用");
    for (let i = 0; i < 12 && (await zoomIn.isEnabled()); i += 1) await zoomIn.click();
    assert.equal(await zoomIn.isDisabled(), true, "缩放到达 300% 上限后应禁用");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("PA161-03 文字：Enter 提交 / Escape 取消 / 输入期间 Ctrl+Z 不触发画布撤销", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    const errors = await openDialog(page);
    await page.locator('[data-image-preview-tool="text"]').click();
    const box = await page.locator("[data-image-preview-surface]").boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const input = page.getByRole("textbox", { name: "标注文字" });
    await input.waitFor({ timeout: 3000 });
    await input.type("标注E2E");
    // 输入框内 Ctrl+Z 只作用于文本；画布快捷键分支应被 input 目标守卫跳过，
    // 表现为输入框保留焦点与文本（若泄漏到画布，焦点处理会打断输入状态）。
    await page.keyboard.press("Control+z");
    await input.waitFor({ timeout: 2000 });
    assert.equal(await input.inputValue(), "标注E2E", "输入框应保留焦点与文本");
    await page.keyboard.press("Enter");
    await input.waitFor({ state: "hidden", timeout: 3000 });
    assert.equal(await annotationCount(page), 1, "Enter 应提交文字标注");
    // Escape 取消：再开一个文字输入并取消，不新增标注。
    await page.locator('[data-image-preview-tool="text"]').click();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
    const second = page.getByRole("textbox", { name: "标注文字" });
    await second.waitFor({ timeout: 3000 });
    await second.type("cancel");
    await page.keyboard.press("Escape");
    await second.waitFor({ state: "hidden", timeout: 3000 });
    assert.equal(await annotationCount(page), 1, "Escape 应取消未提交文字");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("PA161-04 自然尺寸导出：320×240 源（含视口预缩放）导出同名红笔 PNG", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    const errors = await openDialog(page);
    // 先把视口缩放调离 100%，证明导出不受显示 transform 影响。
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await draw(page);
    await page.locator("[data-image-preview-save]").click();
    await page.locator("[role=dialog]").waitFor({ state: "hidden", timeout: 5000 });
    const analyzed = await analyzeSaved(page);
    assert.ok(analyzed, "保存应产生一个文件");
    assert.equal(analyzed.name, "drawing-edited.png");
    assert.equal(analyzed.type, "image/png");
    assert.equal(analyzed.width, 320, "导出宽度应为自然尺寸");
    assert.equal(analyzed.height, 240, "导出高度应为自然尺寸");
    assert.ok(analyzed.red > 0, "导出 PNG 应包含红笔标注像素");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("PA161-05/08 入草稿与防重入：保存 pending 期间禁用并只追加一个文件", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    const errors = await openDialog(page);
    await draw(page);
    await deferExport(page);
    const save = page.locator("[data-image-preview-save]");
    await save.click();
    await page.waitForFunction(() => typeof window.finishExport === "function");
    assert.equal(await save.isDisabled(), true, "保存 pending 期间按钮应禁用（防重入）");
    await page.evaluate(() => window.finishExport());
    await page.locator("[role=dialog]").waitFor({ state: "hidden", timeout: 5000 });
    const count = await page.evaluate(() => window.savedFiles.length);
    assert.equal(count, 1, "保存应恰好追加一个文件");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("PA161-06 无接收方：提示 noComposer，不导出、不关弹窗", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  try {
    const errors = await openDialog(page, "?receiver=0");
    await draw(page);
    await page.locator("[data-image-preview-save]").click();
    await page.getByText("当前没有可接收图片的输入框").waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.savedFiles.length), 0);
    await page.waitForTimeout(200);
    assert.equal(await page.locator("[role=dialog]").count(), 1, "无接收方不应关闭编辑器");
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("PA161-07 失效与失败：scope 换代 / 导出中关闭 / append 拒绝可重试 / 编码失败 / 33M 上限", async () => {
  // scope 换代：捕获后释放接收方，导出完成的 append 返回 false → saveFailed、无文件。
  const scopePage = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const scopeErrors = await openDialog(scopePage);
  await draw(scopePage);
  await deferExport(scopePage);
  await scopePage.locator("[data-image-preview-save]").click();
  await scopePage.waitForFunction(() => typeof window.finishExport === "function");
  await scopePage.evaluate(() => window.changeScope());
  await scopePage.evaluate(() => window.finishExport());
  await scopePage.getByText("图片保存失败，请重试").waitFor({ timeout: 5000 });
  assert.equal(await scopePage.evaluate(() => window.savedFiles.length), 0);
  assert.equal(await scopePage.locator("[role=dialog]").count(), 1, "失败应保留编辑器与标注");
  assert.equal(
    await scopePage.getByRole("button", { name: "撤销", exact: true }).isEnabled(),
    true,
    "失败后标注历史保留可撤销",
  );
  assert.deepEqual(scopeErrors, []);
  await scopePage.close();

  // 导出中关闭：alive=false 静默丢弃，无 toast、无文件。
  const closing = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const closeErrors = await openDialog(closing);
  await draw(closing);
  await deferExport(closing);
  await closing.locator("[data-image-preview-save]").click();
  await closing.waitForFunction(() => typeof window.finishExport === "function");
  await closing.keyboard.press("Escape");
  await closing.locator("[role=dialog]").waitFor({ state: "hidden", timeout: 3000 });
  await closing.evaluate(() => window.finishExport());
  await closing.waitForTimeout(300);
  assert.equal(await closing.getByText("图片保存失败，请重试").count(), 0, "关闭后不应报错");
  assert.equal(await closing.evaluate(() => window.savedFiles.length), 0);
  assert.deepEqual(closeErrors, []);
  await closing.close();

  // append 拒绝 → saveFailed 且可重试成功。
  const rejecting = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const rejectErrors = await openDialog(rejecting);
  await draw(rejecting);
  await rejecting.evaluate(() => {
    window.rejectSave = true;
  });
  await rejecting.locator("[data-image-preview-save]").click();
  await rejecting.getByText("图片保存失败，请重试").waitFor({ timeout: 5000 });
  assert.equal(await rejecting.evaluate(() => window.savedFiles.length), 0);
  await rejecting.evaluate(() => {
    window.rejectSave = false;
  });
  await rejecting.locator("[data-image-preview-save]").click();
  await rejecting.locator("[role=dialog]").waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await rejecting.evaluate(() => window.savedFiles.length), 1, "重试应成功入草稿");
  assert.deepEqual(rejectErrors, []);
  await rejecting.close();

  // PNG 编码失败（toBlob 回调 null）→ saveFailed、标注保留、可再保存。
  const encoding = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const encodingErrors = await openDialog(encoding);
  await draw(encoding);
  await encoding.evaluate(
    () =>
      (HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(null);
      }),
  );
  await encoding.locator("[data-image-preview-save]").click();
  await encoding.getByText("图片保存失败，请重试").waitFor({ timeout: 5000 });
  assert.equal(await encoding.locator("[data-image-preview-save]").isEnabled(), true);
  assert.equal(await encoding.locator("[data-annotation-id]").count(), 1);
  assert.equal(await encoding.evaluate(() => window.savedFiles.length), 0);
  assert.deepEqual(encodingErrors, []);
  await encoding.close();

  // 33M 源像素触发导出上限拒绝。
  const huge = await browser.newPage({ viewport: { width: 1100, height: 844 } });
  const hugeErrors = await openDialog(huge, "?size=huge");
  await draw(huge);
  await huge.locator("[data-image-preview-save]").click();
  await huge.getByText("图片保存失败，请重试").waitFor({ timeout: 5000 });
  assert.equal(await huge.evaluate(() => window.savedFiles.length), 0);
  assert.deepEqual(hugeErrors, []);
  await huge.close();
});

for (const width of [390, 1100])
  for (const theme of ["light", "dark"])
    for (const locale of ["zh-CN", "en-US"]) {
      test(`PA161-09 布局与可达性 ${width}/${theme}/${locale}`, async () => {
        const page = await browser.newPage({
          viewport: { width, height: 800 },
          hasTouch: width === 390,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const labels = LABELS[locale];
          const queryErrors = await openDialog(page, `?theme=${theme}&locale=${locale}`);
          errors.push(...queryErrors);
          await page.getByRole("toolbar", { name: labels.tools }).waitFor({ timeout: 5000 });
          for (const tool of ["select", "pen", "text", "rectangle", "ellipse", "arrow", "eraser"]) {
            assert.equal(
              await page.locator(`[data-image-preview-tool="${tool}"]`).count(),
              1,
              `${tool} 工具应存在`,
            );
          }
          assert.equal(await page.locator("[data-image-preview-save]").count(), 1);
          assert.equal(
            await page.locator('[data-image-preview-tool="pen"]').getAttribute("aria-label"),
            labels.pen,
            "工具 aria-label 应本地化",
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          assert.ok(overflow <= 1, `不应横向溢出：${overflow}px`);
          await page.screenshot({ path: join(artifacts, `${width}-${theme}-${locale}.png`) });
          assert.deepEqual(errors, []);
        } catch (error) {
          await page.screenshot({
            path: join(artifacts, `failure-${width}-${theme}-${locale}.png`),
          });
          throw error;
        } finally {
          await page.close();
        }
      });
    }
