/* eslint-disable max-lines -- 真实 Chrome smoke 需要内联 fixture、配对、授权、locator 与撤销场景。 */
/*
 * P2 真实 headed Chrome smoke：
 * 1. 独立临时 Profile 加载扩展并配对。
 * 2. listUserTabs 只返回标题和去 userinfo/query/hash 的 URL。
 * 3. 第一次 claimTab 立即 authorization_required；Popup 同意后第二次 claim 才 attach。
 * 4. locator fill/click/selectOption/check、domSnapshot、evaluate。
 * 5. 跨域 iframe 经 targetId attach 后 locator fill/click。
 * 6. 用户 tab 的 confirm dialog 在命令预算耗尽时默认 accept:false 并解除阻塞。
 * 7. 撤销后旧 binding 立即 target_unavailable，用户 tab 仍留在 Chrome。
 *
 * 只使用临时 Profile，不读取开发者日常 Chrome Profile。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionBridgeServer } from "../../desktop/src/main/extensionBridge/server.ts";
import { createExtensionPersistentStores } from "../../desktop/src/main/extensionBridge/persistentStores.ts";
import { ExtensionCdpTransport } from "../../desktop/src/browser-core/extensionCdpTransport.ts";
import { ExtensionBrowserBackend } from "../../desktop/src/host/extensionBrowserBackend.ts";
import {
  CdpConnection,
  evaluate,
  extensionIdFromManifest,
  findChromeExecutable,
  log,
  poll,
  readDevToolsPort,
  sleep,
} from "./p0SmokeSupport.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, "dist");
const DIALOG_TIMEOUT_MS = 2_000;

const frameHtml = `<!doctype html>
<html><head><title>Frame Fixture</title></head>
<body data-marker="p2-frame">
  <h2>Cross-origin frame</h2>
  <input id="frame-input" />
  <button id="frame-button" type="button">Send</button>
  <script>
    document.getElementById('frame-button').addEventListener('click', () => {
      parent.postMessage({
        type: 'p2-frame-clicked',
        value: document.getElementById('frame-input').value
      }, '*');
    });
  </script>
</body></html>`;

function mainHtml(frameUrl) {
  const safeFrameUrl = frameUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html>
<html><head><title>Zody P2 Fixture</title></head>
<body data-marker="p2-fixture">
  <h1>P2 Fixture</h1>
  <label>Name <input id="name" /></label>
  <button id="save" type="button">Save</button>
  <div id="result"></div>
  <select id="choice"><option value="a">A</option><option value="b">B</option></select>
  <label><input id="agree" type="checkbox" /> Agree</label>
  <div id="frame-result"></div>
  <iframe id="frame" src="${safeFrameUrl}" width="420" height="220"></iframe>
  <button id="dialog" type="button">Open dialog</button>
  <div id="dialog-result"></div>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      document.getElementById('result').textContent =
        'saved:' + document.getElementById('name').value;
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'p2-frame-clicked') return;
      document.getElementById('frame-result').textContent = 'frame:' + event.data.value;
    });
    document.getElementById('dialog').addEventListener('click', () => {
      const accepted = confirm('Submit P2 data?');
      document.getElementById('dialog-result').textContent =
        accepted ? 'accepted' : 'rejected';
    });
  </script>
</body></html>`;
}

class RealTransport {
  constructor(server, windowId) {
    this.server = server;
    this.windowId = windowId;
    this.connection = undefined;
    this.eventListeners = new Set();
    this.connectionListeners = new Set();
  }

  async listConnections() {
    const connections = this.server
      .listConnectedProfiles()
      .filter((info) => info.windowId === this.windowId)
      .map((info) => ({
        profileInstanceId: info.profileInstanceId,
        browserId: info.browserId,
        generation: info.generation,
        connectionId: info.connectionId,
        windowId: info.windowId,
      }));
    this.connection = connections[0];
    return connections;
  }

  async request(profileInstanceId, message) {
    return await this.server.request(profileInstanceId, message);
  }

  async send(profileInstanceId, message) {
    return this.server.send(profileInstanceId, message);
  }

  onConnectionChange(listener) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getConnection(profileInstanceId) {
    return this.connection?.profileInstanceId === profileInstanceId ? this.connection : undefined;
  }

  handleResult() {}
  handleConnectionChanged(input) {
    const previous =
      this.connection?.profileInstanceId === input.profileInstanceId ? this.connection : undefined;
    const connection = {
      profileInstanceId: input.profileInstanceId,
      browserId: input.browserId ?? previous?.browserId ?? `extension:${input.profileInstanceId}`,
      generation: input.generation ?? previous?.generation ?? 0,
      connectionId: input.connectionId ?? previous?.connectionId ?? "",
      windowId: input.windowId ?? previous?.windowId ?? this.windowId,
    };
    if (input.connected) this.connection = connection;
    else if (previous) this.connection = undefined;
    for (const listener of this.connectionListeners) {
      listener({ connected: input.connected, connection });
    }
  }
  handleEvent(event) {
    for (const listener of this.eventListeners) listener(event);
  }
  dispose() {}
}

function createServerInstance(stores, extensionId, events) {
  return new ExtensionBridgeServer({
    port: 0,
    expectedExtensionId: extensionId,
    credentialStore: stores.credentialStore,
    generationStore: stores.generationStore,
    logger: {
      debug: () => undefined,
      info: (...args) => log("bridge:", ...args),
      warn: (...args) => log("bridge warn:", ...args),
      error: (...args) => log("bridge error:", ...args),
    },
    onAuthenticated: (info) => events.onAuthenticated?.(info),
    onDisconnected: (info) => events.onDisconnected?.(info),
    onExtensionMessage: (profile, message) => events.onMessage?.(profile, message),
  });
}

async function pairThroughPopup(cdp, sessionId, ticket, port) {
  await evaluate(cdp, sessionId, `chrome.storage.local.set({ 'zody.bridgePort': ${port} })`);
  await evaluate(cdp, sessionId, "document.getElementById('reconnect').click()");
  const shownSession = await poll(
    () => evaluate(cdp, sessionId, "document.getElementById('pairing-session')?.textContent || ''"),
    30_000,
    "pairing session in popup",
  );
  if (shownSession !== ticket.pairingSessionId) {
    throw new Error(`popup pairing session mismatch: ${shownSession}`);
  }
  await poll(
    () =>
      evaluate(
        cdp,
        sessionId,
        "Boolean(document.getElementById('pair') && !document.getElementById('pair').disabled)",
      ),
    20_000,
    "pair button enabled",
  );
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const input = document.getElementById('pairing-code');
      input.value = ${JSON.stringify(ticket.pairingCode)};
      document.getElementById('pair').click();
      return true;
    })()`,
  );
}

async function approvePendingClaim(cdp, sessionId) {
  await poll(
    () =>
      evaluate(
        cdp,
        sessionId,
        `Boolean([...document.querySelectorAll('#claims-list button')]
          .find((button) => button.textContent === 'Allow'))`,
      ),
    10_000,
    "pending claim in popup",
  );
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const button = [...document.querySelectorAll('#claims-list button')]
        .find((candidate) => candidate.textContent === 'Allow');
      if (!button) throw new Error('Allow button disappeared');
      button.click();
      return true;
    })()`,
  );
  // claim.decision 经 worker → offscreen → Main → Host，测试侧等待 Host 收到。
  await sleep(1_000);
}

async function readEval(backend, context, tabId, expression) {
  const result = await backend.execute(context(), {
    method: "evaluate",
    expression,
    tabId,
  });
  if (!result.ok) throw new Error(`evaluate failed: ${JSON.stringify(result)}`);
  return result.value;
}

async function main() {
  if (!existsSync(join(distDir, "manifest.json"))) {
    throw new Error(`extension is not built: ${distDir}`);
  }
  const manifest = JSON.parse(await readFile(join(distDir, "manifest.json"), "utf8"));
  const extensionId = extensionIdFromManifest(manifest);
  const chromePath = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), "zody-p2-chrome-"));
  const stateDir = await mkdtemp(join(tmpdir(), "zody-p2-state-"));
  if (!userDataDir.startsWith(tmpdir())) {
    throw new Error("refusing to run with a non-temporary Chrome profile");
  }
  log("chrome:", chromePath);
  log("isolated profile:", userDataDir);

  const frameServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(frameHtml);
  });
  await new Promise((resolve) => frameServer.listen(0, "127.0.0.1", resolve));
  // 与父页面不同站，强制 OOPIF，覆盖 targetId attach 路径；Chrome 用 resolver rule 指向本机。
  const frameUrl = `http://frame.test:${frameServer.address().port}/frame`;

  const mainServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(mainHtml(frameUrl));
  });
  await new Promise((resolve) => mainServer.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${mainServer.address().port}/fixture?secret=1#frag`;
  const sanitizedFixtureUrl = `http://127.0.0.1:${mainServer.address().port}/fixture`;

  const events = {};
  const stores = createExtensionPersistentStores({ userDataPath: stateDir });
  const server = createServerInstance(stores, extensionId, events);
  const { port: bridgePort } = await server.start();
  const ticket = server.beginPairing({ windowId: "p2-smoke" });
  log("pairing session:", ticket.pairingSessionId);

  const stderr = [];
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
      "--host-resolver-rules=MAP frame.test 127.0.0.1",
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      fixtureUrl,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.length > 200) stderr.shift();
  });

  let cdp;
  try {
    const { port: devtoolsPort, browserPath } = await readDevToolsPort(userDataDir, child, stderr);
    cdp = await CdpConnection.connect(`ws://127.0.0.1:${devtoolsPort}${browserPath}`);

    // 独立 popup 页面用于配对和授权；它同时验证 badge/claim 数据来自 service worker。
    const { targetId: popupTargetId } = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html`,
    });
    const { sessionId: popupSession } = await cdp.send("Target.attachToTarget", {
      targetId: popupTargetId,
      flatten: true,
    });
    await cdp.send("Runtime.enable", {}, popupSession);
    await poll(
      () => evaluate(cdp, popupSession, "document.readyState === 'complete'"),
      20_000,
      "popup document",
    );
    await pairThroughPopup(cdp, popupSession, ticket, bridgePort);
    const connection = await poll(() => server.listConnectedProfiles()[0] ?? null, 20_000, "pair");
    log("paired:", { generation: connection.generation });

    const transport = new RealTransport(server, "p2-smoke");
    events.onAuthenticated = (info) =>
      transport.handleConnectionChanged({ ...info, connected: true });
    events.onDisconnected = (info) =>
      transport.handleConnectionChanged({ ...info, connected: false });
    events.onMessage = (profileInstanceId, message) =>
      transport.handleEvent({ profileInstanceId, message });
    await transport.listConnections();

    const cdpTransport = new ExtensionCdpTransport({
      request: (message) =>
        transport.request(message.targetRef.browserId.replace(/^extension:/, ""), message),
    });
    const backend = new ExtensionBrowserBackend({
      transport,
      cdp: cdpTransport,
      navigationTimeoutMs: 20_000,
      claimTtlMs: 60_000,
      dialogTimeoutMs: DIALOG_TIMEOUT_MS,
      logger: {
        debug: (...args) => log("backend:", ...args),
        info: (...args) => log("backend:", ...args),
        warn: (...args) => log("backend warn:", ...args),
        error: (...args) => log("backend error:", ...args),
      },
    });
    const context = () => ({
      requestId: randomUUID(),
      sessionId: "p2-smoke-session",
      workspaceKey: "p2-smoke-workspace",
      workspaceIdentity: "p2-smoke-workspace",
      clientMode: "desktop-continuous",
      sessionContext: "live",
      browserId: connection.browserId,
      browserGeneration: connection.generation,
    });

    // 1. openTabs 只返回标题和去 query/hash 的 URL。
    const userTabs = await backend.execute(context(), { method: "listUserTabs" });
    if (!userTabs.ok || !userTabs.userTabs) {
      throw new Error(`listUserTabs failed: ${JSON.stringify(userTabs)}`);
    }
    const fixtureTab = userTabs.userTabs.find((tab) => tab.url === sanitizedFixtureUrl);
    if (!fixtureTab) {
      throw new Error(
        `fixture tab missing or URL not sanitized: ${JSON.stringify(userTabs.userTabs)}`,
      );
    }
    if (fixtureTab.url.includes("secret") || fixtureTab.url.includes("#")) {
      throw new Error(`openTabs leaked query/hash: ${fixtureTab.url}`);
    }
    if (fixtureTab.title !== "Zody P2 Fixture") {
      throw new Error(`openTabs title mismatch: ${fixtureTab.title}`);
    }
    log("openTabs sanitized OK:", fixtureTab.url);

    // 2. 第一次 claim 立即 authorization_required，不占 30 秒预算。
    const firstClaimStarted = Date.now();
    const firstClaim = await backend.execute(context(), {
      method: "claimTab",
      tabId: fixtureTab.id,
    });
    const firstClaimMs = Date.now() - firstClaimStarted;
    if (firstClaim.ok || firstClaim.error?.code !== "authorization_required") {
      throw new Error(`first claim did not require authorization: ${JSON.stringify(firstClaim)}`);
    }
    if (firstClaimMs > 3_000) {
      throw new Error(`first claim waited too long (${firstClaimMs}ms)`);
    }
    log("first claim returned authorization_required", { ms: firstClaimMs });
    const afterFirstClaim = await backend.execute(context(), { method: "list" });
    if ((afterFirstClaim.tabs ?? []).length !== 0) {
      throw new Error("first claim attached before user authorization");
    }

    // 3. Popup 同意后同一 session 第二次 claim 才 attach。
    await approvePendingClaim(cdp, popupSession);
    let claimed;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      claimed = await backend.execute(context(), { method: "claimTab", tabId: fixtureTab.id });
      if (claimed.ok) break;
      if (claimed.error?.code !== "authorization_required") {
        throw new Error(`second claim failed: ${JSON.stringify(claimed)}`);
      }
      await sleep(500);
    }
    if (!claimed?.ok || !claimed.tab) {
      throw new Error(`second claim did not attach: ${JSON.stringify(claimed)}`);
    }
    const tabId = claimed.tab.tabId;
    log("second claim attached user tab:", tabId);
    // Popup 仍是 active tab，用户页面此刻是 hidden。先验证 locator 在后台 tab 不会静默 no-op：
    // 隐藏文档的 click 使用页面内 MouseEvent 兜底，可见文档仍走 trusted input。
    for (const action of [
      { name: "locator", selector: "#name", operation: "fill", value: "hidden" },
      { name: "locator", selector: "#save", operation: "click" },
    ]) {
      const hiddenResult = await backend.execute(context(), {
        method: "playwright",
        tabId,
        action,
      });
      if (!hiddenResult.ok) {
        throw new Error(
          `hidden-tab locator ${action.operation} failed: ${JSON.stringify(hiddenResult)}`,
        );
      }
    }
    const hiddenClickResult = await readEval(
      backend,
      context,
      tabId,
      "document.querySelector('#result').textContent",
    );
    if (hiddenClickResult !== "saved:hidden") {
      throw new Error(`hidden-tab locator click silently no-op: ${hiddenClickResult}`);
    }
    log("hidden-tab locator fill/click fallback OK");
    // 真实使用中 Popup 是扩展浮层，用户页面仍是 active tab；这里用独立 popup 页面代替浮层，
    // 因此测试侧把用户页面恢复为前台，验证 locator 的 trusted input 路径。
    const targets = await cdp.send("Target.getTargets");
    const fixtureTarget = (targets.targetInfos ?? []).find((target) =>
      String(target.url ?? "").startsWith(sanitizedFixtureUrl),
    );
    if (!fixtureTarget?.targetId) throw new Error("fixture page target is unavailable");
    await cdp.send("Target.activateTarget", { targetId: fixtureTarget.targetId });
    await sleep(300);

    // 4. locator fill/click/selectOption/check + domSnapshot + evaluate。
    let result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "locator", selector: "#name", operation: "fill", value: "P2-value" },
    });
    if (!result.ok) throw new Error(`locator.fill failed: ${JSON.stringify(result)}`);
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "locator", selector: "#save", operation: "click" },
    });
    if (!result.ok) throw new Error(`locator.click failed: ${JSON.stringify(result)}`);
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: {
        name: "locator",
        selector: "#choice",
        operation: "selectOption",
        selections: [{ value: "b" }],
      },
    });
    if (!result.ok) throw new Error(`locator.selectOption failed: ${JSON.stringify(result)}`);
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "locator", selector: "#agree", operation: "setChecked", checked: true },
    });
    if (!result.ok) throw new Error(`locator.check failed: ${JSON.stringify(result)}`);
    const pageState = await readEval(
      backend,
      context,
      tabId,
      "({ result: document.querySelector('#result').textContent, choice: document.querySelector('#choice').value, agree: document.querySelector('#agree').checked })",
    );
    if (
      pageState?.result !== "saved:P2-value" ||
      pageState.choice !== "b" ||
      pageState.agree !== true
    ) {
      throw new Error(`locator effects mismatch: ${JSON.stringify(pageState)}`);
    }
    const snapshot = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "domSnapshot" },
    });
    if (
      !snapshot.ok ||
      typeof snapshot.value !== "string" ||
      !snapshot.value.includes("P2 Fixture")
    ) {
      throw new Error(`domSnapshot missing fixture content: ${JSON.stringify(snapshot.value)}`);
    }
    log("locator fill/click/selectOption/check + domSnapshot OK");

    // 5. 跨域 iframe：targetId 映射后 fill/click，父页面收到 postMessage。
    const frameSelector = "#frame >> internal:control=enter-frame >> #frame-input";
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "locator", selector: frameSelector, operation: "fill", value: "iframe-p2" },
    });
    if (!result.ok) throw new Error(`iframe locator.fill failed: ${JSON.stringify(result)}`);
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: {
        name: "locator",
        selector: "#frame >> internal:control=enter-frame >> #frame-button",
        operation: "click",
      },
    });
    if (!result.ok) throw new Error(`iframe locator.click failed: ${JSON.stringify(result)}`);
    const frameResult = await poll(
      () =>
        readEval(backend, context, tabId, "document.querySelector('#frame-result').textContent"),
      5_000,
      "cross-origin frame postMessage",
    );
    if (frameResult !== "frame:iframe-p2") {
      throw new Error(`cross-origin iframe result mismatch: ${frameResult}`);
    }
    const frameSnapshot = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "domSnapshot" },
    });
    if (
      !frameSnapshot.ok ||
      typeof frameSnapshot.value !== "string" ||
      !frameSnapshot.value.includes("Cross-origin frame")
    ) {
      throw new Error("domSnapshot did not expand the cross-origin iframe");
    }
    log("cross-origin iframe locator + snapshot OK");

    // 6. dialog：点击触发 confirm 并阻塞 CDP 命令；Host 在命令预算耗尽前默认 accept:false。
    const dialogStarted = Date.now();
    result = await backend.execute(context(), {
      method: "playwright",
      tabId,
      action: { name: "locator", selector: "#dialog", operation: "click" },
    });
    const dialogElapsed = Date.now() - dialogStarted;
    if (!result.ok) throw new Error(`dialog trigger click failed: ${JSON.stringify(result)}`);
    const dialogAfterClick = await backend.execute(context(), { method: "getDialog", tabId });
    if (!dialogAfterClick.ok) {
      throw new Error(`getDialog after dialog failed: ${JSON.stringify(dialogAfterClick)}`);
    }
    if (dialogAfterClick.dialog) {
      // 对话框在 click 返回后才被观察到：再用一个命令消耗预算，触发默认拒绝。
      const blockedState = await backend.execute(context(), { method: "getState", tabId });
      if (!blockedState.ok) {
        throw new Error(
          `getState stayed blocked after dialog dismissal: ${JSON.stringify(blockedState)}`,
        );
      }
    }
    const dialogOutcome = await readEval(
      backend,
      context,
      tabId,
      "document.querySelector('#dialog-result').textContent",
    );
    if (dialogOutcome !== "rejected") {
      throw new Error(`dialog was not default-rejected: ${dialogOutcome}`);
    }
    const dialogAfter = await backend.execute(context(), { method: "getDialog", tabId });
    if (!dialogAfter.ok || dialogAfter.dialog !== null) {
      throw new Error(`dialog state not cleared: ${JSON.stringify(dialogAfter)}`);
    }
    log("dialog auto-dismissed with accept:false", { ms: dialogElapsed });

    // 7. 撤销：旧 binding 立即 target_unavailable，用户 tab 仍在 Chrome。
    const nativeTabId = Number(fixtureTab.id.replace(/^extuser:/, ""));
    server.send(connection.profileInstanceId, {
      type: "session.detachAll",
      reason: "socket_closed",
    });
    const revoked = await poll(
      async () => {
        const state = await backend.execute(context(), { method: "getState", tabId });
        return state.ok ? null : state;
      },
      10_000,
      "revoked tab",
    );
    if (revoked.error?.code !== "target_unavailable") {
      throw new Error(`revoked tab returned ${JSON.stringify(revoked)}`);
    }
    const stillOpen = await server.request(
      connection.profileInstanceId,
      { type: "tabs.list", requestId: randomUUID() },
      10_000,
    );
    if (!stillOpen.ok || !stillOpen.tabs?.some((tab) => tab.nativeTabId === nativeTabId)) {
      throw new Error("revoked user tab was closed; it must stay in Chrome");
    }
    log("revocation OK: binding invalid, user tab remains in Chrome");

    console.log(
      "\nP2 SMOKE PASS: two-phase claim + locator fill/click/select/check + cross-origin iframe targetId + default-reject dialog + revoke",
    );
    process.exitCode = 0;
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5_000).then(() => child.kill("SIGKILL")),
    ]);
    await server.stop().catch(() => undefined);
    await new Promise((resolve) => mainServer.close(resolve));
    await new Promise((resolve) => frameServer.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp profile:", error.message),
    );
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp state:", error.message),
    );
  }
}

main().catch((error) => {
  console.error("\nP2 SMOKE FAIL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
