#!/usr/bin/env node
/* eslint-disable max-lines -- M3 场景共享同一套设备/provider/Gateway 状态，拆文件会引入跨场景时序耦合。 */
/**
 * M3-T5：真实 Gateway + Android WebView 的发布升级/回滚与安全刷新验收。
 *
 * 前置：
 *   1. 共享 Gateway 可用；`scripts/mobile-m3-t5/prepare-release-fixtures.mjs` 已生成 release 夹具。
 *   2. `pnpm build:mobile-web` 已生成 A 制品（夹具 a 为其拷贝）。
 *   3. `scripts/mobile-m2-t6/desktop-provider-harness.mjs` 已启动，提供 /root、/release-status、
 *      /workspaces 控制端点。
 *   4. Debug APK 已安装；设备允许 adb forward 与 WebView 调试。
 *
 * 运行：
 *   node --env-file=.env.gateway.local scripts/mobile-m3-t5/run-e2e.mjs
 *
 * 不打印凭证；输出 JSON 报告。
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
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
const fixturesDir = process.env.ZODY_E2E_M3_FIXTURES || "/tmp/zody-m3-releases";
const deviceCredential = process.env.ZCODE_GATEWAY_DEVICE_CREDENTIAL;
const skip = new Set(
  (process.env.ZODY_E2E_SKIP || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const appId = "io.github.zclaudia.zody.mobile";
const releaseMetaSelector = 'meta[name="zody-mobile-ui-release"]';

const shellPredicate = (target) =>
  target.type === "page" && target.url.includes("appassets.androidplatform.net");
const remotePredicate = (target) =>
  target.type === "page" && target.url.includes("remote.zody.local");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
const adbShell = (command) => adb("shell", command);
async function control(path) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${controlUrl}${path}`, {
        signal: AbortSignal.timeout(20000),
      });
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError ?? new Error(`control request failed: ${path}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const report = { device: serial, fixturesDir, scenarios: {}, evidence: {} };
function record(name, status, details = {}) {
  report.scenarios[name] = { status, ...details };
  console.log(`[m3-t5] ${name}: ${status}`);
}

async function grantNotificationPermission() {
  try {
    adbShell(`pm grant ${appId} android.permission.POST_NOTIFICATIONS`);
  } catch {
    // 旧系统没有该运行时权限；忽略。
  }
}

async function dismissPermissionDialogIfPresent() {
  try {
    const top = adbShell("dumpsys activity activities | grep -m1 topResumedActivity");
    if (top.includes("GrantPermissionsActivity")) {
      await dismissPermissionDialog();
    }
  } catch {
    // 无法读取 Activity 栈时继续；非权限弹窗场景不应被 BACK 干扰。
  }
}

async function keepScreenAwake() {
  try {
    adbShell("svc power stayon true");
    adbShell("settings put system screen_off_timeout 2147483647");
  } catch {
    // 模拟器不支持 stayon 时仍继续，由 bringAppToForeground 唤醒兜底。
  }
}

async function setupDevtools() {
  await keepScreenAwake();
  try {
    adbShell("input keyevent 224");
  } catch {
    // 部分镜像不支持 WAKEUP 键；后面的 am start 仍可启动。
  }
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  let pid = "";
  const pidDeadline = Date.now() + 10000;
  while (Date.now() < pidDeadline) {
    try {
      pid = adbShell(`pidof ${appId}`).trim();
    } catch {
      pid = "";
    }
    if (pid) break;
    await sleep(300);
  }
  assert(pid, "app process is not running");
  const deadline = Date.now() + 20000;
  let sockets = "";
  while (Date.now() < deadline) {
    sockets = adbShell("cat /proc/net/unix");
    if (sockets.includes(`@webview_devtools_remote_${pid}`)) break;
    await sleep(250);
  }
  assert(
    sockets.includes(`@webview_devtools_remote_${pid}`),
    `WebView devtools socket missing for pid ${pid}`,
  );
  try {
    adb("forward", "--remove", `tcp:${process.env.ZODY_E2E_DEVTOOLS_PORT || 9222}`);
  } catch {
    // no previous forward
  }
  adb(
    "forward",
    `tcp:${process.env.ZODY_E2E_DEVTOOLS_PORT || 9222}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );
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
  try {
    adbShell("input keyevent 224");
    adbShell("wm dismiss-keyguard");
  } catch {
    // keyguard 已解锁时 dismiss-keyguard 可能失败。
  }
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  await sleep(1200);
}

async function shellPage({ bringToForeground = true } = {}) {
  // returnShell 后既有 Shell target 仍可复用；再 am start 可能因 MainActivity 恢复 Remote 而换页。
  if (bringToForeground) await bringAppToForeground();
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
  // 原因：Activity 重建或 reload 后 CDP 目标列表可能同时保留旧文档，旧 sessionId 已失效；
  // 固定拿第一次找到的 target 会得到 stale-session 且永远等不到 Shell，导致后续场景级联超时。
  // 每轮重新选择当前可见 target 读取会话并重试，直到 Shell 出现。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const targets = (await listTargets())
      .filter(remotePredicate)
      .sort((left, right) => Number(isVisibleTarget(right)) - Number(isVisibleTarget(left)));
    if (targets.length === 0) return;
    let page;
    try {
      page = await remotePage();
      const envelope = JSON.parse(
        await page.evaluate("window.ZodyRemoteBridge.getSessionContext()"),
      );
      if (!envelope.ok) throw new Error("session context unavailable");
      await page.evaluate(
        `void window.ZodyRemoteBridge.returnShell('m3-t5-reset', ${JSON.stringify(
          envelope.context.sessionId,
        )}); true`,
        { awaitPromise: false },
      );
    } catch {
      // 导航会中断 evaluate；stale-session 或正在销毁的 target 都进入下一轮重试。
    } finally {
      try {
        page?.close();
      } catch {
        // best-effort
      }
    }
    try {
      await waitForTarget(shellPredicate, 10000, "shell after return");
      return;
    } catch {
      await sleep(500);
    }
  }
  await waitForTarget(shellPredicate, 30000, "shell after return");
}

/**
 * 关闭页面层的阻塞 dialog（例如未确认通知失败后的 “Could not open notification”）。
 *
 * 原因：失败的通知点击按设计保留 pending、不 ack；页面会再次弹出 dialog。它会覆盖
 * 后续场景的点击目标（elementFromPoint 命中 DIALOG），导致设置入口等操作全部失效。
 * 这里只关闭展示层，不调用 notificationAcknowledge，保留原生 pending。
 */
async function dismissBlockingWebDialogs(page) {
  return page
    .evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      if (!dialog) return false;
      const close = [...dialog.querySelectorAll('button')].find(
        (button) => button.innerText.trim() === 'Close',
      );
      if (close) close.click();
      else dialog.close();
      return true;
    })()`)
    .catch(() => false);
}

/**
 * 场景之间显式复位。
 *
 * 原因：M3 场景会按 HOME、打开系统文件选择器/通知权限弹窗，并把 provider 根目录切到 B。
 * 任一场景失败后若直接进入下一场景，后续场景会在后台文档或旧 session 上等待 veto/blocker，
 * 表现为级联超时（完整运行已复现）。这里统一恢复前台、关闭系统栏与页面 dialog、
 * 恢复 A 与 release 状态，并回到 Shell；调用方随后再按各自需要打开 StartPage / Root。
 */
async function resetScenarioState() {
  try {
    adbShell("input keyevent 224");
    adbShell("wm dismiss-keyguard");
    adbShell("cmd statusbar collapse");
    adbShell(`am start -W -n ${appId}/.MainActivity`);
  } catch {
    // 模拟器可能不支持某个开关；继续复位 provider 和 Shell。
  }
  const current = await remotePage().catch(() => null);
  if (current) {
    await dismissBlockingWebDialogs(current);
    current.close();
  }
  await control("/workspaces?value=none").catch(() => {});
  await setRoot("a").catch(() => {});
  await control("/release-status?value=0").catch(() => {});
  await returnShellIfRemote().catch(async () => {
    await bringAppToForeground().catch(() => {});
    await returnShellIfRemote().catch(() => {});
  });
}

async function ensureConfigured() {
  const page = await shellPage({ bringToForeground: false });
  const read = JSON.parse(await page.evaluate("window.ZodyShellBridge.readConfig()"));
  if (read.config) {
    page.close();
    return { existed: true, configRevision: read.config.configRevision };
  }
  assert(deviceCredential, "ZCODE_GATEWAY_DEVICE_CREDENTIAL is required for pairing");
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

async function pickerState(page) {
  return page.evaluate(`(() => ({
    items: [...document.querySelectorAll('[data-mobile-remote-backend-item]')].map((el) => ({
      id: el.getAttribute('data-mobile-remote-backend-item'),
      supported: el.getAttribute('data-supported'),
      disabled: el.disabled,
    })),
    connect: [...document.querySelectorAll('footer button')].map((button) => ({
      label: button.innerText,
      disabled: button.disabled,
    })),
    bodyText: document.body.innerText.slice(0, 400),
  }))()`);
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

async function remoteContext(page) {
  const envelope = JSON.parse(await page.evaluate("window.ZodyRemoteBridge.getSessionContext()"));
  assert(envelope.ok, `getSessionContext failed: ${JSON.stringify(envelope)}`);
  return envelope.context;
}

async function openRemoteStartPage() {
  await control("/workspaces?value=none");
  await returnShellIfRemote();
  const shell = await shellPage({ bringToForeground: false });
  await waitPicker(shell);
  const selected = (await pickerState(shell)).items.find(
    (item) => item.supported === "true" && !item.disabled,
  );
  assert(selected, "no selectable desktop");
  const page = await clickBackend(shell, selected.id);
  shell.close();
  await page.waitFor(
    "document.body.innerText.includes('Connected to the gateway') || " +
      "document.body.innerText.includes('No project is open')",
    45000,
    "remote start page",
  );
  return page;
}

function stateExpression() {
  return `(() => ({
    meta: document.querySelector(${JSON.stringify(releaseMetaSelector)})?.content || null,
    href: location.href,
    visible: document.visibilityState,
    online: navigator.onLine,
    notice: document.querySelector('[data-mobile-release-notice]')?.innerText?.slice(0, 500) || '',
    noticeHidden: document.querySelector('[data-mobile-release-notice]')?.hidden ?? null,
    blockers: [...document.querySelectorAll('[data-mobile-release-blocked-reason]')].map((el) => el.getAttribute('data-mobile-release-blocked-reason')),
    veto: document.querySelector('[data-mobile-release-native-veto]')?.getAttribute('data-mobile-release-native-veto') || null,
    reloadButton: Boolean(document.querySelector('[data-mobile-release-reload]')),
    count: Number(sessionStorage.getItem('m3:navigations') || '0'),
    throttle: sessionStorage.getItem('zody.mobile-ui.release.last-auto-reload-at'),
  }))()`;
}

async function readState(page) {
  return page.evaluate(stateExpression());
}

async function installReloadCounter(page, { reset = true } = {}) {
  await page.evaluate(`(() => {
    if (${reset ? "true" : "false"}) sessionStorage.setItem('m3:navigations', '0');
    if (window.__m3ReloadCounterInstalled) return true;
    window.__m3ReloadCounterInstalled = true;
    addEventListener('beforeunload', () => {
      sessionStorage.setItem('m3:navigations', String(Number(sessionStorage.getItem('m3:navigations') || '0') + 1));
    });
    return true;
  })()`);
}

async function triggerReleaseCheck(page) {
  await page.evaluate("window.dispatchEvent(new Event('online')); true");
}

async function waitForRemoteMeta(expectedReleaseId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const target = (await listTargets()).find(remotePredicate);
    if (target) {
      try {
        const page = new CdpPage(target);
        await page.ready;
        await page.waitFor("document.body !== null", 5000);
        const state = await readState(page);
        last = state;
        if (state.meta === expectedReleaseId) return { page, state, targetId: target.id };
        page.close();
      } catch {
        // reload 期间 target 短暂不可用。
      }
    }
    await sleep(300);
  }
  throw new Error(`timed out waiting for release ${expectedReleaseId}: ${JSON.stringify(last)}`);
}

async function waitForState(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const target = (await listTargets()).find(remotePredicate);
    if (target) {
      try {
        const page = new CdpPage(target);
        await page.ready;
        await page.waitFor("document.body !== null", 5000);
        const state = await readState(page);
        last = state;
        if (predicate(state)) return { page, state };
        page.close();
      } catch {
        // reload 期间 target 短暂不可用。
      }
    }
    await sleep(300);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

async function clickReload(page) {
  return page.evaluate(
    `(() => { const button = document.querySelector('[data-mobile-release-reload]'); if (!button) return false; button.click(); return true; })()`,
  );
}

async function setRoot(name) {
  assert(name === "a" || name === "b" || name === "incompatible" || name === "invalid", name);
  return control(`/root?value=${encodeURIComponent(`${fixturesDir}/${name}`)}`);
}

async function providerStatus() {
  return control("/status");
}

async function waitForBlockReason(reason, timeoutMs = 15000) {
  return waitForState(
    (state) => state.blockers.includes(reason),
    `block reason ${reason}`,
    timeoutMs,
  );
}

async function waitForVeto(veto, timeoutMs = 15000) {
  return waitForState((state) => state.veto === veto, `native veto ${veto}`, timeoutMs);
}

async function clearThrottle(page) {
  await page.evaluate(
    "sessionStorage.removeItem('zody.mobile-ui.release.last-auto-reload-at'); true",
  );
}

async function mouseClick(page, selector) {
  const rect = await page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height }; })()`,
  );
  assert(rect && rect.width > 0 && rect.height > 0, `element not visible: ${selector}`);
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
}

async function clickPoint(page, point) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function skipOnboarding(page) {
  for (let step = 0; step < 6; step += 1) {
    const action = await page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const skip = buttons.find((b) => b.innerText.trim() === 'Skip');
      if (skip) { skip.click(); return 'skip'; }
      const getStarted = buttons.find((b) => b.innerText.trim() === 'Get started');
      if (getStarted) { getStarted.click(); return 'get-started'; }
      const dialogClose = buttons.find((b) => b.getAttribute('data-slot') === 'dialog-close');
      if (dialogClose) { dialogClose.click(); return 'dialog-close'; }
      return 'none';
    })()`);
    if (action === "none") return step;
    await sleep(1200);
  }
  return 6;
}

async function openRootWithDisconnectedWorkspace() {
  await control("/workspaces?value=disconnected");
  await returnShellIfRemote();
  const shell = await shellPage({ bringToForeground: false });
  await waitPicker(shell);
  const selected = (await pickerState(shell)).items.find(
    (item) => item.supported === "true" && !item.disabled,
  );
  assert(selected, "no selectable desktop");
  let page = await clickBackend(shell, selected.id);
  shell.close();
  // 旧 session 的 Remote target 可能短暂残留；按内容选中真正挂载 Root 的页面。
  const rootPage = await connectWithExpression(
    remotePredicate,
    "document.body.innerText.includes('What do you do?') || " +
      "document.body.innerText.includes('Command palette') || " +
      "document.body.innerText.includes('Zody remote control')",
    "disconnected root page",
    45000,
  );
  page.close();
  page = rootPage;
  await sleep(1200);
  await skipOnboarding(page);
  if (await page.evaluate("document.body.innerText.includes('What do you do?')")) {
    const retryPage = await connectWithExpression(
      remotePredicate,
      "document.body.innerText.includes('What do you do?')",
      "onboarding retry page",
      15000,
    ).catch(() => null);
    if (retryPage) {
      page.close();
      page = retryPage;
      await skipOnboarding(page);
    }
  }
  await page.waitFor(
    `document.querySelector('button[aria-label="Settings"]') !== null || ` +
      `document.querySelector('[data-testid="settings-back-button"]') !== null || ` +
      `document.body.innerText.includes('Command palette')`,
    30000,
    "root home",
  );
  // 上一轮可能停在设置页；回到 workspace 首页后再登记 guard。
  const back = await page.evaluate(
    `(() => { const b=document.querySelector('[data-testid="settings-back-button"]'); if(!b) return false; b.click(); return true; })()`,
  );
  if (back) await sleep(1000);
  return page;
}

/** 设置页导航超时时附带只读 DOM 快照，便于区分“没打开设置”与“打开了其他视图”。 */
async function settingsDiagnostics(page) {
  return page.evaluate(`(() => ({
    href: location.href,
    visibility: document.visibilityState,
    mobileSettings: document.querySelector('[data-mobile-settings]')?.getAttribute('data-mobile-settings') ?? null,
    mobileSettingsView: document.querySelector('[data-mobile-settings-view]')?.getAttribute('data-mobile-settings-view') ?? null,
    settingsIndex: Boolean(document.querySelector('[data-mobile-settings-index="true"]')),
    bodyText: document.body.innerText.slice(0, 400),
    buttons: [...document.querySelectorAll('button')].slice(0, 30).map((button) => ({
      label: button.getAttribute('aria-label'),
      text: button.innerText.trim().slice(0, 40),
      testid: button.getAttribute('data-testid'),
    })),
    menuItems: [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.innerText.trim()),
  }))()`);
}

async function openConnectionSettings(page) {
  // 未确认通知失败留下的 dialog 会覆盖设置入口；先只关闭展示层，不 ack pending。
  await dismissBlockingWebDialogs(page);
  // 原因：根页可能同时存在移动端 TaskHome 的设置下拉触发器与桌面侧栏的设置按钮。
  // 旧实现只取第一个匹配项，完整运行时可能点到直接跳转设置页的侧栏按钮，随后一直等不到
  // [role=menuitem]（单独运行不触发，已在修复前复现）。这里优先 TaskHome 内的触发器，
  // 并兼容“触发器直接打开设置页”的路径。
  const triggers = await page.evaluate(`(() => [
    ...document.querySelectorAll('button[aria-label="Settings"]'),
  ]
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        preferred: Boolean(el.closest('[data-mobile-remote-page="start"]')),
      };
    })
    .filter((trigger) => trigger.width > 0 && trigger.height > 0)
    .sort((left, right) => Number(right.preferred) - Number(left.preferred)))()`);
  assert(triggers.length > 0, "settings trigger missing");
  const menuReady = `[...document.querySelectorAll('[role="menuitem"]')].some((el) => el.innerText.trim() === 'Settings')`;
  const settingsReady =
    `document.querySelector('[data-mobile-settings="true"]') !== null || ` +
    `document.querySelector('[data-testid="settings-back-button"]') !== null`;
  let settingsOpened = false;
  for (const trigger of triggers) {
    await clickPoint(page, trigger);
    // 该触发器可能直接打开设置页，也可能先展开下拉菜单；两种都接受。
    if (
      await page
        .waitFor(settingsReady, 1500)
        .then(() => true)
        .catch(() => false)
    ) {
      settingsOpened = true;
      break;
    }
    if (
      !(await page
        .waitFor(menuReady, 3000)
        .then(() => true)
        .catch(() => false))
    ) {
      continue;
    }
    // Radix 菜单项通过 click 触发 onSelect；单独运行已验证该路径可打开设置页。
    const clicked = await page.evaluate(`(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.innerText.trim() === 'Settings');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!clicked) continue;
    settingsOpened = await page
      .waitFor(settingsReady, 8000)
      .then(() => true)
      .catch(() => false);
    if (settingsOpened) break;
    // 该下拉项没有打开设置（例如 disconnected Root 下 onOpenAppSettings 不产生页面），
    // 关闭菜单后尝试下一个触发器（桌面侧栏按钮会直接进入设置页）。
    await clickPoint(page, { x: 5, y: 5 });
    await sleep(300);
  }
  if (!settingsOpened) {
    const diagnostics = await settingsDiagnostics(page).catch(() => null);
    throw new Error(
      `settings page did not open from any trigger; diagnostics=${JSON.stringify(diagnostics)}`,
    );
  }
  // 设置 tab 可能是桌面持久状态：若上次停在某个分区，打开设置会直接进入 section 而不是
  // index。先显式回到 mobile settings index，再选择 Connection；已经处于连接分区时直接复用。
  const alreadyInConnectionSection = await page.evaluate(
    `document.querySelector('[data-mobile-connection-settings-section]') !== null`,
  );
  if (!alreadyInConnectionSection) {
    const atIndex = await page.evaluate(
      `document.querySelector('[data-mobile-settings-index="true"]') !== null`,
    );
    if (!atIndex) {
      const backed = await page.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(
          (el) => el.getAttribute('aria-label') === 'Back to workspace',
        );
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (backed) {
        await page.waitFor(
          `document.querySelector('[data-mobile-settings-index="true"]') !== null`,
          10000,
          "mobile settings index",
        );
      }
    }
    await page.waitFor(
      `document.querySelector('[data-testid="mobile-settings-section-connection"]') !== null`,
      15000,
      "mobile settings nav",
    );
    await mouseClick(page, '[data-testid="mobile-settings-section-connection"]');
  }
  await page.waitFor(
    `document.querySelector('[data-mobile-connection-settings-section]') !== null`,
    15000,
    "connection settings section",
  );
}

async function typeIntoGatewayAddress(page) {
  return page.evaluate(`(() => {
    const input = document.querySelector('[data-mobile-connection-settings-section] input[placeholder="https://gateway.example.com"]');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, input.value + 'x');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
}

async function cancelConnectionSettings(page) {
  return page.evaluate(`(() => {
    const section = document.querySelector('[data-mobile-connection-settings-section]');
    if (!section) return false;
    const button = [...section.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cancel');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

// ---------------------------------------------------------------------------
// 场景实现
// ---------------------------------------------------------------------------

async function runReleaseUpgradeThrottleRollback() {
  await resetScenarioState();
  await setRoot("a");
  await control("/release-status?value=0");
  let page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const baseline = await readState(page);
  assert(baseline.meta, "baseline HTML release meta missing");
  const identityBefore = await remoteContext(page);
  const providerBefore = await providerStatus();

  await setRoot("b");
  await triggerReleaseCheck(page);
  const startedAt = Date.now();
  const samples = [];
  for (const offset of [500, 2000, 4000]) {
    const elapsed = Date.now() - startedAt;
    if (offset > elapsed) await sleep(offset - elapsed);
    const state = await readState(page);
    samples.push({
      offset,
      meta: state.meta,
      count: state.count,
      notice: state.notice.slice(0, 80),
    });
  }
  assert(
    samples.every((sample) => sample.meta === baseline.meta && sample.count === 0),
    `page reloaded before 5s confirmation: ${JSON.stringify(samples)}`,
  );

  // fixtures.json 由 prepare 脚本生成；直接读取以取得 B 的 releaseId。
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const reloadedToB = await waitForRemoteMeta(fixtures.b.releaseId, 20000);
  page = reloadedToB.page;
  // reload 后 window 级标记和 listener 随旧文档销毁；在 B 文档重新登记计数器，继续统计回滚刷新。
  await installReloadCounter(page, { reset: false });
  const upgradedState = await readState(page);
  assert(upgradedState.count === 1, `expected exactly one reload, got ${upgradedState.count}`);
  await sleep(2500);
  const providerAfter = await providerStatus();
  assert(
    providerAfter.backendId === providerBefore.backendId,
    "backend identity changed during upgrade",
  );
  assert(
    providerAfter.activeChannelCount <= 2,
    `channel leak after reload: ${providerAfter.activeChannelCount}`,
  );

  // 回滚在自动刷新冷却内：自动路径必须被一分钟限频挡住，手动安全刷新才放行。
  await setRoot("a");
  await triggerReleaseCheck(page);
  const throttled = await waitForState(
    (state) =>
      state.meta === fixtures.b.releaseId &&
      state.reloadButton &&
      /New version ready/u.test(state.notice),
    "throttled rollback ready",
    20000,
  );
  const beforeManual = await readState(throttled.page);
  assert(beforeManual.meta === fixtures.b.releaseId, "auto-reload ignored one-minute throttle");
  assert(beforeManual.count === 1, `throttled auto reload changed document: ${beforeManual.count}`);
  const clicked = await clickReload(throttled.page);
  assert(clicked, "safe reload button missing after throttle");
  const rolledBack = await waitForRemoteMeta(fixtures.a.releaseId, 20000);
  await sleep(65000);
  const afterMinute = await readState(rolledBack.page);
  assert(afterMinute.meta === fixtures.a.releaseId, "document changed after rollback");
  assert(afterMinute.count === 2, `reload loop detected: ${afterMinute.count}`);

  record("release-upgrade-throttle-rollback", "pass", {
    baselineReleaseId: baseline.meta,
    releaseB: fixtures.b.releaseId,
    confirmationSamples: samples,
    upgradedCount: upgradedState.count,
    manualRollbackCount: afterMinute.count,
    backendIdStable: providerAfter.backendId === providerBefore.backendId,
    activeChannelCount: providerAfter.activeChannelCount,
    identityBefore: { sessionId: identityBefore.sessionId, backendId: identityBefore.backendId },
    noLoopAfter65s: true,
  });
  rolledBack.page.close();
}

async function runFailureKeepsDocument() {
  await resetScenarioState();
  await setRoot("a");
  await control("/release-status?value=0");
  const page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const baseline = await readState(page);
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const results = {};
  for (const status of [429, 500]) {
    await setRoot("b");
    await control(`/release-status?value=${status}`);
    const fetchesBefore = (await providerStatus()).releaseFetchCount;
    await triggerReleaseCheck(page);
    await sleep(2500);
    const state = await readState(page);
    const fetchesAfter = (await providerStatus()).releaseFetchCount;
    assert(state.meta === baseline.meta, `HTTP ${status} replaced the document`);
    assert(state.count === 0, `HTTP ${status} reloaded the document`);
    assert(fetchesAfter > fetchesBefore, `HTTP ${status} did not reach release endpoint`);
    results[`http${status}`] = {
      meta: state.meta,
      count: state.count,
      fetchDelta: fetchesAfter - fetchesBefore,
    };
  }
  await control("/release-status?value=0");
  await setRoot("invalid");
  await triggerReleaseCheck(page);
  await sleep(2500);
  const invalidState = await readState(page);
  assert(invalidState.meta === baseline.meta, "invalid manifest replaced the document");
  assert(invalidState.count === 0, "invalid manifest reloaded the document");
  results.invalidManifest = { meta: invalidState.meta, count: invalidState.count };

  // 旧 hash 必须 404 且空 body，不能把 B 的当前文件冒充 A 的旧资源。
  await setRoot("b");
  // 只改 CSS 字节生成 B；必须用 CSS 的旧内容哈希验证 404，JS 入口哈希在两版之间不变。
  const oldAssetPath = await page.evaluate(
    `(() => { const link=[...document.querySelectorAll('link[rel="stylesheet"]')].map((el)=>el.getAttribute('href')).find((v)=>v && v.includes('/assets/remote/assets/')); return link || null; })()`,
  );
  assert(oldAssetPath, "could not find baseline hashed CSS asset");
  const oldHash = await page.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(oldAssetPath)}, { cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, bodyLength: body.length, hasNewContent: body.includes('m3-t5 release B') };
  })()`);
  // 旧 hash 命中手机侧 immutable 缓存时返回旧内容是允许的；关键是绝不能混入 B 的新内容。
  assert(
    oldHash.status === 404 || oldHash.status === 200,
    `unexpected old hash status ${oldHash.status}`,
  );
  assert(!oldHash.hasNewContent, "old hash served new release content");
  const unknownHash = await page.evaluate(`(async () => {
    const response = await fetch('/assets/remote/assets/m3-t5-never-built.css', { cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, bodyLength: body.length };
  })()`);
  assert(unknownHash.status === 404, `unknown hash returned ${unknownHash.status}`);
  assert(unknownHash.bodyLength === 0, `unknown hash body leaked ${unknownHash.bodyLength} bytes`);
  results.oldHash = oldHash;
  results.unknownHash = unknownHash;

  await setRoot("a");
  await triggerReleaseCheck(page);
  await sleep(1500);
  const recovered = await providerStatus();
  record("failure-keeps-document", "pass", {
    baselineReleaseId: baseline.meta,
    ...results,
    recoveredReleaseFetches: recovered.releaseFetchCount,
  });
  page.close();
}

async function runBridgeIncompatible() {
  await resetScenarioState();
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  await setRoot("a");
  await control("/release-status?value=0");
  const page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const baseline = await readState(page);
  await setRoot("incompatible");
  await triggerReleaseCheck(page);
  const incompatible = await waitForState(
    (state) => /Update the Zody app|需要更新 Zody App/u.test(state.notice),
    "incompatible notice",
    20000,
  );
  assert(incompatible.state.meta === baseline.meta, "incompatible manifest reloaded document");
  assert(incompatible.state.count === 0, "incompatible manifest triggered reload");
  assert(!incompatible.state.reloadButton, "incompatible release exposed reload button");
  incompatible.page.close();
  page.close();

  // 冷启动：不支持 bridge 时只提示升级 APK，不建立业务 Channel。
  // 配置已存在，应用可能直接进入 Remote；Remote 的 bootstrap 会停在升级提示页。
  await setRoot("incompatible");
  await dismissPermissionDialogIfPresent();
  await grantNotificationPermission();
  adbShell(`am force-stop ${appId}`);
  await setupDevtools();
  let finalRemote = null;
  let incompatibleBody = "";
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const targets = await listTargets();
    finalRemote = targets.find(remotePredicate) ?? null;
    if (finalRemote) {
      try {
        const remote = await connectWithExpression(
          remotePredicate,
          "typeof window.ZodyRemoteBridge === 'object' && window.ZodyRemoteBridge !== null",
          "incompatible remote",
          5000,
        );
        incompatibleBody = await remote.evaluate("document.body.innerText.slice(0, 500)");
        remote.close();
        if (/App update required|Update the Phone App|需要更新/u.test(incompatibleBody)) break;
      } catch {
        // 页面仍在加载。
      }
    } else if (targets.some(shellPredicate)) {
      break;
    }
    await sleep(500);
  }
  const provider = await providerStatus();
  let shellBody = "";
  if (!finalRemote) {
    const shell = await shellPage({ bringToForeground: false });
    await shell.waitFor(
      `document.body.innerText.includes('Choose a desktop') || ` +
        `document.body.innerText.includes('Select a desktop') || ` +
        `document.querySelector('[data-mobile-remote-page="backend-picker"]') !== null`,
      20000,
      "shell picker after incompatible cold start",
    );
    shellBody = await shell.evaluate("document.body.innerText.slice(0, 500)");
    shell.close();
    assert(
      /Choose a desktop|Select a desktop|Choose a computer|Back to settings/u.test(shellBody),
      `incompatible cold start did not stay on Shell: ${shellBody}`,
    );
  } else {
    assert(
      /App update required|Update the Phone App|需要更新/u.test(incompatibleBody),
      `incompatible Remote did not show upgrade prompt: ${incompatibleBody}`,
    );
  }
  assert(
    provider.activeChannelCount === 0,
    `business channel opened: ${provider.activeChannelCount}`,
  );
  record("bridge-incompatible", "pass", {
    baselineReleaseId: baseline.meta,
    incompatibleReleaseId: fixtures.incompatible.releaseId,
    activeChannelCount: provider.activeChannelCount,
    coldStartBody: (incompatibleBody || shellBody).slice(0, 200),
    stayedOnShell: !finalRemote,
  });
  await setRoot("a");
}

async function runBackgroundNoRefresh() {
  let page = null;
  try {
    // 场景开始显式复位：确保应用在前台、回到 Shell，且 workspace/release 不继承上一场景残留。
    await resetScenarioState();
    page = await openRemoteStartPage();
    await installReloadCounter(page, { reset: true });
    await clearThrottle(page);
    const baseline = await readState(page);
    adbShell("input keyevent 3");
    // 等 HOME 引发的在途检查结束，再取基线；后台稳定后不得继续轮询。
    await sleep(2500);
    const fetchesBefore = (await providerStatus()).releaseFetchCount;
    await setRoot("b");
    await triggerReleaseCheck(page).catch(() => {});
    await sleep(8000);
    const backgroundState = await readState(page).catch(() => null);
    const fetchesAfter = (await providerStatus()).releaseFetchCount;
    assert(!backgroundState || backgroundState.meta === baseline.meta, "background page reloaded");
    assert(!backgroundState || backgroundState.count === 0, "background page reload count changed");
    assert(
      fetchesAfter === fetchesBefore,
      `background page polled release: ${fetchesBefore} -> ${fetchesAfter}`,
    );

    await bringAppToForeground();
    await sleep(1000);
    const foreground = await waitForState(
      (state) => state.visible === "visible" && state.meta !== baseline.meta,
      "foreground release reload",
      25000,
    );
    record("background-no-refresh", "pass", {
      backgroundMeta: backgroundState?.meta ?? baseline.meta,
      backgroundReloads: backgroundState?.count ?? 0,
      backgroundReleaseFetches: fetchesAfter - fetchesBefore,
      foregroundReleaseId: foreground.state.meta,
      foregroundReloads: foreground.state.count,
    });
    await installReloadCounter(foreground.page, { reset: false });
    foreground.page.close();
  } finally {
    // 原因：本场景按 HOME 把应用放到后台；断言失败时若不恢复前台，后续场景会在 hidden
    // 文档上等待 veto/blocker 并级联超时（完整运行已复现）。因此无论成功失败都恢复前台、
    // 复位制品根目录和 release 状态，并等待当前 Remote 文档重新可见。
    try {
      await bringAppToForeground();
    } catch {
      // 恢复前台失败时仍继续复位 provider，避免把失败扩散到后续场景。
    }
    await setRoot("a").catch(() => {});
    await control("/release-status?value=0").catch(() => {});
    const restored = await waitForState(
      (state) => state.visible === "visible" && state.href.includes("remote.zody.local"),
      "foreground remote after background scenario",
      15000,
    ).catch(() => null);
    restored?.page.close();
    try {
      page?.close();
    } catch {
      // 页面可能已被 reload 替换。
    }
  }
}

async function restoreToBaselineA() {
  await setRoot("a");
  await control("/release-status?value=0");
  let page = await waitForState(() => true, "remote for restore", 5000).then((r) => r.page);
  await triggerReleaseCheck(page);
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const current = await readState(page);
  if (current.meta === fixtures.a.releaseId) return page;
  await sleep(6000);
  const ready = await readState(page).catch(() => null);
  if (ready?.meta !== fixtures.a.releaseId) {
    const state = await waitForState(
      (s) => s.reloadButton || s.meta === fixtures.a.releaseId,
      "restore reload button",
      15000,
    ).catch(() => null);
    page = state?.page ?? page;
    await clickReload(page).catch(() => {});
    const restored = await waitForRemoteMeta(fixtures.a.releaseId, 15000).catch(() => null);
    if (restored) page = restored.page;
  }
  return page;
}

async function runActiveOverlayGuard() {
  // 不依赖上一场景的页面状态：从 Shell 重新进入 A 的 StartPage。
  await resetScenarioState();
  await setRoot("a");
  await control("/release-status?value=0");
  let page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const baseline = await readState(page);
  const opened = await page.evaluate(
    `(() => { const b = document.querySelector('[data-mobile-remote-open-other-project]'); if (!b) return false; b.click(); return true; })()`,
  );
  assert(opened, "open-other-project button missing");
  await page.waitFor(
    `document.querySelector('[data-mobile-workspace-picker]') !== null`,
    10000,
    "workspace picker",
  );
  await setRoot("b");
  await triggerReleaseCheck(page);
  const blocked = await waitForBlockReason("active-overlay", 18000);
  assert(blocked.state.meta === baseline.meta, "active overlay did not block reload");
  assert(blocked.state.count === 0, "active overlay reload count changed");
  const manualBlocked = await clickReload(blocked.page);
  await sleep(2000);
  const afterManualBlocked = await readState(blocked.page);
  assert(manualBlocked, "safe reload button missing while blocked");
  assert(afterManualBlocked.meta === baseline.meta, "manual reload bypassed active overlay");

  const closed = await blocked.page.evaluate(`(() => {
    const picker = document.querySelector('[data-mobile-workspace-picker]');
    if (!picker) return false;
    const button = [...picker.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Cancel');
    if (!button) return false; button.click(); return true;
  })()`);
  assert(closed, "workspace picker cancel button missing");
  await sleep(800);
  const reloaded = await clickReload(blocked.page);
  assert(reloaded, "safe reload button missing after overlay release");
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const upgraded = await waitForRemoteMeta(fixtures.b.releaseId, 20000);
  record("guard-active-overlay", "pass", {
    baselineReleaseId: baseline.meta,
    blockedReasons: blocked.state.blockers,
    manualReloadBlocked: afterManualBlocked.meta === baseline.meta,
    reloadAfterRelease: upgraded.state.meta,
  });
  upgraded.page.close();
  await restoreToBaselineA();
}

async function runUnsavedSettingsGuard() {
  // 先让服务端 release 与即将加载的文档一致，避免 onboarding 期间被自动刷新打断。
  // 本场景的 openRootWithDisconnectedWorkspace 已显式设置 workspaces 并回 Shell，
  // 额外的 resetScenarioState 会多一次导航，反而改变 Root 的设置页入口行为。
  await setRoot("a");
  await control("/release-status?value=0");
  const page = await openRootWithDisconnectedWorkspace();
  await installReloadCounter(page, { reset: true });
  const baseline = await readState(page);
  await openConnectionSettings(page);
  const typed = await typeIntoGatewayAddress(page);
  assert(typed, "gateway address input missing");
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const nextRelease = baseline.meta === fixtures.a.releaseId ? "b" : "a";
  await setRoot(nextRelease);
  await triggerReleaseCheck(page);
  const blocked = await waitForBlockReason("unsaved-settings", 18000);
  assert(blocked.state.meta === baseline.meta, "unsaved settings did not block reload");
  assert(blocked.state.count === 0, "unsaved settings reload count changed");
  const manualBlocked = await clickReload(blocked.page);
  await sleep(2000);
  const afterManualBlocked = await readState(blocked.page);
  assert(manualBlocked, "safe reload button missing with unsaved settings");
  assert(afterManualBlocked.meta === baseline.meta, "manual reload bypassed unsaved settings");
  const cancelled = await cancelConnectionSettings(blocked.page);
  assert(cancelled, "connection settings cancel button missing");
  await sleep(800);
  const reloaded = await clickReload(blocked.page);
  assert(reloaded, "safe reload button missing after settings cancel");
  const expected = nextRelease === "a" ? fixtures.a.releaseId : fixtures.b.releaseId;
  const after = await waitForRemoteMeta(expected, 20000);
  record("guard-unsaved-settings", "pass", {
    baselineReleaseId: baseline.meta,
    blockedReasons: blocked.state.blockers,
    manualReloadBlocked: afterManualBlocked.meta === baseline.meta,
    reloadAfterCancel: after.state.meta,
  });
  after.page.close();
  await control("/workspaces?value=none");
  await returnShellIfRemote();
}

async function runNativeBusyGuards() {
  await resetScenarioState();
  await setRoot("a");
  await control("/release-status?value=0");
  let page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const context = await remoteContext(page);
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const results = {};

  // 1) 系统文件选择：注入 input 触发真实 WebChromeClient 选择器，取消后必须解除 busy。
  const injected = await page.evaluate(`(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('data-m3-file-input', 'true');
    document.body.append(input);
    input.click();
    return true;
  })()`);
  assert(injected, "failed to trigger file chooser");
  await sleep(1200);
  results.fileChooserBusy = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(context.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(
    results.fileChooserBusy.error?.code === "native-busy",
    "file chooser did not make native busy",
  );
  await setRoot("b");
  await triggerReleaseCheck(page);
  const chooserVeto = await waitForVeto("native-busy", 18000);
  assert(chooserVeto.state.meta === fixtures.a.releaseId, "file chooser did not block reload");
  adbShell("input keyevent 4");
  await sleep(1200);
  results.fileChooserReleased = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(context.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(results.fileChooserReleased.ok, "file chooser cancel did not release native busy");
  await clickReload(chooserVeto.page);
  const upgraded = await waitForRemoteMeta(fixtures.b.releaseId, 20000);
  page = upgraded.page;

  // 2) 未完成保存会话：begin 后必须 native-busy，abort 后 ready。
  const sessionAfter = await remoteContext(page);
  const saveBegin = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.saveFileBegin(${JSON.stringify(sessionAfter.sessionId)}, 'm3-busy.txt', 'text/plain')`,
    ),
  );
  assert(saveBegin.ok, `saveFileBegin failed: ${JSON.stringify(saveBegin)}`);
  results.saveSessionBusy = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(sessionAfter.sessionId)}, ${JSON.stringify(fixtures.a.releaseId)})`,
    ),
  );
  assert(results.saveSessionBusy.error?.code === "native-busy", "open save session did not veto");
  await setRoot("a");
  await triggerReleaseCheck(page);
  const saveVeto = await waitForVeto("native-busy", 18000);
  assert(saveVeto.state.meta === fixtures.b.releaseId, "save session did not block reload");
  const aborted = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.saveFileAbort(${JSON.stringify(sessionAfter.sessionId)}, ${JSON.stringify(saveBegin.token)})`,
    ),
  );
  assert(aborted.ok, `saveFileAbort failed: ${JSON.stringify(aborted)}`);
  await sleep(500);
  await clickReload(saveVeto.page);
  const rolledBack = await waitForRemoteMeta(fixtures.a.releaseId, 20000);
  page = rolledBack.page;

  // 3) 完成保存会话：finish 后回 ready，不留下永久 busy。
  const finalContext = await remoteContext(page);
  const begin = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.saveFileBegin(${JSON.stringify(finalContext.sessionId)}, 'm3-complete.txt', 'text/plain')`,
    ),
  );
  assert(begin.ok, "saveFileBegin (complete) failed");
  const appended = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.saveFileAppend(${JSON.stringify(finalContext.sessionId)}, ${JSON.stringify(begin.token)}, ${JSON.stringify(Buffer.from("m3-complete").toString("base64"))})`,
    ),
  );
  assert(appended.ok, `saveFileAppend failed: ${JSON.stringify(appended)}`);
  const finished = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.saveFileFinish(${JSON.stringify(finalContext.sessionId)}, ${JSON.stringify(begin.token)})`,
    ),
  );
  assert(finished.ok, `saveFileFinish failed: ${JSON.stringify(finished)}`);
  results.afterSaveComplete = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(finalContext.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(results.afterSaveComplete.ok, "completed save session left native busy");

  // 4) stale session：旧 session 必须 stale-session，不得永久 busy。
  results.staleSession = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload('stale-m3-session', ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(results.staleSession.error?.code === "stale-session", "stale session not rejected");

  record("native-busy-guards", "pass", {
    fileChooserBusy: results.fileChooserBusy,
    fileChooserReleased: results.fileChooserReleased,
    saveSessionBusy: results.saveSessionBusy,
    afterSaveComplete: results.afterSaveComplete,
    staleSession: results.staleSession,
    reloadAfterRelease: upgraded.state.meta,
    rollbackAfterAbort: rolledBack.state.meta,
  });
  page.close();
}

async function dismissPermissionDialog() {
  adbShell("input keyevent 4");
  await sleep(900);
  // Android 14 的权限对话框不一定响应 BACK；仍存在时按文本定位 “不允许/Don't allow”。
  let xml = "";
  try {
    adbShell("uiautomator dump /sdcard/m3-window.xml >/dev/null 2>&1");
    xml = adbShell("cat /sdcard/m3-window.xml");
  } catch {
    return;
  }
  const match =
    xml.match(
      /text="(?:Don[’']t allow|Deny|不允许|拒绝)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u,
    ) ??
    xml.match(
      /resource-id="com\.android\.permissioncontroller:id\/permission_deny_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u,
    );
  if (!match) return;
  const x = Math.round((Number(match[1]) + Number(match[3])) / 2);
  const y = Math.round((Number(match[2]) + Number(match[4])) / 2);
  adbShell(`input tap ${x} ${y}`);
  await sleep(800);
}

async function ensureNotificationPermissionRequestable() {
  try {
    adbShell(`pm revoke ${appId} android.permission.POST_NOTIFICATIONS`);
  } catch {
    // 权限从未授予时 revoke 会失败；当前状态仍是未授权。
  }
  // 先清掉可能遗留的系统权限弹窗，再冷启动；MainActivity.onCreate 会重新请求通知权限。
  try {
    adbShell("input keyevent 4");
  } catch {
    // no dialog
  }
  adbShell(`am force-stop ${appId}`);
  await setupDevtools();
}

async function runNotificationPermissionVeto() {
  await resetScenarioState();
  await ensureNotificationPermissionRequestable();
  const page = await openRemoteStartPage();
  await installReloadCounter(page, { reset: true });
  const context = await remoteContext(page);
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  // MainActivity.onCreate 在权限被撤销后会弹出真实系统通知权限对话框；它属于 native busy 来源。
  const topActivity = adbShell("dumpsys activity activities | grep -m1 topResumedActivity");
  assert(
    topActivity.includes("GrantPermissionsActivity"),
    `notification permission dialog not visible: ${topActivity}`,
  );
  const busy = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(context.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(
    busy.error?.code === "native-busy",
    `permission dialog did not veto: ${JSON.stringify(busy)}`,
  );
  await setRoot("b");
  await triggerReleaseCheck(page);
  const vetoed = await waitForVeto("native-busy", 18000);
  await dismissPermissionDialog();
  const released = JSON.parse(
    await page.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(context.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  assert(released.ok, `permission dismissal left native busy: ${JSON.stringify(released)}`);
  await clickReload(vetoed.page);
  const upgraded = await waitForRemoteMeta(fixtures.b.releaseId, 20000);
  record("native-notification-permission-veto", "pass", {
    topActivity,
    busy,
    vetoNotice: vetoed.state.veto,
    released,
    reloadedTo: upgraded.state.meta,
  });
  upgraded.page.close();
  await restoreToBaselineA();
}

async function runActivityRecreateNotPermanentlyBusy() {
  // 上一场景可能留下未授权通知权限；Activity 重建会再次触发系统弹窗，先授权以隔离 busy 来源。
  await resetScenarioState();
  await dismissPermissionDialogIfPresent();
  await grantNotificationPermission();
  await setRoot("a");
  await control("/release-status?value=0");
  const page = await openRemoteStartPage();
  const context = await remoteContext(page);
  const firstTargetId = (await listTargets()).find(remotePredicate)?.id;
  page.close();
  adbShell("settings put system accelerometer_rotation 0");
  adbShell("settings put system user_rotation 1");
  const secondTarget = await waitForTarget(
    (target) => remotePredicate(target) && target.id !== firstTargetId && isVisibleTarget(target),
    30000,
    "recreated remote target",
  ).catch(() =>
    waitForTarget(
      (target) => remotePredicate(target) && target.id !== firstTargetId,
      30000,
      "recreated remote target fallback",
    ),
  );
  const second = await CdpPage.connect((target) => target.id === secondTarget.id, 30000);
  await second.waitFor(
    "document.body !== null && typeof window.ZodyRemoteBridge === 'object'",
    30000,
    "remote bridge after recreate",
  );
  const secondContext = await remoteContext(second);
  const fixtures = JSON.parse(await readFile(`${fixturesDir}/fixtures.json`, "utf8"));
  const staleOnOld = JSON.parse(
    await second.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(context.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  const readyOnNew = JSON.parse(
    await second.evaluate(
      `window.ZodyRemoteBridge.prepareReload(${JSON.stringify(secondContext.sessionId)}, ${JSON.stringify(fixtures.b.releaseId)})`,
    ),
  );
  adbShell("settings put system user_rotation 0");
  assert(staleOnOld.error?.code === "stale-session", "old session survived Activity recreate");
  assert(
    readyOnNew.ok,
    `new session permanently busy after recreate: ${JSON.stringify(readyOnNew)}`,
  );
  record("activity-recreate-not-permanently-busy", "pass", {
    sameBackend: context.backendId === secondContext.backendId,
    sessionChanged: context.sessionId !== secondContext.sessionId,
    staleOnOld,
    readyOnNew,
  });
  second.close();
}

const scenarios = [
  ["release-upgrade-throttle-rollback", runReleaseUpgradeThrottleRollback],
  ["failure-keeps-document", runFailureKeepsDocument],
  ["bridge-incompatible", runBridgeIncompatible],
  ["background-no-refresh", runBackgroundNoRefresh],
  ["guard-active-overlay", runActiveOverlayGuard],
  ["guard-unsaved-settings", runUnsavedSettingsGuard],
  ["native-busy-guards", runNativeBusyGuards],
  ["native-notification-permission-veto", runNotificationPermissionVeto],
  ["activity-recreate-not-permanently-busy", runActivityRecreateNotPermanentlyBusy],
];

try {
  await control("/root?value=" + encodeURIComponent(`${fixturesDir}/a`));
  await control("/release-status?value=0");
  await control("/workspaces?value=none");
  await dismissPermissionDialogIfPresent();
  await grantNotificationPermission();
  await setupDevtools();
  await returnShellIfRemote();
  report.pairing = await ensureConfigured();
  for (const [name, run] of scenarios) {
    if (skip.has(name)) {
      record(name, "skipped", { reason: "ZODY_E2E_SKIP" });
      continue;
    }
    try {
      await run();
    } catch (error) {
      record(name, "fail", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}
const failed = Object.values(report.scenarios).some((scenario) => scenario.status === "fail");
await new Promise((resolve) =>
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, resolve),
);
process.exit(report.error || failed ? 1 : 0);
