#!/usr/bin/env node
/* eslint-disable max-lines -- M4-T1 场景共享同一套设备/CDP/provider 状态，拆文件会引入跨模块时序耦合。 */
/**
 * M4-T1 Remote origin 文件能力端到端驱动。
 *
 * 前置（与 M2-T6/M3-T5 相同）：
 *   1. 本地 Gateway 可用；`pnpm build:mobile-web` 已生成 packages/web/dist-mobile-remote。
 *   2. `scripts/mobile-m2-t6/desktop-provider-harness.mjs` 已在 ZODY_E2E_CONTROL_URL 上运行。
 *   3. Debug APK 已安装并启动；设备允许 `adb forward` 与 WebView 调试（debug 构建）。
 *   4. 通过 `node --env-file=.env.gateway.local` 提供 ZODY_GATEWAY_DEVICE_CREDENTIAL。
 *
 * 运行：
 *   node --env-file=.env.gateway.local scripts/mobile-m4-t1/run-e2e.mjs
 *
 * 可选环境：
 *   ZODY_E2E_ANDROID_SERIAL=emulator-5582
 *   ZODY_E2E_DEVTOOLS_PORT=9222
 *   ZODY_E2E_CONTROL_URL=http://127.0.0.1:39555
 *   ZODY_E2E_PUBLIC_GATEWAY_URL=http://10.0.2.2:3200
 *   ZODY_E2E_NAMESPACE=zcode
 *   ZODY_E2E_SKIP=file-selection,photo-capture,chunked-save,webview-download,csp,stale-session
 *
 * 不打印凭证；所有断言结果以 JSON 输出。只清理本脚本创建的 Downloads 行与
 * 应用拍照缓存，不删除其他用户文件。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpPage, listTargets, waitForTarget } from "../mobile-m2-t6/cdp.mjs";

const serial = process.env.ZODY_E2E_ANDROID_SERIAL || "emulator-5582";
const controlUrl = (process.env.ZODY_E2E_CONTROL_URL || "http://127.0.0.1:39555").replace(
  /\/+$/u,
  "",
);
const publicGatewayUrl = (
  process.env.ZODY_E2E_PUBLIC_GATEWAY_URL || "http://10.0.2.2:3200"
).replace(/\/+$/u, "");
const namespace = process.env.ZODY_E2E_NAMESPACE || "zcode";
const deviceCredential = process.env.ZODY_GATEWAY_DEVICE_CREDENTIAL;
const skip = new Set(
  (process.env.ZODY_E2E_SKIP || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const appId = "io.github.zclaudia.zody.mobile";
const remotePredicate = (target) =>
  target.type === "page" && target.url.includes("remote.zody.local");
const shellPredicate = (target) =>
  target.type === "page" && target.url.includes("appassets.androidplatform.net");
const scratchDir = mkdtempSync(join(tmpdir(), "zody-m4-t1-"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
const adbShell = (command) => adb("shell", command);
const adbBytes = (...args) =>
  execFileSync("adb", ["-s", serial, ...args], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
const control = (path) =>
  fetch(`${controlUrl}${path}`, { signal: AbortSignal.timeout(20000) }).then((response) =>
    response.json(),
  );

const report = { device: serial, namespace, publicGatewayUrl, scenarios: {} };

function record(name, status, details) {
  report.scenarios[name] = { status, ...details };
  console.log(`[m4-t1] ${name}: ${status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch {
      // 导航/Activity 切换期间目标可能暂时不可用。
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForProviderOnline(timeoutMs = 30000) {
  return waitFor(
    async () => {
      const status = await control("/status");
      return status.state === "online" ? status : undefined;
    },
    timeoutMs,
    "provider online",
  );
}

async function setupDevtools() {
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  const pid = adbShell(`pidof ${appId}`);
  assert(pid, "app process is not running");
  const socketDeadline = Date.now() + 20000;
  let sockets = "";
  while (Date.now() < socketDeadline) {
    sockets = adbShell("cat /proc/net/unix");
    if (sockets.includes(`@webview_devtools_remote_${pid}`)) break;
    await sleep(250);
  }
  assert(
    sockets.includes(`@webview_devtools_remote_${pid}`),
    `WebView devtools socket missing for pid ${pid}`,
  );
  const port = process.env.ZODY_E2E_DEVTOOLS_PORT || "9222";
  try {
    adb("forward", "--remove", `tcp:${port}`);
  } catch {
    // no previous forward
  }
  adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  await waitForTarget((target) => target.type === "page", 30000, "webview target");
}

function isVisibleTarget(target) {
  try {
    return JSON.parse(target.description).visible === true;
  } catch {
    return false;
  }
}

async function connectWithExpression(predicate, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const targets = (await listTargets())
      .filter(predicate)
      .sort((left, right) => Number(isVisibleTarget(right)) - Number(isVisibleTarget(left)));
    for (const target of targets) {
      let page;
      try {
        page = new CdpPage(target);
        await page.ready;
        await page.waitFor("document.body !== null", 10000, `${label} body`);
        if (await page.evaluate(expression)) return page;
        page.close();
      } catch (error) {
        lastError = error;
        try {
          page?.close();
        } catch {
          // best-effort
        }
      }
    }
    await sleep(300);
  }
  throw lastError ?? new Error(`timed out waiting for ${label}`);
}

async function bringAppToForeground() {
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  await sleep(600);
}

async function shellPage() {
  await bringAppToForeground();
  return connectWithExpression(
    shellPredicate,
    "typeof window.ZodyShellBridge === 'object' && window.ZodyShellBridge !== null",
    "shell page",
  );
}

async function remotePage() {
  return connectWithExpression(
    remotePredicate,
    "typeof window.ZodyRemoteBridge === 'object' && window.ZodyRemoteBridge !== null",
    "remote page",
  );
}

async function returnShellIfRemote() {
  const target = (await listTargets()).find(remotePredicate);
  if (!target) return;
  const page = await remotePage();
  const envelope = JSON.parse(await page.evaluate("window.ZodyRemoteBridge.getSessionContext()"));
  try {
    await page.evaluate(
      `void window.ZodyRemoteBridge.returnShell('m4-t1-reset', ${JSON.stringify(
        envelope.context.sessionId,
      )}); true`,
      { awaitPromise: false },
    );
  } catch {
    // 导航会中断 evaluate。
  }
  page.close();
  await waitForTarget(shellPredicate, 30000, "shell after return");
}

async function ensureConfigured() {
  const page = await shellPage();
  const read = JSON.parse(await page.evaluate("window.ZodyShellBridge.readConfig()"));
  if (read.config) {
    page.close();
    return { existed: true, configRevision: read.config.configRevision };
  }
  assert(deviceCredential, "ZODY_GATEWAY_DEVICE_CREDENTIAL is required for pairing");
  const draft = JSON.stringify({
    gatewayUrl: publicGatewayUrl,
    namespace,
    credential: deviceCredential,
  });
  const saved = JSON.parse(
    await page.evaluate(`window.ZodyShellBridge.saveConfig(${JSON.stringify(draft)})`),
  );
  assert(saved.ok, `saveConfig failed: ${JSON.stringify(saved)}`);
  await page.evaluate("location.reload(); true").catch(() => {});
  page.close();
  await sleep(1500);
  return { existed: false, configRevision: saved.config.configRevision };
}

async function waitPicker(page) {
  await page.waitFor(
    `document.querySelector('[data-mobile-remote-page="backend-picker"]') !== null`,
    30000,
    "backend picker",
  );
  await page.waitFor(
    `document.querySelectorAll('[data-mobile-remote-backend-item]').length > 0`,
    30000,
    "backend discovery",
  );
}

async function pickerItems(page) {
  return page.evaluate(`(() => [...document.querySelectorAll('[data-mobile-remote-backend-item]')].map((el) => ({
    id: el.getAttribute('data-mobile-remote-backend-item'),
    supported: el.getAttribute('data-supported'),
    disabled: el.disabled,
  })))()`);
}

async function clickBackend(page, backendId) {
  const clicked = await page.evaluate(`(() => {
    const item = ${JSON.stringify(backendId)}
      ? document.querySelector('[data-mobile-remote-backend-item="' + ${JSON.stringify(backendId)} + '"]')
      : [...document.querySelectorAll('[data-mobile-remote-backend-item]')].find((el) => !el.disabled);
    if (!item || item.disabled) return { ok: false, reason: 'item-unavailable' };
    item.click();
    const buttons = [...document.querySelectorAll('footer button')];
    const connect = buttons[buttons.length - 1];
    if (!connect || connect.disabled) return { ok: false, reason: 'connect-disabled' };
    connect.click();
    return { ok: true };
  })()`);
  assert(clicked.ok, `connect failed: ${JSON.stringify(clicked)}`);
  await waitForTarget(remotePredicate, 40000, "remote");
  return remotePage();
}

async function ensureRemote() {
  // 已在 Remote 文档时直接复用；只有停留在 Shell 时才需要读取/写入连接配置。
  const remoteTarget = (await listTargets()).find(remotePredicate);
  if (remoteTarget) {
    const page = await remotePage();
    try {
      await remoteContext(page);
      return {
        page,
        bootstrap: { existed: true, reusedDocument: true },
        reused: true,
      };
    } catch {
      page.close();
      await returnShellIfRemote().catch(() => {});
    }
  }
  const bootstrap = await ensureConfigured();
  const shell = await shellPage();
  await waitPicker(shell);
  const items = await pickerItems(shell);
  const selected = items.find((item) => item.supported === "true" && !item.disabled);
  assert(selected, `no selectable desktop: ${JSON.stringify(items)}`);
  const page = await clickBackend(shell, selected.id);
  await sleep(1500);
  return { page, bootstrap, reused: false };
}

async function remoteContext(page) {
  const envelope = JSON.parse(await page.evaluate("window.ZodyRemoteBridge.getSessionContext()"));
  assert(envelope.ok, `getSessionContext failed: ${JSON.stringify(envelope)}`);
  return envelope.context;
}

async function prepareReload(page, sessionId) {
  const releaseId = await page.evaluate(
    `document.querySelector('meta[name="zody-mobile-ui-release"]')?.content || 'm4-t1-release'`,
  );
  return JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(sessionId)}, ${JSON.stringify(
        releaseId,
      )})`,
    ),
  );
}

function parseNodes(xml) {
  return [...xml.matchAll(/<node\b[^>]*>/gu)].map((match) => match[0]);
}

function attribute(node, name) {
  const match = node.match(new RegExp(`\\b${name}="([^"]*)"`, "u"));
  return match?.[1] ?? "";
}

function boundsCenter(node) {
  const match = attribute(node, "bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u);
  if (!match) return undefined;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2),
  };
}

function dumpUi() {
  try {
    adbShell("uiautomator dump /sdcard/m4-t1-ui.xml >/dev/null 2>&1");
    return adbShell("cat /sdcard/m4-t1-ui.xml");
  } catch {
    return "";
  }
}

function findNode(predicate, xml = dumpUi()) {
  return parseNodes(xml).find(predicate);
}

function tapNode(predicate) {
  const node = findNode(predicate);
  const point = node ? boundsCenter(node) : undefined;
  if (!point) return false;
  adbShell(`input tap ${point.x} ${point.y}`);
  return true;
}

function tapText(text) {
  return tapNode((node) => attribute(node, "text") === text);
}

function tapContentDesc(desc) {
  return tapNode((node) => attribute(node, "content-desc") === desc);
}

function tapResourceId(id) {
  return tapNode((node) => attribute(node, "resource-id") === id);
}

function hasText(text, xml = dumpUi()) {
  return Boolean(findNode((node) => attribute(node, "text") === text, xml));
}

async function waitForText(text, timeoutMs, label = text) {
  return waitFor(() => hasText(text), timeoutMs, label);
}

async function waitForPackage(packageName, timeoutMs = 15000) {
  return waitFor(
    () => {
      const output = adbShell("dumpsys activity activities | grep -m1 topResumedActivity");
      return output.includes(packageName) ? output : undefined;
    },
    timeoutMs,
    `${packageName} resumed`,
  );
}

function cancelActiveChooser() {
  adbShell("input keyevent KEYCODE_BACK");
}

const SELECT_FILE_NAME = "0-m4-t1-select.png";
const CHUNKED_FILE_NAME = "0-m4-t1-chunked.bin";
const OPEN_FILE_NAME = "0-m4-t1-open.png";
const STALE_FILE_NAME = "0-m4-t1-stale.bin";
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=";

function pushDownloadFixture(name, bytes) {
  const localPath = join(scratchDir, name);
  writeFileSync(localPath, bytes);
  adb("push", localPath, `/sdcard/Download/${name}`);
  adbShell(
    `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/${name} >/dev/null`,
  );
}

function queryDownloadRows() {
  const output = adbShell(
    "content query --uri content://media/external/downloads --projection _id:_display_name:is_pending",
  );
  return output.split(/\r?\n/u).flatMap((line) => {
    const id = line.match(/\b_id=(\d+)/u)?.[1];
    const name = line.match(/_display_name=([^,\s]+)/u)?.[1];
    if (!id || !name) return [];
    return [{ id: Number(id), name, pending: line.includes("is_pending=1") }];
  });
}

function deleteDownloadRow(id) {
  try {
    adbShell(`content delete --uri content://media/external/downloads/${id}`);
  } catch {
    // 行可能已被 MediaStore 自动清理。
  }
}

function deleteDownloadRowsByName(name) {
  for (const row of queryDownloadRows().filter((entry) => entry.name === name)) {
    deleteDownloadRow(row.id);
  }
  try {
    adbShell(`rm -f /sdcard/Download/${name}`);
  } catch {
    // best-effort
  }
}

function readDownloadBytes(name) {
  return adbBytes("exec-out", `cat /sdcard/Download/${name}`);
}

function saveFileThroughBridge(page, sessionId, fileName, mimeType, chunksBase64, openMimeType) {
  return page.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    const begin = JSON.parse(bridge.saveFileBegin(${JSON.stringify(sessionId)}, ${JSON.stringify(
      fileName,
    )}, ${JSON.stringify(mimeType)}));
    if (!begin.ok) return { begin };
    const appends = [];
    for (const chunk of ${JSON.stringify(chunksBase64)}) {
      const result = JSON.parse(bridge.saveFileAppend(${JSON.stringify(sessionId)}, begin.token, chunk));
      appends.push(result.ok ? 'ok' : result.error?.code ?? 'failed');
      if (!result.ok) return { begin, appends };
    }
    const finish = JSON.parse(bridge.saveFileFinish(${JSON.stringify(sessionId)}, begin.token));
    let opened;
    if (finish.ok && ${JSON.stringify(openMimeType ?? null)}) {
      opened = JSON.parse(bridge.openFile(
        ${JSON.stringify(sessionId)},
        finish.file.uri,
        ${JSON.stringify(openMimeType ?? "")},
      ));
    }
    return { begin, appends, finish, opened };
  })()`);
}

function injectFileInput(page, marker) {
  return page.evaluate(`(() => {
    document.querySelectorAll('[data-e2e-file-input]').forEach((element) => element.remove());
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('data-e2e-file-input', ${JSON.stringify(marker)});
    input.style.cssText = 'position:fixed;left:12px;top:12px;width:220px;height:64px;z-index:2147483647';
    document.body.appendChild(input);
    input.click();
    return true;
  })()`);
}

async function selectedInputFiles(page, marker) {
  return page.evaluate(`(() => {
    const input = document.querySelector('[data-e2e-file-input="${marker}"]');
    return input ? [...(input.files || [])].map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })) : [];
  })()`);
}

function computeChunkedFixture() {
  const total = 600 * 1024;
  const chunkSize = 256 * 1024;
  const bytes = Buffer.alloc(total);
  for (let index = 0; index < total; index += 1) bytes[index] = index % 251;
  const chunks = [];
  for (let offset = 0; offset < total; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, total)).toString("base64"));
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    chunks,
  };
}

async function runFileSelection(page, context) {
  deleteDownloadRowsByName(SELECT_FILE_NAME);
  const png = Buffer.from(TINY_PNG_BASE64, "base64");
  pushDownloadFixture(SELECT_FILE_NAME, png);
  await waitFor(
    () => queryDownloadRows().some((row) => row.name === SELECT_FILE_NAME),
    10000,
    "fixture indexed",
  );

  await injectFileInput(page, "selection");
  await waitForText("Add attachment", 10000, "attachment source dialog");
  const busy = await prepareReload(page, context.sessionId);
  assert(busy.ok === false, "prepareReload should veto while the system chooser is active");
  assert(busy.error?.code === "native-busy", `unexpected chooser veto: ${JSON.stringify(busy)}`);

  assert(tapText("Choose file"), "Choose file action is missing");
  await waitForPackage("com.google.android.documentsui", 15000);
  // 打开 roots 抽屉并切到 Downloads，避免依赖 DocumentsUI 上次停留的目录。
  if (!hasText("Downloads")) {
    tapContentDesc("Show roots");
    await waitForText("Open from", 10000, "documents roots drawer");
    assert(tapText("Downloads"), "Downloads root is missing");
    await sleep(800);
  }
  // 强制回到网格视图，保证首格坐标稳定。
  if (findNode((node) => attribute(node, "content-desc") === "Grid view")) {
    tapContentDesc("Grid view");
    await sleep(600);
  }
  // 夹具以 0- 开头，Downloads 按名称排序时位于首格；选中后仍按文件名/大小验证。
  const files = await waitFor(
    async () => {
      adbShell("input tap 216 828");
      await sleep(800);
      const selected = await selectedInputFiles(page, "selection");
      return selected.length > 0 ? selected : undefined;
    },
    20000,
    "selected input files",
  );
  assert(
    files[0].name === SELECT_FILE_NAME,
    `selected ${files[0].name} instead of ${SELECT_FILE_NAME}; clean unrelated Downloads fixtures`,
  );
  assert(files[0].size === png.length, `selected size ${files[0].size} != ${png.length}`);
  assert(files[0].type === "image/png", `selected type ${files[0].type}`);

  const ready = await prepareReload(page, context.sessionId);
  assert(
    ready.ok === true && ready.status === "ready",
    `chooser did not release: ${JSON.stringify(ready)}`,
  );
  record("file-selection", "pass", {
    files,
    chooserVeto: busy.error.code,
    readyAfterSelection: ready.status,
  });
}

async function runPhotoCapture(page, context) {
  // 完整拍照：input image/* -> Take photo -> 相机 -> shutter -> done，页面收到 JPEG。
  await injectFileInput(page, "photo");
  await waitForText("Take photo", 10000, "take photo action");
  assert(tapText("Take photo"), "Take photo action is missing");
  if (hasText("While using the app")) {
    assert(tapText("While using the app"), "camera permission allow action is missing");
  }
  const camera = await waitForPackage("com.android.camera2", 20000).catch(() => undefined);
  if (!camera) {
    cancelActiveChooser();
    await waitForPackage(appId, 10000);
    record("photo-capture", "skipped", {
      reason: "camera app unavailable on this device",
    });
    return;
  }
  assert(tapResourceId("com.android.camera2:id/shutter_button"), "camera shutter is missing");
  await waitFor(
    () =>
      Boolean(
        findNode((node) => attribute(node, "resource-id") === "com.android.camera2:id/done_button"),
      ),
    15000,
    "camera confirm action",
  );
  assert(tapResourceId("com.android.camera2:id/done_button"), "camera done action is missing");
  const captured = await waitFor(
    async () => {
      const files = await selectedInputFiles(page, "photo");
      return files.length > 0 ? files : undefined;
    },
    20000,
    "captured photo",
  );
  assert(
    /^zody-photo-.+\.jpg$/u.test(captured[0].name),
    `unexpected photo name ${captured[0].name}`,
  );
  assert(captured[0].type === "image/jpeg", `unexpected photo type ${captured[0].type}`);
  assert(captured[0].size > 1000, `captured photo is too small: ${captured[0].size}`);

  // 取消拍照：相机返回后页面必须收到空结果，原生 busy 解除。
  await injectFileInput(page, "photo-cancel");
  await waitForText("Take photo", 10000, "take photo action for cancel");
  assert(tapText("Take photo"), "Take photo action is missing for cancel");
  await waitForPackage("com.android.camera2", 20000);
  cancelActiveChooser();
  await waitForPackage(appId, 10000);
  const cancelled = await selectedInputFiles(page, "photo-cancel");
  assert(cancelled.length === 0, `cancelled capture returned files: ${JSON.stringify(cancelled)}`);
  const ready = await prepareReload(page, context.sessionId);
  assert(ready.ok === true, `cancelled capture did not release: ${JSON.stringify(ready)}`);
  record("photo-capture", "pass", {
    captured,
    cancelledFiles: cancelled,
    readyAfterCancel: ready.status,
  });
}

async function runChunkedSaveAndOpen(page, context) {
  deleteDownloadRowsByName(CHUNKED_FILE_NAME);
  deleteDownloadRowsByName(OPEN_FILE_NAME);
  const fixture = computeChunkedFixture();

  const saved = await saveFileThroughBridge(
    page,
    context.sessionId,
    CHUNKED_FILE_NAME,
    "application/octet-stream",
    fixture.chunks,
    null,
  );
  assert(saved.begin?.ok && saved.finish?.ok, `chunked save failed: ${JSON.stringify(saved)}`);
  assert(saved.appends.length === 3, `expected 3 chunks, got ${saved.appends.length}`);
  assert(
    saved.appends.every((entry) => entry === "ok"),
    `append failure: ${JSON.stringify(saved.appends)}`,
  );
  assert(
    saved.finish.file.displayPath === `Download/${CHUNKED_FILE_NAME}`,
    `unexpected display path ${saved.finish.file.displayPath}`,
  );
  const bytes = readDownloadBytes(CHUNKED_FILE_NAME);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert(
    bytes.length === fixture.bytes.length,
    `byte count ${bytes.length} != ${fixture.bytes.length}`,
  );
  assert(sha256 === fixture.sha256, "chunked save content hash mismatch");
  const chunkedRow = await waitFor(
    () => {
      const row = queryDownloadRows().find((entry) => entry.name === CHUNKED_FILE_NAME);
      return row && !row.pending ? row : undefined;
    },
    10000,
    "chunked save committed",
  );

  // 保存后用系统应用打开：使用真实 PNG，验证 MediaStore URI 进入 ACTION_VIEW。
  const png = Buffer.from(TINY_PNG_BASE64, "base64");
  const opened = await saveFileThroughBridge(
    page,
    context.sessionId,
    OPEN_FILE_NAME,
    "image/png",
    [png.toString("base64")],
    "image/png",
  );
  assert(opened.finish?.ok, `png save failed: ${JSON.stringify(opened)}`);
  assert(
    opened.opened?.opened === true,
    `openFile did not start a viewer: ${JSON.stringify(opened.opened)}`,
  );
  const viewer = await waitForPackage("com.google.android.apps.photos", 10000).catch(
    () => undefined,
  );
  // 返回到 Remote，继续后续场景。
  cancelActiveChooser();
  await waitForPackage(appId, 15000);
  const ready = await prepareReload(page, context.sessionId);
  assert(ready.ok === true, `finished save blocked reload: ${JSON.stringify(ready)}`);

  record("chunked-save-and-open", "pass", {
    chunks: saved.appends.length,
    bytes: bytes.length,
    sha256,
    displayPath: saved.finish.file.displayPath,
    committedRow: chunkedRow,
    openResult: opened.opened,
    viewer: viewer ?? "no photos activity observed",
    readyAfterSave: ready.status,
  });
}

async function runSaveFailureAndCancel(page, context) {
  const oversized = Buffer.alloc(1024 * 1024 + 1, 7).toString("base64");
  const failure = await page.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    const begin = JSON.parse(bridge.saveFileBegin(
      ${JSON.stringify(context.sessionId)}, '0-m4-t1-oversized.bin', 'application/octet-stream'));
    if (!begin.ok) return { begin };
    const append = JSON.parse(bridge.saveFileAppend(
      ${JSON.stringify(context.sessionId)}, begin.token, ${JSON.stringify(oversized)}));
    const abort = JSON.parse(bridge.saveFileAbort(${JSON.stringify(context.sessionId)}, begin.token));
    return { begin: begin.ok, append, abort };
  })()`);
  assert(
    failure.begin === true && failure.append.ok === false,
    `oversized chunk accepted: ${JSON.stringify(failure)}`,
  );
  assert(
    failure.append.error?.code === "invalid-argument",
    `unexpected append error: ${JSON.stringify(failure.append)}`,
  );
  assert(failure.abort.ok === true, `abort failed: ${JSON.stringify(failure.abort)}`);
  assert(
    !queryDownloadRows().some((row) => row.name === "0-m4-t1-oversized.bin"),
    "failed save left a Downloads row",
  );

  const cancelName = "0-m4-t1-cancelled.bin";
  deleteDownloadRowsByName(cancelName);
  const cancelled = await page.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    const begin = JSON.parse(bridge.saveFileBegin(
      ${JSON.stringify(context.sessionId)}, ${JSON.stringify(cancelName)}, 'application/octet-stream'));
    if (!begin.ok) return { begin };
    const append = JSON.parse(bridge.saveFileAppend(
      ${JSON.stringify(context.sessionId)}, begin.token, btoa('partial')));
    const abort = JSON.parse(bridge.saveFileAbort(${JSON.stringify(context.sessionId)}, begin.token));
    return { begin: begin.ok, append: append.ok, abort: abort.ok };
  })()`);
  assert(
    cancelled.begin && cancelled.append && cancelled.abort,
    `cancel sequence failed: ${JSON.stringify(cancelled)}`,
  );
  await sleep(500);
  assert(
    !queryDownloadRows().some((row) => row.name === cancelName),
    "cancelled save left a Downloads row",
  );
  const ready = await prepareReload(page, context.sessionId);
  assert(ready.ok === true, `cancelled save blocked reload: ${JSON.stringify(ready)}`);
  record("save-failure-and-cancel", "pass", {
    oversized: failure,
    cancelled,
    readyAfterCancel: ready.status,
  });
}

async function runWebViewDownload(page) {
  const before = queryDownloadRows();
  const beforeIds = new Set(before.map((row) => row.id));
  const payload = "m4-t1-webview-download\n";
  await page.evaluate(`(() => {
    document.querySelectorAll('[data-e2e-download]').forEach((element) => element.remove());
    const anchor = document.createElement('a');
    anchor.href = 'data:text/plain;base64,' + btoa(${JSON.stringify(payload)});
    // 没有 download 属性时 Chrome 会拒绝主框架导航到 data:；DownloadListener 只在下载语义下触发。
    anchor.download = 'm4-t1-download.txt';
    anchor.setAttribute('data-e2e-download', 'true');
    anchor.textContent = 'm4-t1-download';
    document.body.appendChild(anchor);
    anchor.click();
    return true;
  })()`);
  const row = await waitFor(
    () => {
      const created = queryDownloadRows().filter((entry) => !beforeIds.has(entry.id));
      return created.find((entry) => !entry.pending) ?? undefined;
    },
    20000,
    "WebView download committed",
  );
  const bytes = adbBytes(
    "exec-out",
    `content read --uri content://media/external/downloads/${row.id}`,
  );
  assert(
    bytes.toString("utf8") === payload,
    `download content mismatch: ${JSON.stringify(bytes.toString("utf8"))}`,
  );
  // DownloadListener 成功后会用系统应用打开；确保后续场景回到 Remote 前台。
  const top = adbShell("dumpsys activity activities | grep -m1 topResumedActivity");
  if (!top.includes(appId)) {
    cancelActiveChooser();
    await waitForPackage(appId, 10000).catch(() => undefined);
  }
  // 只删除本次新增的行，避免碰到同名用户文件。
  deleteDownloadRow(row.id);
  record("webview-download", "pass", {
    row,
    bytes: bytes.length,
    content: payload.trim(),
  });
}

async function runCspProbes(page) {
  const probes = await page.evaluate(`(async () => {
    const probe = async (url) => {
      try {
        const response = await fetch(url);
        return { ok: true, status: response.status };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    };
    const blobUrl = URL.createObjectURL(new Blob(['m4-t1'], { type: 'text/plain' }));
    const result = {
      csp: null,
      gateway: await probe(${JSON.stringify(`${publicGatewayUrl}/health`)}),
      arbitrary: await probe('https://example.com/'),
      data: await probe('data:text/plain,m4-t1'),
      blob: await probe(blobUrl),
    };
    URL.revokeObjectURL(blobUrl);
    try {
      const response = await fetch('/assets/remote/index.html');
      result.csp = response.headers.get('content-security-policy');
    } catch (error) {
      result.cspError = String(error);
    }
    return result;
  })()`);
  assert(probes.csp, `CSP header unavailable: ${JSON.stringify(probes)}`);
  const connect = probes.csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src"));
  assert(connect, `connect-src missing from CSP: ${probes.csp}`);
  assert(connect.includes(new URL(publicGatewayUrl).origin), `gateway origin missing: ${connect}`);
  assert(!connect.includes("*"), `connect-src must not use a wildcard: ${connect}`);
  assert(
    !connect.includes("example.com"),
    `connect-src must not allow arbitrary origins: ${connect}`,
  );
  assert(probes.gateway.ok, `gateway sourceUrl fetch failed: ${JSON.stringify(probes.gateway)}`);
  assert(
    !probes.arbitrary.ok,
    `arbitrary origin fetch was not blocked by CSP: ${JSON.stringify(probes.arbitrary)}`,
  );
  record("csp-source-origins", "pass", {
    connect,
    gateway: probes.gateway,
    arbitrary: probes.arbitrary,
    data: probes.data,
    blob: probes.blob,
  });
}

async function runStaleSessionSwitch(page, context) {
  // 在旧 session 留下未完成保存和已经保存的 URI，然后切回 Shell 重新打开 Remote。
  const token = await page.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    const begin = JSON.parse(bridge.saveFileBegin(
      ${JSON.stringify(context.sessionId)}, ${JSON.stringify(STALE_FILE_NAME)}, 'application/octet-stream'));
    if (!begin.ok) return null;
    const append = JSON.parse(bridge.saveFileAppend(
      ${JSON.stringify(context.sessionId)}, begin.token, btoa('stale-partial')));
    return append.ok ? begin.token : null;
  })()`);
  assert(token, "failed to start the stale save session");
  const png = Buffer.from(TINY_PNG_BASE64, "base64");
  const saved = await saveFileThroughBridge(
    page,
    context.sessionId,
    "0-m4-t1-stale-uri.png",
    "image/png",
    [png.toString("base64")],
    null,
  );
  assert(saved.finish?.ok, `stale uri fixture failed: ${JSON.stringify(saved)}`);

  try {
    await page.evaluate(
      `void window.ZodyRemoteBridge.returnShell('m4-t1-switch', ${JSON.stringify(
        context.sessionId,
      )}); true`,
      { awaitPromise: false },
    );
  } catch {
    // 导航中断 evaluate。
  }
  page.close();
  await waitForTarget(shellPredicate, 30000, "shell after switch");
  const shell = await shellPage();
  await waitPicker(shell);
  const selected = (await pickerItems(shell)).find(
    (item) => item.supported === "true" && !item.disabled,
  );
  assert(selected, "no backend available after returning to shell");
  const next = await clickBackend(shell, selected.id);
  await sleep(1500);
  const nextContext = await remoteContext(next);
  assert(nextContext.sessionId !== context.sessionId, "session id did not rotate");

  const stale = await next.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    return {
      finish: JSON.parse(bridge.saveFileFinish(
        ${JSON.stringify(context.sessionId)}, ${JSON.stringify(token)})),
      open: JSON.parse(bridge.openFile(
        ${JSON.stringify(context.sessionId)},
        ${JSON.stringify(saved.finish.file.uri)},
        'image/png')),
      abort: JSON.parse(bridge.saveFileAbort(
        ${JSON.stringify(context.sessionId)}, ${JSON.stringify(token)})),
    };
  })()`);
  assert(
    stale.finish.error?.code === "stale-session",
    `stale finish accepted: ${JSON.stringify(stale.finish)}`,
  );
  assert(
    stale.open.error?.code === "stale-session",
    `stale open accepted: ${JSON.stringify(stale.open)}`,
  );
  assert(
    stale.abort.error?.code === "stale-session",
    `stale abort accepted: ${JSON.stringify(stale.abort)}`,
  );
  const ready = await prepareReload(next, nextContext.sessionId);
  assert(ready.ok === true, `new session is blocked: ${JSON.stringify(ready)}`);

  // markRemoteReady（页面业务 ready）应立即回收旧 session 的未完成保存；
  // 等 MediaStore 完成清理后再断言旧文件名没有残留行。
  await sleep(1000);
  const leftover = queryDownloadRows().filter((row) => row.name === STALE_FILE_NAME);
  assert(leftover.length === 0, `orphan save row not reclaimed: ${JSON.stringify(leftover)}`);
  record("stale-session-switch", "pass", {
    previousSession: context.sessionId,
    nextSession: nextContext.sessionId,
    stale,
    ready: ready.status,
    orphanRows: leftover,
  });
  return next;
}

async function cleanupArtifacts() {
  for (const name of [
    SELECT_FILE_NAME,
    CHUNKED_FILE_NAME,
    OPEN_FILE_NAME,
    STALE_FILE_NAME,
    "0-m4-t1-stale-uri.png",
    "0-m4-t1-oversized.bin",
    "0-m4-t1-cancelled.bin",
  ]) {
    deleteDownloadRowsByName(name);
  }
  try {
    adbShell("run-as io.github.zclaudia.zody.mobile rm -rf cache/camera");
  } catch {
    // 非 debuggable 或目录已不存在。
  }
}

const scenarios = [
  ["file-selection", runFileSelection],
  ["photo-capture", runPhotoCapture],
  ["chunked-save-and-open", runChunkedSaveAndOpen],
  ["save-failure-and-cancel", runSaveFailureAndCancel],
  ["webview-download", runWebViewDownload],
  ["csp-source-origins", runCspProbes],
  ["stale-session-switch", runStaleSessionSwitch],
];

try {
  await setupDevtools();
  const online = await waitForProviderOnline();
  report.providerOnline = online;
  const { page, bootstrap, reused } = await ensureRemote();
  report.bootstrap = bootstrap;
  report.remote = { reused };
  let current = page;
  let context = await remoteContext(current);
  report.session = {
    backendId: context.backendId,
    sessionId: context.sessionId,
  };
  for (const [name, run] of scenarios) {
    if (skip.has(name)) {
      record(name, "skipped", { reason: "ZODY_E2E_SKIP" });
      continue;
    }
    try {
      const next = await run(current, context);
      if (next) {
        current = next;
        context = await remoteContext(current);
      }
    } catch (error) {
      record(name, "fail", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  current.close();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await cleanupArtifacts().catch(() => {});
}

const failed = Object.values(report.scenarios).some((scenario) => scenario.status === "fail");
const output = `${JSON.stringify(report, null, 2)}\n`;
await new Promise((resolve) => process.stdout.write(output, resolve));
process.exit(report.error || failed ? 1 : 0);
