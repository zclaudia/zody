/* eslint-disable max-lines -- 真实 Chrome P3 smoke 需要内联 fixture、配对、授权、cancel/timeout、断连、转移和重载场景。 */
/*
 * P3a 真实 headed Chrome lifecycle smoke：
 * 1. 独立临时 Profile 加载扩展并配对。
 * 2. 创建 agent tab、claim user tab；cancel 只结束目标 evaluate，timeout 标记 uncertain。
 * 3. WebSocket close：扩展关闭 agent tab、user tab 只 detach 并留在 Chrome；扩展重连获得更大 generation。
 * 4. Host exit：Main 发送 session.detachAll，扩展执行同一清理。
 * 5. 跨窗口转移：旧窗口 binding 失效，新窗口获得更大 generation；agent tab 关闭、user tab 保留。
 * 6. offscreen 重启：WebSocket 断开后重建 offscreen，新连接清理 agent tab，user tab 保留。
 * 7. fullPage screenshot 继续 capability_unsupported。
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
import { createExtensionBridgeController } from "../../desktop/src/main/extensionBridge/controller.ts";
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
const WINDOW_A = 101;
const WINDOW_B = 202;
const COMMAND_TIMEOUT_MS = 1_500;

const fixtureHtml = `<!doctype html>
<html><head><title>Zody P3 Fixture</title></head>
<body data-marker="p3-fixture">
  <h1>P3 Lifecycle Fixture</h1>
  <input id="name" value="" />
  <button id="save" type="button">Save</button>
  <div id="result"></div>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      document.getElementById('result').textContent =
        'saved:' + document.getElementById('name').value;
    });
  </script>
</body></html>`;

class ControllerTransport {
  constructor(controller, windowId) {
    this.controller = controller;
    this.windowId = windowId;
    this.connection = undefined;
    this.eventListeners = new Set();
    this.connectionListeners = new Set();
  }

  handleHostMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "extension-connection-changed") {
      this.handleConnectionChanged(message);
      return;
    }
    if (message.type === "extension-event") {
      this.handleEvent({ profileInstanceId: message.profileInstanceId, message: message.message });
    }
  }

  register() {
    this.controller.registerHost(this.windowId, {
      postMessage: (message) => this.handleHostMessage(message),
    });
  }

  async listConnections() {
    const result = await this.controller.handleHostRequest(this.windowId, { op: "list" });
    if (!result.ok) return [];
    this.connection = result.connections?.[0];
    return result.connections ?? [];
  }

  async request(profileInstanceId, message) {
    const result = await this.controller.handleHostRequest(this.windowId, {
      op: "request",
      profileInstanceId,
      message,
    });
    if (!result.ok || !result.message) {
      throw Object.assign(new Error(result.error?.message ?? "extension request failed"), {
        code: result.error?.code ?? "backend_unavailable",
      });
    }
    return result.message;
  }

  async send(profileInstanceId, message) {
    const result = await this.controller.handleHostRequest(this.windowId, {
      op: "send",
      profileInstanceId,
      message,
    });
    if (!result.ok) {
      throw Object.assign(new Error(result.error?.message ?? "extension send failed"), {
        code: result.error?.code ?? "backend_unavailable",
      });
    }
    return true;
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
      windowId: input.windowId ?? previous?.windowId ?? String(this.windowId),
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

function createBackend(transport) {
  const cdp = new ExtensionCdpTransport({
    request: (message) =>
      transport.request(message.targetRef.browserId.replace(/^extension:/, ""), message),
    cancel: (requestId, profileInstanceId) => {
      void transport
        .send(profileInstanceId, { type: "request.cancel", targetRequestId: requestId })
        .catch(() => undefined);
    },
  });
  return {
    transport,
    cdp,
    backend: new ExtensionBrowserBackend({
      transport,
      cdp,
      navigationTimeoutMs: 20_000,
      claimTtlMs: 60_000,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      dialogTimeoutMs: 2_000,
      logger: {
        debug: (...args) => log("backend:", ...args),
        info: (...args) => log("backend:", ...args),
        warn: (...args) => log("backend warn:", ...args),
        error: (...args) => log("backend error:", ...args),
      },
    }),
  };
}

function contextFor(connection, requestId = randomUUID()) {
  return {
    requestId,
    sessionId: "p3-smoke-session",
    workspaceKey: "p3-smoke-workspace",
    workspaceIdentity: "p3-smoke-workspace",
    clientMode: "desktop-continuous",
    sessionContext: "live",
    browserId: connection.browserId,
    browserGeneration: connection.generation,
  };
}

async function listNativeTabs(controller, windowId, profileInstanceId) {
  const result = await controller.handleHostRequest(windowId, {
    op: "request",
    profileInstanceId,
    message: { type: "tabs.list", requestId: randomUUID() },
  });
  if (!result.ok || !result.message?.ok) {
    throw new Error(`tabs.list failed: ${JSON.stringify(result)}`);
  }
  return result.message.tabs ?? [];
}

async function waitForNativeTabState(controller, windowId, profileInstanceId, predicate, label) {
  return await poll(
    async () => {
      try {
        const tabs = await listNativeTabs(controller, windowId, profileInstanceId);
        return predicate(tabs) ? tabs : null;
      } catch {
        return null;
      }
    },
    20_000,
    label,
  );
}

/** newTab 固定后台 about:blank；用创建前后的 nativeTabId 差集识别，不能按 URL 猜。 */
async function findNewNativeTab(controller, windowId, profileInstanceId, existingIds) {
  return await poll(
    async () => {
      const tabs = await listNativeTabs(controller, windowId, profileInstanceId);
      return tabs.find((tab) => !existingIds.has(tab.nativeTabId)) ?? null;
    },
    10_000,
    "new native tab",
  );
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

/**
 * P3 smoke 通过 Popup 页所在的 extension context 直接提交 claim.decision。
 * 两阶段授权 UI 已由 P2 smoke 覆盖；这里聚焦生命周期，避免 DOM 刷新竞态掩盖状态机问题。
 */
async function approvePendingClaim(cdp, sessionId) {
  const outcome = await poll(
    () =>
      evaluate(
        cdp,
        sessionId,
        `(async () => {
          const listed = await chrome.runtime.sendMessage({ target: 'worker', op: 'claim.list' });
          const claim = listed?.data?.claims?.[0];
          if (!claim) return '';
          const response = await chrome.runtime.sendMessage({
            target: 'worker',
            op: 'claim.decide',
            payload: {
              claimId: claim.claimId,
              nativeTabId: claim.nativeTabId,
              decision: 'granted',
            },
          });
          return JSON.stringify(response ?? null);
        })()`,
      ),
    10_000,
    "pending claim decision",
  );
  if (outcome && outcome !== '{"ok":true}') {
    throw new Error(`claim decision failed: ${outcome}`);
  }
  await sleep(500);
}

async function claimUserTab(backend, cdp, popupSession, connection, userTabId) {
  const first = await backend.execute(contextFor(connection), {
    method: "claimTab",
    tabId: userTabId,
  });
  if (first.ok || first.error?.code !== "authorization_required") {
    throw new Error(`first claim did not require authorization: ${JSON.stringify(first)}`);
  }
  await approvePendingClaim(cdp, popupSession);
  let claimed;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    claimed = await backend.execute(contextFor(connection), {
      method: "claimTab",
      tabId: userTabId,
    });
    if (claimed.ok) return claimed;
    if (claimed.error?.code !== "authorization_required") {
      throw new Error(`second claim failed: ${JSON.stringify(claimed)}`);
    }
    await sleep(500);
  }
  throw new Error(`second claim did not attach: ${JSON.stringify(claimed)}`);
}

async function main() {
  if (!existsSync(join(distDir, "manifest.json"))) {
    throw new Error(`extension is not built: ${distDir}`);
  }
  const manifest = JSON.parse(await readFile(join(distDir, "manifest.json"), "utf8"));
  const extensionId = extensionIdFromManifest(manifest);
  const chromePath = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), "zody-p3-chrome-"));
  const stateDir = await mkdtemp(join(tmpdir(), "zody-p3-state-"));
  if (!userDataDir.startsWith(tmpdir())) {
    throw new Error("refusing to run with a non-temporary Chrome profile");
  }
  log("chrome:", chromePath);
  log("isolated profile:", userDataDir);

  const fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture?secret=1#frag`;
  const agentFixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture?agent=1`;
  const reloadAgentFixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture?agent=reload`;
  const sanitizedFixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;

  const controller = createExtensionBridgeController({
    userDataPath: stateDir,
    port: 0,
    logger: {
      debug: () => undefined,
      info: (...args) => log("bridge:", ...args),
      warn: (...args) => log("bridge warn:", ...args),
      error: (...args) => log("bridge error:", ...args),
    },
  });
  const started = await controller.start();
  if (!started.ok || started.port === undefined) {
    throw new Error(`extension bridge did not start: ${JSON.stringify(started)}`);
  }
  const ticket = controller.beginPairing(WINDOW_A);
  if (!ticket) throw new Error("pairing was not available");
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
    await pairThroughPopup(cdp, popupSession, ticket, started.port);
    const paired = await poll(
      async () => {
        const result = await controller.handleHostRequest(WINDOW_A, { op: "list" });
        return result.connections?.[0] ?? null;
      },
      20_000,
      "pairing",
    );
    log("paired:", { generation: paired.generation });

    const transportA = new ControllerTransport(controller, WINDOW_A);
    transportA.register();
    const transportB = new ControllerTransport(controller, WINDOW_B);
    transportB.register();
    await transportA.listConnections();
    const firstConnection = transportA.getConnection(paired.profileInstanceId);
    const { backend } = createBackend(transportA);

    // 1. Agent tab + navigate.
    const existingBeforeAgent = new Set(
      (await listNativeTabs(controller, WINDOW_A, firstConnection.profileInstanceId)).map(
        (tab) => tab.nativeTabId,
      ),
    );
    const created = await backend.execute(contextFor(firstConnection), { method: "newTab" });
    if (!created.ok || !created.tab) {
      throw new Error(`newTab failed: ${JSON.stringify(created)}`);
    }
    const agentTabId = created.tab.tabId;
    const agentNativeTab = await findNewNativeTab(
      controller,
      WINDOW_A,
      firstConnection.profileInstanceId,
      existingBeforeAgent,
    );
    const navigate = await backend.execute(contextFor(firstConnection), {
      method: "navigate",
      tabId: agentTabId,
      url: agentFixtureUrl,
    });
    if (!navigate.ok) throw new Error(`navigate failed: ${JSON.stringify(navigate)}`);
    log("agent tab created:", { logical: agentTabId, native: agentNativeTab.nativeTabId });

    // 2. User tab claim.
    const userTabs = await backend.execute(contextFor(firstConnection), { method: "listUserTabs" });
    const fixtureUserTab = userTabs.userTabs?.find((tab) => tab.url === sanitizedFixtureUrl);
    if (!fixtureUserTab) {
      throw new Error(`fixture user tab missing: ${JSON.stringify(userTabs.userTabs)}`);
    }
    const claimed = await claimUserTab(
      backend,
      cdp,
      popupSession,
      firstConnection,
      fixtureUserTab.id,
    );
    const userNativeTabId = Number(fixtureUserTab.id.replace(/^extuser:/, ""));
    log("user tab claimed:", { logical: claimed.tab.tabId, native: userNativeTabId });

    // 3. Cancel 只结束目标 evaluate；页面保持可用。
    const longEvaluation = backend.execute(contextFor(firstConnection, "p3-cancel-target"), {
      method: "evaluate",
      tabId: agentTabId,
      expression: "new Promise((resolve) => setTimeout(() => resolve('late'), 30000))",
    });
    await sleep(500);
    const cancelCommand = await backend.execute(contextFor(firstConnection, "p3-cancel-command"), {
      method: "cancelRequest",
      requestId: "p3-cancel-target",
    });
    if (!cancelCommand.ok || cancelCommand.value?.cancelled !== true) {
      throw new Error(`cancelRequest failed: ${JSON.stringify(cancelCommand)}`);
    }
    const cancelled = await Promise.race([
      longEvaluation,
      sleep(5_000).then(() => {
        throw new Error("cancelled evaluate did not settle");
      }),
    ]);
    if (cancelled.error?.code !== "cancelled" || cancelled.error.sideEffect !== "uncertain") {
      throw new Error(`cancel result mismatch: ${JSON.stringify(cancelled)}`);
    }
    const afterCancel = await backend.execute(contextFor(firstConnection), {
      method: "evaluate",
      tabId: agentTabId,
      expression: "1 + 1",
    });
    if (!afterCancel.ok || afterCancel.value !== 2) {
      throw new Error(`page unavailable after cancel: ${JSON.stringify(afterCancel)}`);
    }
    log("cancel semantics OK: target-only, uncertain after dispatch, page responsive");

    // 4. Timeout 走同一 abort 路径；已下发 evaluate 标记 uncertain。
    const timedOut = await backend.execute(contextFor(firstConnection, "p3-timeout"), {
      method: "evaluate",
      tabId: agentTabId,
      expression: "new Promise((resolve) => setTimeout(() => resolve('late'), 30000))",
    });
    if (timedOut.error?.code !== "timeout" || timedOut.error.sideEffect !== "uncertain") {
      throw new Error(`timeout result mismatch: ${JSON.stringify(timedOut)}`);
    }
    log("timeout semantics OK:", { ms: COMMAND_TIMEOUT_MS });

    // 5. fullPage 仍 fail closed。
    const fullPage = await backend.execute(contextFor(firstConnection), {
      method: "screenshot",
      tabId: agentTabId,
      fullPage: true,
    });
    if (fullPage.error?.code !== "capability_unsupported") {
      throw new Error(`fullPage did not fail closed: ${JSON.stringify(fullPage)}`);
    }
    log("fullPage capability_unsupported OK");

    // 6. WebSocket close：agent tab 关闭，user tab 留下；扩展重连获得新 generation。
    const beforeDisconnect = firstConnection.generation;
    controller.disconnectProfile(firstConnection.profileInstanceId, "p3_disconnect");
    const reconnected = await poll(
      () => {
        const connection = transportA.getConnection(firstConnection.profileInstanceId);
        return connection && connection.generation > beforeDisconnect ? connection : null;
      },
      30_000,
      "extension reconnect",
    );
    await waitForNativeTabState(
      controller,
      WINDOW_A,
      firstConnection.profileInstanceId,
      (tabs) =>
        !tabs.some((tab) => tab.nativeTabId === agentNativeTab.nativeTabId) &&
        tabs.some((tab) => tab.nativeTabId === userNativeTabId),
      "disconnect cleanup",
    );
    const staleTab = await backend.execute(
      { ...contextFor(firstConnection), browserGeneration: beforeDisconnect },
      { method: "getState", tabId: agentTabId },
    );
    if (staleTab.error?.code !== "backend_unavailable") {
      throw new Error(`old binding was not invalidated: ${JSON.stringify(staleTab)}`);
    }
    log("disconnect cleanup OK: agent closed, user kept, generation", {
      before: beforeDisconnect,
      after: reconnected.generation,
    });

    // Reconnect 后重新 claim user tab，供转移清理验证。先创建新的 agent tab。
    await transportA.listConnections();
    const connectionA = transportA.getConnection(firstConnection.profileInstanceId);
    const beforeA2 = new Set(
      (await listNativeTabs(controller, WINDOW_A, connectionA.profileInstanceId)).map(
        (tab) => tab.nativeTabId,
      ),
    );
    const createdA2 = await backend.execute(contextFor(connectionA, "p3-a2"), { method: "newTab" });
    if (!createdA2.ok || !createdA2.tab) {
      throw new Error(`newTab after reconnect failed: ${JSON.stringify(createdA2)}`);
    }
    const agentA2Native = await findNewNativeTab(
      controller,
      WINDOW_A,
      connectionA.profileInstanceId,
      beforeA2,
    );
    await claimUserTab(backend, cdp, popupSession, connectionA, fixtureUserTab.id);
    log("reconnected bindings restored for transfer test");

    // 7. 跨窗口转移：旧窗口失效，新窗口获得更大 generation。
    await transportB.listConnections();
    const transfer = await controller.transferProfile(connectionA.profileInstanceId, WINDOW_B);
    if (!transfer.ok) throw new Error(`transfer failed: ${JSON.stringify(transfer)}`);
    const transferred = await poll(
      () => {
        const connection = transportB.getConnection(connectionA.profileInstanceId);
        return connection && connection.generation > connectionA.generation ? connection : null;
      },
      20_000,
      "window transfer",
    );
    const oldWindowList = await controller.handleHostRequest(WINDOW_A, { op: "list" });
    if ((oldWindowList.connections ?? []).length !== 0) {
      throw new Error("old window still lists the transferred profile");
    }
    const oldWindowRequest = await controller.handleHostRequest(WINDOW_A, {
      op: "request",
      profileInstanceId: connectionA.profileInstanceId,
      message: { type: "tabs.list", requestId: randomUUID() },
    });
    if (oldWindowRequest.ok)
      throw new Error("old window can still request the transferred profile");
    await waitForNativeTabState(
      controller,
      WINDOW_B,
      connectionA.profileInstanceId,
      (tabs) =>
        !tabs.some((tab) => tab.nativeTabId === agentA2Native.nativeTabId) &&
        tabs.some((tab) => tab.nativeTabId === userNativeTabId),
      "transfer cleanup",
    );
    const { backend: backendB } = createBackend(transportB);
    const beforeB = new Set(
      (await listNativeTabs(controller, WINDOW_B, connectionA.profileInstanceId)).map(
        (tab) => tab.nativeTabId,
      ),
    );
    const createdB = await backendB.execute(contextFor(transferred), { method: "newTab" });
    if (!createdB.ok || !createdB.tab) {
      throw new Error(`new window newTab failed: ${JSON.stringify(createdB)}`);
    }
    const agentBNative = await findNewNativeTab(
      controller,
      WINDOW_B,
      connectionA.profileInstanceId,
      beforeB,
    );
    log("window transfer OK: old invalid, new generation", {
      from: connectionA.generation,
      to: transferred.generation,
    });

    // 8. Host exit：Main 发送 session.detachAll；agent tab 关闭，user tab 保留。
    controller.unregisterHost(WINDOW_B);
    await waitForNativeTabState(
      controller,
      WINDOW_B,
      connectionA.profileInstanceId,
      (tabs) =>
        !tabs.some((tab) => tab.nativeTabId === agentBNative.nativeTabId) &&
        tabs.some((tab) => tab.nativeTabId === userNativeTabId),
      "host exit cleanup",
    );
    log("Host exit cleanup OK: agent closed, user kept");

    // 9. offscreen 重启：关闭 offscreen 使 WebSocket 断开，Popup reconnect 重建 offscreen；
    //    新连接 welcome 触发本地 detachAll，agent tab 关闭、user tab 保留。
    const connectionBeforeReload =
      transportB.getConnection(connectionA.profileInstanceId) ?? transferred;
    const createdC = await backendB.execute(contextFor(connectionBeforeReload, "p3-c"), {
      method: "newTab",
    });
    if (!createdC.ok || !createdC.tab) {
      throw new Error(`newTab before offscreen restart failed: ${JSON.stringify(createdC)}`);
    }
    const navigatedC = await backendB.execute(contextFor(connectionBeforeReload, "p3-c-nav"), {
      method: "navigate",
      tabId: createdC.tab.tabId,
      url: reloadAgentFixtureUrl,
    });
    if (!navigatedC.ok) {
      throw new Error(`agent C navigate failed: ${JSON.stringify(navigatedC)}`);
    }

    await evaluate(cdp, popupSession, "chrome.offscreen.closeDocument()");
    await sleep(500);
    await evaluate(
      cdp,
      popupSession,
      "chrome.runtime.sendMessage({ target: 'worker', type: 'reconnect' })",
    );
    const afterReload = await poll(
      async () => {
        const result = await controller.handleHostRequest(WINDOW_B, { op: "list" });
        const connection = result.connections?.[0];
        return connection && connection.generation > connectionBeforeReload.generation
          ? connection
          : null;
      },
      40_000,
      "extension offscreen restart reconnect",
    );
    await waitForNativeTabState(
      controller,
      WINDOW_B,
      connectionA.profileInstanceId,
      (tabs) =>
        !tabs.some((tab) => String(tab.url ?? "").includes("agent=reload")) &&
        tabs.some((tab) => String(tab.url ?? "").startsWith(sanitizedFixtureUrl)),
      "offscreen restart cleanup",
    );
    log("offscreen restart cleanup OK: agent closed, user kept, generation", {
      before: connectionBeforeReload.generation,
      after: afterReload.generation,
    });

    console.log(
      "\nP3 SMOKE PASS: cancel/timeout + disconnect + Host exit + window transfer + offscreen restart cleanup",
    );
    process.exitCode = 0;
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5_000).then(() => child.kill("SIGKILL")),
    ]);
    await controller.stop().catch(() => undefined);
    await new Promise((resolve) => fixtureServer.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp profile:", error.message),
    );
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp state:", error.message),
    );
  }
}

main().catch((error) => {
  console.error("\nP3 SMOKE FAIL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
