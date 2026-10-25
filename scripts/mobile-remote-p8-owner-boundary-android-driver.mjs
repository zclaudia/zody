#!/usr/bin/env node
/* eslint-disable max-lines -- P8 owner-boundary 设备操作按 backup/setup/click/release/restore 生命周期共享同一套 adb 与桥工具，集中维护避免交接状态漂移。 */
// P8 owner-boundary 场景的 Android 设备操作 driver。
// 用法：
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs backup
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs setup
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs click owner|taskdeleted|workspaceclosed
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs release
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs status
//   node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs restore
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { _android } from "playwright-core";

const repoRoot = process.cwd();
const sharedDir = resolve(repoRoot, ".tmp/mobile-remote-p8-owner-boundary");
const artifactDir = join(sharedDir, "artifacts");
const backupDir = join(sharedDir, "device-backup");
const deviceSerial = process.env.ZODY_P8_OWNER_DEVICE?.trim() || "emulator-5554";
const pkg = "io.github.zclaudia.zody.mobile";
const credentialsPath = process.env.ZCODE_P8_CREDENTIAL_FILE?.trim();

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function adbText(args, options = {}) {
  const result = spawnSync("adb", ["-s", deviceSerial, ...args], { encoding: "utf8", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`adb ${args.join(" ")} failed: ${(result.stderr || "").slice(0, 300)}`);
  }
  return result.stdout?.toString() ?? "";
}

// adb shell 走 pty 会把 \n 翻成 \r\n；字节级读写一律用 exec-out / push。
function adbBytes(args, options = {}) {
  const result = spawnSync("adb", ["-s", deviceSerial, ...args], { encoding: "buffer", ...options });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`adb ${args.join(" ")} failed: ${(result.stderr || "").slice(0, 300)}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writePrivate(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function waitForFile(path, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readJson(path);
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Timed out waiting for ${label} at ${path}`);
}

async function getDevice() {
  const devices = await _android.devices({ omitDriverInstall: true });
  const device = devices.find((candidate) => candidate.serial() === deviceSerial);
  if (!device) throw new Error(`Android device ${deviceSerial} is not connected`);
  return device;
}

async function getBridgePage(device) {
  const webView = await device.webView({ pkg });
  return webView.page();
}

// WebView 执行上下文重建期间 evaluate 可能挂起；统一加超时保护。
function guardedEvaluate(page, fn, timeoutMs = 8000) {
  return Promise.race([
    page.evaluate(fn),
    sleep(timeoutMs).then(() => null),
  ]);
}

// Kotlin 桥把"无 pending"返回为 undefined；JSON.parse(undefined) 抛错进入 catch。
// 只有携带 backendId/notificationId 的对象才算未消费的 pending。
function isPendingClick(value) {
  return value != null && typeof value === "object" && value.backendId != null;
}

async function nativeStatus(page) {
  const raw = await guardedEvaluate(page, () => {
    const value = window.ZcodeMobileBridge?.notificationGetStatus?.();
    try {
      return JSON.parse(value);
    } catch {
      return { raw: typeof value === "string" ? value : null };
    }
  });
  return raw ?? { status: "evaluate-timeout" };
}

async function nativePending(page) {
  const raw = await guardedEvaluate(page, () => {
    const value = window.ZcodeMobileBridge?.notificationGetPendingClick?.();
    try {
      return JSON.parse(value);
    } catch {
      return { raw: typeof value === "string" ? value : null };
    }
  });
  return raw ?? { status: "evaluate-timeout" };
}

function expandShade() {
  adbText(["shell", "cmd", "statusbar", "expand-notifications"], { allowFailure: true });
}

function collapseShade() {
  adbText(["shell", "cmd", "statusbar", "collapse"], { allowFailure: true });
}

function parseBounds(value) {
  const match = value?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function dumpShadeXml() {
  adbText(["shell", "uiautomator", "dump", "/sdcard/owner_boundary_dump.xml"], {
    allowFailure: true,
  });
  return adbText(["shell", "cat", "/sdcard/owner_boundary_dump.xml"]);
}

/** 通知卡片标题；API 34 上分组 summary 会复用最新子卡文本，必须命中真实子卡。 */
const CARD_TITLES = ["A task has finished.", "任务已完成"];

function latestZodyDeepLinkCount() {
  const logs = adbText(["logcat", "-d", "-s", "ActivityTaskManager:I"], { allowFailure: true });
  return (logs.match(/dat=zody:\/\//g) ?? []).length;
}

/**
 * 展开通知栏并点击最新的 Zody 任务卡片。
 * 分组 summary 的 contentIntent 是 launcher intent，必须跳过：候选按“最靠下优先”
 * （真实子卡位于 summary 之下），每次 tap 后用 logcat 中新增的 zody:// ACTION_VIEW
 * 深链作为命中证据，未命中则换下一个候选。
 */
async function tapTopZodyNotification() {
  expandShade();
  await sleep(800);
  let tapped;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // 保活通知与任务卡同 app 会被自动归组：折叠态只显示 summary（launcher intent），
    // 必须先点 'Expand' 展开分组，露出带 zody:// 深链的子卡。
    let xml = dumpShadeXml();
    const expandButton = [...xml.matchAll(/<node[^>]*content-desc="Expand"[^>]*>/g)]
      .map((match) => parseBounds(match[0].match(/bounds="([^"]+)"/)?.[1]))
      .find((bounds) => bounds);
    if (expandButton) {
      adbText([
        "shell",
        "input",
        "tap",
        String(Math.round((expandButton.left + expandButton.right) / 2)),
        String(Math.round((expandButton.top + expandButton.bottom) / 2)),
      ]);
      await sleep(900);
      xml = dumpShadeXml();
    }
    const nodes = [...xml.matchAll(/<node[^>]*>/g)]
      .map((match) => match[0])
      .map((node) => ({
        bounds: parseBounds(node.match(/bounds="([^"]+)"/)?.[1]),
        text: node.match(/text="([^"]*)"/)?.[1] ?? "",
      }))
      .filter(
        (node) =>
          node.bounds && node.bounds.height > 20 && CARD_TITLES.includes(node.text),
      )
      // 展开后真实子卡按最新在上排列；优先点击最新一张，未命中（summary/不可点）再往下试。
      .sort((left, right) => left.bounds.top - right.bounds.top);
    if (nodes.length > 0) {
      for (const node of nodes) {
        const before = latestZodyDeepLinkCount();
        const center = {
          x: Math.round((node.bounds.left + node.bounds.right) / 2),
          y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
        };
        adbText(["shell", "input", "tap", String(center.x), String(center.y)]);
        await sleep(2500);
        if (latestZodyDeepLinkCount() > before) {
          tapped = { bounds: node.bounds, text: node.text, deepLinkFired: true };
          break;
        }
        // 未触发深链：可能是分组 summary（launcher intent）或不可点击区域。收起再展开重试。
        collapseShade();
        await sleep(400);
        expandShade();
        await sleep(800);
      }
      if (tapped) break;
    }
    if (attempt === 19)
      throw new Error(`通知栏中未能点击到 Zody 任务卡片的 zody:// 深链（标题 ${CARD_TITLES.join("/")}）`);
    expandShade();
    await sleep(800);
  }
  collapseShade();
  return tapped;
}

async function clearZodyNotifications() {
  expandShade();
  await sleep(600);
  const xml = dumpShadeXml();
  const cardTitles = ["A task has finished.", "任务已完成"];
  const titleRe = /<node[^>]*text="(A task has finished\.|任务已完成)"[^>]*>/g;
  if (![...xml.matchAll(titleRe)].length) {
    collapseShade();
    return { cleared: false, reason: "no-zody-cards" };
  }
  const clearAll = [...xml.matchAll(/<node[^>]*text="(Clear all|Clear all notifications|清除)"[^>]*>/g)]
    .map((match) => parseBounds(match[0].match(/bounds="([^"]+)"/)?.[1]))
    .find((bounds) => bounds);
  if (clearAll) {
    adbText([
      "shell",
      "input",
      "tap",
      String(Math.round((clearAll.left + clearAll.right) / 2)),
      String(Math.round((clearAll.top + clearAll.bottom) / 2)),
    ]);
    await sleep(600);
  } else {
    // 没有 Clear all 时对每张标题卡片做横滑 dismissing。
    const cards = [...xml.matchAll(titleRe)]
      .map((match) => parseBounds(match[0].match(/bounds="([^"]+)"/)?.[1]))
      .filter((bounds) => bounds);
    for (const card of cards) {
      const y = Math.round((card.top + card.bottom) / 2);
      adbText([
        "shell",
        "input",
        "swipe",
        String(card.right - 8),
        String(y),
        String(card.left + 8),
        String(y),
        "220",
      ]);
      await sleep(300);
    }
  }
  collapseShade();
  return { cleared: true };
}

async function clickDialogCloseButton(page) {
  for (const name of ["Close", "关闭"]) {
    const button = page.getByRole("button", { name });
    if (await button.count()) {
      await button.first().click();
      return name;
    }
  }
  throw new Error("Failure notice did not expose a Close button");
}

/**
 * Desktop 离线窗口会让 WebView 停在 failure screen（如 Desktop Timed Out），
 * native 订阅恢复不代表 web 会话可用；点击卡前必须先恢复到健康页。
 * evaluate 在上下文重建期间可能挂起，统一加超时保护；不用 reload（会拆掉执行上下文）。
 */
async function ensureWebSessionHealthy(page) {
  const failureMarkers = ["Timed Out", "Invalid credential", "Could not connect"];
  const bodyText = () =>
    Promise.race([
      page.evaluate(() => document.body.innerText.slice(0, 800)),
      sleep(8000).then(() => ""),
    ]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const body = await bodyText();
    if (!body) {
      await sleep(2000);
      continue;
    }
    if (!failureMarkers.some((marker) => body.includes(marker))) return;
    const retry = page.getByRole("button", { name: "Retry" });
    try {
      if (await retry.count()) {
        await retry.first().click({ timeout: 5000 });
      }
    } catch {
      /* Retry 按钮随重建消失时下一轮再试 */
    }
    await sleep(3000);
  }
  const body = await bodyText();
  if (failureMarkers.some((marker) => body.includes(marker))) {
    throw new Error(`Web 会话未能从失败页恢复: ${body.slice(0, 120)}`);
  }
}

async function commandBackup() {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const listing = adbText(["shell", "su", "0", "ls", `/data/data/${pkg}/shared_prefs`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const manifest = [];
  for (const name of listing) {
    const remote = `/data/data/${pkg}/shared_prefs/${name}`;
    const bytes = adbBytes(["exec-out", "su", "0", "cat", remote]);
    if (bytes.byteLength === 0) throw new Error(`Empty read for ${remote}`);
    await writeFile(join(backupDir, name), bytes);
    const stat = adbText([
      "shell",
      `su 0 stat -c '%u %g %a' ${remote}`,
    ]).trim();
    manifest.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      stat,
    });
  }
  await writePrivate(join(backupDir, "manifest.json"), {
    device: deviceSerial,
    pkg,
    files: manifest,
  });
  console.log(`Backed up ${manifest.length} shared_prefs files for ${pkg}.`);
}

async function commandSetup() {
  const trace = (step) => console.error(`[setup] ${step}`);
  if (!credentialsPath) throw new Error("Set ZCODE_P8_CREDENTIAL_FILE before driving the device");
  trace("reading-credentials");
  const credentials = await readJson(credentialsPath);
  trace("waiting-ready");
  const ready = await waitForFile(join(sharedDir, "ready.json"), "WDIO ready.json", 30 * 60_000);
  trace("got-device-list");
  const device = await getDevice();
  trace("launching-app");
  // monkey 在无物理键的模拟器上会 abort；直接显式启动 MainActivity。
  adbText(["shell", "am", "start", "-n", `${pkg}/.MainActivity`], { allowFailure: true });
  trace("attaching-webview");
  const page = await getBridgePage(device);
  trace("webview-attached");
  // 开屏可能是首次设置的 Gateway 表单，也可能是已配置后的 backend 选择/首页；
  // 只在表单可见时才填写，凭据不变时沿用既有配置。
  const gatewayUrlInput = page.locator("#mobile-remote-gateway-url");
  trace("checking-settings-form");
  const settingsVisible = await gatewayUrlInput
    .isVisible({ timeout: 8_000 })
    .catch(() => false);
  trace(`settingsVisible=${settingsVisible}`);
  if (settingsVisible) {
    await gatewayUrlInput.fill(credentials.gatewayUrl);
    await page.locator("#mobile-remote-namespace").fill(credentials.namespace);
    await page.locator("#mobile-remote-credential").fill(credentials.deviceCredential);
    await page.locator('[data-mobile-remote-settings-submit="true"]').click();
    trace("settings-submitted");
  }
  // 后端选择页：连接唯一在线 backend（已选择过则可能直接跳过）。
  const backendItem = page.locator(`[data-mobile-remote-backend-item="${ready.backendId}"]`);
  trace("checking-backend-picker");
  if (await backendItem.isVisible({ timeout: 20_000 }).catch(() => false)) {
    await backendItem.click();
    await page.locator('[data-mobile-remote-backend-confirm="true"]').click();
    trace("backend-confirmed");
  }
  let status;
  const deadline = Date.now() + 60_000;
  for (;;) {
    status = await nativeStatus(page);
    if (status?.status === "ready") break;
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  trace(`nativeStatus=${JSON.stringify(status)}`);
  if (status?.status !== "ready") {
    throw new Error(`Native push subscription did not become ready: ${JSON.stringify(status)}`);
  }
  trace("ensuring-web-session");
  await ensureWebSessionHealthy(page);
  trace("web-session-healthy");
  await writePrivate(join(sharedDir, "android-setup.json"), {
    state: "subscription-ready",
    backendId: ready.backendId,
    nativeStatus: status,
    at: new Date().toISOString(),
  });
  await writePrivate(join(sharedDir, "trigger-owner.json"), {
    state: "android-ready",
    at: new Date().toISOString(),
  });
  await device.close();
  console.log(`Android connected to backend ${ready.backendId}; trigger-owner.json written.`);
}

async function commandClick(label) {
  if (!["owner", "taskdeleted", "workspaceclosed"].includes(label)) {
    throw new Error(`Unknown click label: ${label}`);
  }
  const result = await waitForFile(
    join(sharedDir, `result-${label}.json`),
    `WDIO result-${label}.json`,
    10 * 60_000,
  );
  await mkdir(artifactDir, { recursive: true });
  const device = await getDevice();
  const page = await getBridgePage(device);
  try {
    await ensureWebSessionHealthy(page);
    // 回到桌面再点系统卡片，保证点击走 OS 通知入口而不是已在 App 内。
    adbText(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await sleep(600);
    const tapped = await tapTopZodyNotification();
    if (label === "owner") {
      await page
        .getByText(result.expectedResponse, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });
      await page.screenshot({ path: join(artifactDir, `click-${label}-task.png`) });
      const pendingAfterClick = await nativePending(page);
      if (isPendingClick(pendingAfterClick)) {
        throw new Error(
          `Owner click did not clear the native pending slot: ${JSON.stringify(pendingAfterClick)}`,
        );
      }
      await writePrivate(join(sharedDir, `click-${label}.json`), {
        label,
        notificationId: result.notificationId,
        workspaceIdentity: result.workspaceIdentity,
        remoteSessionId: result.remoteSessionId,
        taskId: result.taskId,
        sessionId: result.sessionId,
        opened: true,
        observedBody: result.expectedResponse,
        nativePendingAfterClick: pendingAfterClick,
        tappedCard: tapped,
        at: new Date().toISOString(),
      });
    } else {
      const dialogTitle = page.locator("#mobile-notification-error-title");
      await dialogTitle.waitFor({ state: "visible", timeout: 60_000 });
      const titleText = await dialogTitle.innerText();
      await page.screenshot({ path: join(artifactDir, `click-${label}-notice.png`) });
      const closeName = await clickDialogCloseButton(page);
      await dialogTitle.waitFor({ state: "hidden", timeout: 10_000 });
      const pendingAfterClose = await nativePending(page);
      await writePrivate(join(sharedDir, `click-${label}.json`), {
        label,
        notificationId: result.notificationId,
        rejected: true,
        dialogTitle: titleText,
        closeButton: closeName,
        nativePendingAfterClose: pendingAfterClose,
        tappedCard: tapped,
        at: new Date().toISOString(),
      });
    }
    console.log(`click-${label}.json written.`);
  } finally {
    await device.close();
  }
}

async function commandRelease() {
  await writePrivate(join(sharedDir, "release.json"), {
    state: "operator-release",
    at: new Date().toISOString(),
  });
  console.log("release.json written.");
}

async function commandStatus() {
  const device = await getDevice();
  try {
    const page = await getBridgePage(device);
    console.log(
      JSON.stringify(
        { status: await nativeStatus(page), pending: await nativePending(page) },
        null,
        2,
      ),
    );
  } finally {
    await device.close();
  }
}

async function commandRestore() {
  const manifest = await readJson(join(backupDir, "manifest.json"));
  // 先停 App（HOME → am kill → 残留 PID SIGTERM），再恢复 prefs。
  adbText(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  adbText(["shell", "am", "kill", pkg], { allowFailure: true });
  const pidLine = adbText(["shell", "pidof", pkg], { allowFailure: true }).trim();
  if (pidLine) {
    for (const pid of pidLine.split(/\s+/).filter(Boolean)) {
      adbText(["shell", "su", "0", "kill", pid], { allowFailure: true });
    }
  }
  const staging = await mkdtemp(join(tmpdir(), "zody-owner-restore-"));
  const restored = [];
  try {
    for (const file of manifest.files) {
      const local = join(staging, file.name);
      await writeFile(local, await readFile(join(backupDir, file.name)));
      adbText(["push", local, `/data/local/tmp/${file.name}`]);
      const [uid, gid, mode] = file.stat.split(/\s+/);
      adbText([
        "shell",
        "su",
        "0",
        "cp",
        `/data/local/tmp/${file.name}`,
        `/data/data/${pkg}/shared_prefs/${file.name}`,
      ]);
      adbText([
        "shell",
        "su",
        "0",
        "chown",
        `${uid}:${gid}`,
        `/data/data/${pkg}/shared_prefs/${file.name}`,
      ]);
      adbText([
        "shell",
        "su",
        "0",
        "chmod",
        mode,
        `/data/data/${pkg}/shared_prefs/${file.name}`,
      ]);
      adbText(["shell", "rm", "-f", `/data/local/tmp/${file.name}`], { allowFailure: true });
      const after = adbBytes([
        "exec-out",
        "su",
        "0",
        "cat",
        `/data/data/${pkg}/shared_prefs/${file.name}`,
      ]);
      const sha256 = createHash("sha256").update(after).digest("hex");
      restored.push({
        name: file.name,
        sha256,
        expected: file.sha256,
        match: sha256 === file.sha256,
      });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  // 清理本轮运行中新出现、备份里没有的 prefs 文件。
  const backupNames = new Set(manifest.files.map((file) => file.name));
  const current = adbText(["shell", "su", "0", "ls", `/data/data/${pkg}/shared_prefs`])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const extra = current.filter((name) => !backupNames.has(name));
  for (const name of extra) {
    adbText(["shell", "su", "0", "rm", `/data/data/${pkg}/shared_prefs/${name}`], {
      allowFailure: true,
    });
  }
  const cleared = await clearZodyNotifications().catch((error) => ({
    cleared: false,
    error: String(error),
  }));
  adbText(["shell", "am", "kill", pkg], { allowFailure: true });
  await writePrivate(join(sharedDir, "device-restore.json"), {
    restored,
    extraPrefsRemoved: extra,
    notificationsCleared: cleared,
    allMatch: restored.every((file) => file.match),
    at: new Date().toISOString(),
  });
  if (!restored.every((file) => file.match)) {
    throw new Error("Device preference restore failed byte verification");
  }
  console.log(
    `Restored ${restored.length} prefs files (byte-verified); removed extras: ${extra.length}.`,
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "backup") await commandBackup();
  else if (command === "setup") await commandSetup();
  else if (command === "click") await commandClick(args[0]);
  else if (command === "release") await commandRelease();
  else if (command === "status") await commandStatus();
  else if (command === "restore") await commandRestore();
  else
    throw new Error(
      "Usage: node scripts/mobile-remote-p8-owner-boundary-android-driver.mjs <backup|setup|click <label>|release|status|restore>",
    );
} catch (error) {
  console.error(error instanceof Error ? error.stack : "Android driver failed");
  process.exitCode = 1;
}
