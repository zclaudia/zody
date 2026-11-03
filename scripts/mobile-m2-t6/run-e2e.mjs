#!/usr/bin/env node
/* eslint-disable max-lines -- M2-T6 场景共享同一套设备/CDP/provider 状态，拆文件会引入跨模块时序耦合。 */
/**
 * M2-T6 Android WebView 端到端驱动。
 *
 * 前置：
 *   1. 本地 Gateway 可用；`pnpm build:mobile-web` 已生成 packages/web/dist-mobile-remote。
 *   2. `scripts/mobile-m2-t6/desktop-provider-harness.mjs` 已在 ZODY_E2E_CONTROL_URL 上运行。
 *   3. Debug APK 已安装并启动；设备允许 `adb forward` 与 WebView 调试（debug 构建）。
 *   4. 通过 `node --env-file=.env.gateway.local` 提供 ZCODE_GATEWAY_DEVICE_CREDENTIAL。
 *
 * 运行：
 *   node --env-file=.env.gateway.local scripts/mobile-m2-t6/run-e2e.mjs
 *
 * 可选环境：
 *   ZODY_E2E_ANDROID_SERIAL=emulator-5582
 *   ZODY_E2E_DEVTOOLS_PORT=9222
 *   ZODY_E2E_CONTROL_URL=http://127.0.0.1:39555
 *   ZODY_E2E_PUBLIC_GATEWAY_URL=http://10.0.2.2:3200
 *   ZODY_E2E_NAMESPACE=zcode
 *   ZODY_E2E_SKIP=device-bootstrap,contracts,reopen,old-desktop,offline,notification,activity-recreate
 *
 * 不打印凭证；所有断言结果以 JSON 输出。
 */
import { execFileSync } from "node:child_process";
import { CdpPage, listTargets, waitForTarget } from "./cdp.mjs";

const serial = process.env.ZODY_E2E_ANDROID_SERIAL || "emulator-5582";
const controlUrl = (process.env.ZODY_E2E_CONTROL_URL || "http://127.0.0.1:39555").replace(
  /\/+$/u,
  "",
);
const publicGatewayUrl = (
  process.env.ZODY_E2E_PUBLIC_GATEWAY_URL || "http://10.0.2.2:3200"
).replace(/\/+$/u, "");
const namespace = process.env.ZODY_E2E_NAMESPACE || "zcode";
const deviceCredential = process.env.ZCODE_GATEWAY_DEVICE_CREDENTIAL;
const skip = new Set(
  (process.env.ZODY_E2E_SKIP || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const appId = "io.github.zclaudia.zody.mobile";
const shellPredicate = (target) =>
  target.type === "page" && target.url.includes("appassets.androidplatform.net");
const remotePredicate = (target) =>
  target.type === "page" && target.url.includes("remote.zody.local");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adb = (...args) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
const adbShell = (command) => adb("shell", command);
const control = (path) =>
  fetch(`${controlUrl}${path}`, { signal: AbortSignal.timeout(20000) }).then((response) =>
    response.json(),
  );

async function waitForProviderOnline(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await control("/status");
      if (last.state === "online") return last;
    } catch {
      // provider 重启期间控制端口可能暂时不可用。
    }
    await sleep(250);
  }
  throw new Error(`provider did not return online: ${JSON.stringify(last)}`);
}

const report = { device: serial, namespace, publicGatewayUrl, scenarios: {} };

function record(name, status, details) {
  report.scenarios[name] = { status, ...details };
  console.log(`[m2-t6] ${name}: ${status}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function setupDevtools() {
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  const pid = adbShell(`pidof ${appId}`);
  assert(pid, "app process is not running");
  // 冷启动时 WebView 可能晚于 Activity 显示才创建调试 socket。
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
  adbShell(`am start -W -n ${appId}/.MainActivity`);
  await sleep(800);
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
      `void window.ZodyRemoteBridge.returnShell('m2-t6-reset', ${JSON.stringify(
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
    `document.querySelectorAll('[data-mobile-remote-backend-item]').length > 0 ||
     document.body.innerText.includes('Gateway') ||
     document.body.innerText.includes('gateway')`,
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
      text: el.innerText,
    })),
    connect: [...document.querySelectorAll('footer button')].map((button) => ({
      label: button.innerText,
      disabled: button.disabled,
    })),
    bodyText: document.body.innerText.slice(0, 600),
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

async function runDeviceBootstrap() {
  await control("/delay?ms=0").catch(() => {});
  await returnShellIfRemote();
  const pairing = await ensureConfigured();
  const shell = await shellPage();
  await waitPicker(shell);
  const state = await pickerState(shell);
  const selected = state.items.find((item) => item.supported === "true" && !item.disabled);
  assert(selected, `no selectable desktop: ${JSON.stringify(state.items)}`);
  const remote = await clickBackend(shell, selected.id);
  await remote.waitFor(
    "document.body.innerText.includes('Connected to the gateway') || " +
      "document.body.innerText.includes('No project is open') || " +
      "document.body.innerText.includes('Recent projects') || " +
      "document.body.innerText.includes('Open another project')",
    45000,
    "remote start page",
  );
  const context = await remoteContext(remote);
  const body = await remote.evaluate("document.body.innerText.slice(0, 400)");
  const provider = await control("/status");
  remote.close();
  record("device-bootstrap", "pass", {
    pairing,
    backendId: context.backendId,
    sessionId: context.sessionId,
    clientInstanceId: context.clientInstanceId,
    bridgeCapabilities: context.bridgeCapabilities,
    remoteBodyPrefix: body,
    provider: {
      state: provider.state,
      backendId: provider.backendId,
      channelCount: provider.channelCount,
    },
  });
}

async function runContracts() {
  const page = await remotePage();
  await sleep(1200);
  const context = await remoteContext(page);
  const headers = await page.evaluate(`(async () => {
    async function probe(path, init) {
      try {
        const response = await fetch(path, init);
        const body = init && init.method === 'HEAD' ? null : await response.text();
        return {
          status: response.status,
          cacheControl: response.headers.get('cache-control'),
          csp: response.headers.get('content-security-policy'),
          xfo: response.headers.get('x-frame-options'),
          nosniff: response.headers.get('x-content-type-options'),
          referrer: response.headers.get('referrer-policy'),
          allow: response.headers.get('allow'),
          bodyLength: body === null ? null : body.length,
        };
      } catch (error) {
        return { error: String(error) };
      }
    }
    return {
      indexGet: await probe('/assets/remote/index.html'),
      indexHead: await probe('/assets/remote/index.html', { method: 'HEAD' }),
      post: await probe('/assets/remote/index.html', { method: 'POST' }),
      oldHash: await probe('/assets/remote/assets/deadbeefdeadbeef.js'),
      traversal: await probe('/assets/remote/%2e%2e/secret'),
      apiPath: await probe('/api/anything'),
    };
  })()`);
  const leaks = await page.evaluate(`(() => {
    const needle = ${JSON.stringify(deviceCredential ?? "")};
    const prefix = needle ? needle.slice(0, 4) : 'zgd_';
    const local = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      local.push({ key, value: localStorage.getItem(key) });
    }
    const session = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      session.push({ key, value: sessionStorage.getItem(key) });
    }
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    return {
      url: location.href.includes(needle) || location.href.includes(prefix),
      localStorage: JSON.stringify(local).includes(needle) || JSON.stringify(local).includes(prefix),
      sessionStorage: JSON.stringify(session).includes(needle) || JSON.stringify(session).includes(prefix),
      cookie: document.cookie.includes(needle) || document.cookie.includes(prefix),
      resources: resources.some((url) => url.includes(needle) || url.includes(prefix)),
      dom: document.documentElement.innerHTML.includes(needle),
    };
  })()`);
  const navigation = await page.evaluate(`(async () => {
    const before = location.href;
    const iframe = document.createElement('iframe');
    iframe.src = 'https://example.com/third-party';
    iframe.setAttribute('data-e2e-blocked-frame', 'true');
    document.body.appendChild(iframe);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const iframePresent = Boolean(document.querySelector('[data-e2e-blocked-frame]'));
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/top-navigation';
    anchor.target = '_top';
    anchor.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { before, after: location.href, iframePresent };
  })()`);
  const stale = await page.evaluate(`(() => {
    const bridge = window.ZodyRemoteBridge;
    return {
      markRemoteReady: JSON.parse(bridge.markRemoteReady('stale-session-id')),
      returnShell: JSON.parse(bridge.returnShell('stale', 'stale-session-id')),
      saveFileBegin: JSON.parse(bridge.saveFileBegin('stale-session-id', 'x.txt', 'text/plain')),
      pendingClick: JSON.parse(bridge.notificationGetPendingClick('stale-session-id')),
    };
  })()`);
  // 外部导航测试会把主框架交给系统浏览器；后续场景前恢复本应用前台。
  await bringAppToForeground();
  page.close();
  const pass =
    headers.indexGet.status === 200 &&
    Boolean(headers.indexGet.csp?.includes("frame-src 'none'")) &&
    headers.indexGet.xfo === "DENY" &&
    headers.indexGet.nosniff === "nosniff" &&
    headers.indexGet.referrer === "no-referrer" &&
    headers.indexHead.status === 200 &&
    (headers.indexHead.bodyLength === null || headers.indexHead.bodyLength === 0) &&
    headers.post.status === 405 &&
    headers.post.allow === "GET, HEAD" &&
    headers.oldHash.status === 404 &&
    headers.oldHash.bodyLength === 0 &&
    headers.traversal.status === 404 &&
    headers.traversal.bodyLength === 0 &&
    headers.apiPath.status === 404 &&
    headers.apiPath.bodyLength === 0 &&
    !Object.values(leaks).some(Boolean) &&
    navigation.after === navigation.before &&
    stale.markRemoteReady.error?.code === "stale-session" &&
    stale.returnShell.error?.code === "stale-session" &&
    stale.saveFileBegin.error?.code === "stale-session";
  record("contracts", pass ? "pass" : "fail", {
    sessionId: context.sessionId,
    headers,
    leaks,
    navigation,
    stale,
  });
}

async function runFileAndNotificationContract() {
  const page = await remotePage();
  const context = await remoteContext(page);
  const result = await page.evaluate(`(async () => {
    const bridge = window.ZodyRemoteBridge;
    const sessionId = ${JSON.stringify(context.sessionId)};
    const begin = JSON.parse(bridge.saveFileBegin(sessionId, 'm2-t6-e2e.txt', 'text/plain'));
    if (!begin.ok) return { begin };
    const bytes = new TextEncoder().encode('m2-t6-e2e-file-content');
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const append = JSON.parse(bridge.saveFileAppend(sessionId, begin.token, btoa(binary)));
    const finish = JSON.parse(bridge.saveFileFinish(sessionId, begin.token));
    return {
      begin: { ok: begin.ok, hasToken: typeof begin.token === 'string' },
      append: { ok: append.ok },
      finish: { ok: finish.ok, displayPath: finish.file?.displayPath, hasUri: Boolean(finish.file?.uri) },
      pendingClick: JSON.parse(bridge.notificationGetPendingClick(sessionId)),
      pendingAction: JSON.parse(bridge.notificationGetPendingAction(sessionId)),
      status: JSON.parse(bridge.notificationGetStatus(sessionId)),
    };
  })()`);
  page.close();
  let savedFile = null;
  let savedFileMatches = false;
  try {
    savedFile = adbShell("cat /sdcard/Download/m2-t6-e2e.txt");
    savedFileMatches = savedFile === "m2-t6-e2e-file-content";
  } catch {
    // 读取失败即视为未落盘，纳入 pass 断言。
  }
  const pass =
    result.begin.ok &&
    result.append.ok &&
    result.finish.ok &&
    result.pendingClick.ok &&
    result.pendingAction.ok &&
    result.status.ok &&
    savedFileMatches;
  record("file-notification-contract", pass ? "pass" : "fail", {
    ...result,
    savedFileMatches,
  });
}

async function runReopen() {
  await returnShellIfRemote();
  const shell = await shellPage();
  await waitPicker(shell);
  const selected = (await pickerState(shell)).items.find(
    (item) => item.supported === "true" && !item.disabled,
  );
  const first = await clickBackend(shell, selected.id);
  const firstContext = await remoteContext(first);
  first.close();
  await returnShellIfRemote();
  const shell2 = await shellPage();
  await waitPicker(shell2);
  const second = await clickBackend(shell2, selected.id);
  const secondContext = await remoteContext(second);
  const stale = JSON.parse(
    await second.evaluate(
      `window.ZodyRemoteBridge.markRemoteReady(${JSON.stringify(firstContext.sessionId)})`,
    ),
  );
  second.close();
  const pass =
    firstContext.backendId === secondContext.backendId &&
    firstContext.sessionId !== secondContext.sessionId &&
    firstContext.clientInstanceId === secondContext.clientInstanceId &&
    stale.error?.code === "stale-session";
  record("reopen-session-rotation", pass ? "pass" : "fail", {
    sameBackend: firstContext.backendId === secondContext.backendId,
    sessionChanged: firstContext.sessionId !== secondContext.sessionId,
    clientInstanceIdReused: firstContext.clientInstanceId === secondContext.clientInstanceId,
    staleOldSession: stale,
  });
  await returnShellIfRemote();
}

async function runOldDesktop() {
  await returnShellIfRemote();
  const shell = await shellPage();
  await control("/mode?value=old");
  await sleep(1500);
  await shell.evaluate("location.reload(); true").catch(() => {});
  await sleep(2000);
  await waitPicker(shell);
  await sleep(3000);
  const state = await pickerState(shell);
  const item = state.items[0];
  const connect = state.connect[state.connect.length - 1];
  const pass = item?.supported === "false" && item?.disabled === true && connect?.disabled === true;
  record("old-desktop-shell", pass ? "pass" : "fail", { state });
  try {
    await control("/mode?value=new");
    await waitForProviderOnline();
    await sleep(500);
    await shell.evaluate("location.reload(); true").catch(() => {});
  } finally {
    shell.close();
  }
}

async function runOffline() {
  await returnShellIfRemote();
  const shell = await shellPage();
  await control("/offline");
  await sleep(1500);
  await shell.evaluate("location.reload(); true").catch(() => {});
  await sleep(2000);
  await waitPicker(shell);
  await sleep(2000);
  const offlineState = await pickerState(shell);
  const clicked = await shell.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('footer button')];
    const connect = buttons[buttons.length - 1];
    if (!connect || connect.disabled) return false;
    connect.click();
    return true;
  })()`);
  shell.close();
  if (clicked) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const targets = await listTargets();
      if (!targets.some(remotePredicate) && targets.some(shellPredicate)) break;
      await sleep(500);
    }
  }
  const finalShell = await shellPage();
  await finalShell.waitFor(
    `document.querySelector('[data-mobile-remote-page="backend-picker"]') !== null ||
     document.body.innerText.includes('Gateway')`,
    20000,
    "shell content after offline failure",
  );
  const finalState = await finalShell.evaluate(`(() => ({
    url: location.href,
    hasShellBridge: typeof window.ZodyShellBridge === 'object' && window.ZodyShellBridge !== null,
    hasRemoteBridge: typeof window.ZodyRemoteBridge === 'object' && window.ZodyRemoteBridge !== null,
    configOk: JSON.parse(window.ZodyShellBridge.readConfig()).ok,
    picker: Boolean(document.querySelector('[data-mobile-remote-page="backend-picker"]')),
    bodyText: document.body.innerText.slice(0, 500),
  }))()`);
  finalShell.close();
  const pass =
    offlineState.items[0]?.text.includes("Offline") &&
    finalState.url.includes("appassets.androidplatform.net") &&
    finalState.hasShellBridge &&
    !finalState.hasRemoteBridge &&
    finalState.configOk &&
    finalState.picker;
  record("offline-desktop-shell", pass ? "pass" : "fail", {
    offlineState,
    connectClicked: clicked,
    finalState,
  });
  await control("/mode?value=new");
  await waitForProviderOnline();
  await sleep(500);
}

async function runNotificationGate() {
  await returnShellIfRemote();
  const shell = await shellPage();
  await control("/delay?ms=1500");
  await waitPicker(shell);
  const selected = (await pickerState(shell)).items.find(
    (item) => item.supported === "true" && !item.disabled,
  );
  const page = await clickBackend(shell, selected.id);
  try {
    await page.waitFor(
      "typeof window.ZcodeMobileBridgeHost === 'object' && window.ZcodeMobileBridgeHost !== null",
      20000,
      "native host",
    );
    await page.evaluate(`(() => {
      window.__zodyClicks = [];
      const host = window.ZcodeMobileBridgeHost;
      const original = host.onNotificationClick;
      host.onNotificationClick = function (first, second) {
        window.__zodyClicks.push({ first, at: Date.now() });
        return original.call(this, first, second);
      };
      return true;
    })()`);
    const backendId = (await control("/status")).backendId;
    adbShell(
      `am start -W -n ${appId}/.MainActivity --activity-single-top -a android.intent.action.VIEW -d 'zody://notification/v1?backendId=${backendId}&notificationId=m2-t6-before-ready'`,
    );
    const startedAt = Date.now();
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      await sleep(300);
      let count = -1;
      try {
        count = await page.evaluate("window.__zodyClicks ? window.__zodyClicks.length : -1");
      } catch {
        // 导航/重连期间页面可能暂不可用。
      }
      samples.push({ ms: Date.now() - startedAt, count });
    }
    const clicks = await page.evaluate("window.__zodyClicks ?? []");
    const beforeReady = samples.filter((sample) => sample.ms < 1000);
    const afterReady = samples.filter((sample) => sample.ms > 3000);
    const pass =
      beforeReady.every((sample) => sample.count === 0) &&
      afterReady.some((sample) => sample.count > 0);
    record("notification-ready-gate", pass ? "pass" : "fail", { samples, clicks });
  } finally {
    await control("/delay?ms=0").catch(() => {});
    page.close();
    await returnShellIfRemote().catch(() => {});
  }
}

async function runActivityRecreate() {
  await returnShellIfRemote();
  const shell = await shellPage();
  await waitPicker(shell);
  const selected = (await pickerState(shell)).items.find(
    (item) => item.supported === "true" && !item.disabled,
  );
  const first = await clickBackend(shell, selected.id);
  const firstContext = await remoteContext(first);
  const firstTargetId = first.target.id;
  first.close();
  adbShell("settings put system accelerometer_rotation 0");
  const currentRotation = adbShell("settings get system user_rotation");
  if (currentRotation === "1") {
    adbShell("settings put system user_rotation 0");
    await sleep(1500);
  }
  adbShell("settings put system user_rotation 1");
  const secondTarget = await waitForTarget(
    (target) => remotePredicate(target) && target.id !== firstTargetId && isVisibleTarget(target),
    30000,
    "recreated remote target",
  ).catch(() =>
    waitForTarget(
      (target) => remotePredicate(target) && target.id !== firstTargetId,
      30000,
      "recreated remote target (fallback)",
    ),
  );
  const second = await CdpPage.connect((target) => target.id === secondTarget.id, 30000);
  await second.waitFor(
    "document.body !== null && typeof window.ZodyRemoteBridge === 'object'",
    30000,
    "remote bridge after recreate",
  );
  const secondContext = await remoteContext(second);
  second.close();
  adbShell("settings put system user_rotation 0");
  const pass =
    firstContext.backendId === secondContext.backendId &&
    firstContext.sessionId !== secondContext.sessionId &&
    firstContext.clientInstanceId === secondContext.clientInstanceId;
  record("activity-recreate", pass ? "pass" : "fail", {
    sameBackend: firstContext.backendId === secondContext.backendId,
    sessionChanged: firstContext.sessionId !== secondContext.sessionId,
    clientInstanceIdStable: firstContext.clientInstanceId === secondContext.clientInstanceId,
  });
  await returnShellIfRemote();
}

const scenarios = [
  ["device-bootstrap", runDeviceBootstrap],
  ["contracts", runContracts],
  ["file-notification-contract", runFileAndNotificationContract],
  ["reopen-session-rotation", runReopen],
  ["old-desktop-shell", runOldDesktop],
  ["offline-desktop-shell", runOffline],
  ["notification-ready-gate", runNotificationGate],
  ["activity-recreate", runActivityRecreate],
];

try {
  await setupDevtools();
  for (const [name, run] of scenarios) {
    if (skip.has(name)) {
      record(name, "skipped", { reason: "ZODY_E2E_SKIP" });
      continue;
    }
    try {
      await run();
    } catch (error) {
      record(name, "fail", { error: error instanceof Error ? error.message : String(error) });
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}
const failed = Object.values(report.scenarios).some((scenario) => scenario.status === "fail");
const output = `${JSON.stringify(report, null, 2)}\n`;
await new Promise((resolve) => process.stdout.write(output, resolve));
process.exit(report.error || failed ? 1 : 0);
