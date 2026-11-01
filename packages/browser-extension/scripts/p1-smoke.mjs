/*
 * P1 真实 headed Chrome smoke：
 * 1. 在独立临时 Chrome Profile 加载扩展并完成配对。
 * 2. 通过真实 ExtensionBrowserBackend 后台新建 tab、导航、getState、viewport screenshot、close。
 * 3. 验证创建/导航/关闭期间 Chrome 的 active tab 没有变化（不抢前台）。
 * 4. 重启 ExtensionBridgeServer（复用持久 state 文件），真实扩展 resume 后 generation 递增。
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
    if (input.connected) {
      this.connection = connection;
    } else if (previous) {
      this.connection = undefined;
    }
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

async function reconnectThroughPopup(cdp, sessionId, port) {
  await evaluate(cdp, sessionId, `chrome.storage.local.set({ 'zody.bridgePort': ${port} })`);
  await evaluate(cdp, sessionId, "document.getElementById('reconnect').click()");
}

async function main() {
  if (!existsSync(join(distDir, "manifest.json"))) {
    throw new Error(`extension is not built: ${distDir}`);
  }
  const manifest = JSON.parse(await readFile(join(distDir, "manifest.json"), "utf8"));
  const extensionId = extensionIdFromManifest(manifest);
  const chromePath = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), "zody-p1-chrome-"));
  const stateDir = await mkdtemp(join(tmpdir(), "zody-p1-state-"));
  log("chrome:", chromePath);
  log("isolated profile:", userDataDir);
  log("extension id:", extensionId);

  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>Zody P1 Fixture</title></head>" +
        '<body data-marker="p1-fixture"><h1>P1 Fixture</h1></body></html>',
    );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/fixture`;

  const events = {};
  let stores = createExtensionPersistentStores({ userDataPath: stateDir });
  let server = createServerInstance(stores, extensionId, events);
  let { port: bridgePort } = await server.start();
  const ticket = server.beginPairing({ windowId: "p1-smoke" });
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
    const { targetId } = await cdp.send("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html`,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await poll(
      () => evaluate(cdp, sessionId, "document.readyState === 'complete'"),
      20_000,
      "popup document",
    );

    await pairThroughPopup(cdp, sessionId, ticket, bridgePort);
    const connection = await poll(() => server.listConnectedProfiles()[0] ?? null, 20_000, "pair");
    log("paired:", { generation: connection.generation, profile: connection.profileInstanceId });
    events.onAuthenticated = (info) =>
      transport.handleConnectionChanged({ ...info, connected: true });
    events.onDisconnected = (info) =>
      transport.handleConnectionChanged({ ...info, connected: false });
    events.onMessage = (profileInstanceId, message) =>
      transport.handleEvent({ profileInstanceId, message });

    const windowId = "p1-smoke";
    const transport = new RealTransport(server, windowId);
    await transport.listConnections();
    const cdpTransport = new ExtensionCdpTransport({
      request: (message) =>
        transport.request(message.targetRef.browserId.replace(/^extension:/, ""), message),
    });
    const backend = new ExtensionBrowserBackend({
      transport,
      cdp: cdpTransport,
      navigationTimeoutMs: 20_000,
      logger: {
        debug: (...args) => log("backend:", ...args),
        info: (...args) => log("backend:", ...args),
        warn: (...args) => log("backend warn:", ...args),
        error: (...args) => log("backend error:", ...args),
      },
    });
    const context = () => ({
      requestId: randomUUID(),
      sessionId: "p1-smoke-session",
      workspaceKey: "p1-smoke-workspace",
      workspaceIdentity: "p1-smoke-workspace",
      clientMode: "desktop-continuous",
      sessionContext: "live",
      browserId: connection.browserId,
      browserGeneration: connection.generation,
    });

    const list = async () => {
      const response = await server.request(
        connection.profileInstanceId,
        { type: "tabs.list", requestId: randomUUID() },
        10_000,
      );
      if (!response.ok || !response.tabs) throw new Error("tabs.list failed");
      return response.tabs;
    };
    const activeNativeTab = (await list()).find((tab) => tab.active)?.nativeTabId;
    log("active native tab before:", activeNativeTab);

    const discovery = await backend.list(context());
    log(
      "discovery:",
      discovery.map((descriptor) => descriptor.id),
    );
    if (!discovery.some((descriptor) => descriptor.id === connection.browserId)) {
      throw new Error("extension backend missing from discovery");
    }

    const created = await backend.execute(context(), { method: "newTab" });
    if (!created.ok || !created.tab || !created.tab.tabId.startsWith("extab:")) {
      throw new Error(`newTab failed: ${JSON.stringify(created)}`);
    }
    const tab = created.tab;
    log("agent logical tab:", tab.tabId);
    const afterCreate = await list();
    const createdNative = afterCreate.find((candidate) => candidate.url === "about:blank");
    if (!createdNative || createdNative.active !== false) {
      throw new Error(`new tab was not background: ${JSON.stringify(createdNative)}`);
    }
    const agentNativeTabId = createdNative.nativeTabId;
    if (afterCreate.find((candidate) => candidate.active)?.nativeTabId !== activeNativeTab) {
      throw new Error("creating a tab moved Chrome foreground");
    }

    const navigate = await backend.execute(context(), {
      method: "navigate",
      url: fixtureUrl,
      tabId: tab.tabId,
    });
    if (!navigate.ok || navigate.state?.url !== fixtureUrl) {
      throw new Error(`navigate failed: ${JSON.stringify(navigate)}`);
    }
    const state = await backend.execute(context(), { method: "getState", tabId: tab.tabId });
    if (!state.ok || state.state?.title !== "Zody P1 Fixture") {
      throw new Error(`getState failed: ${JSON.stringify(state)}`);
    }
    const screenshot = await backend.execute(context(), {
      method: "screenshot",
      tabId: tab.tabId,
    });
    const png = Buffer.from(screenshot.image?.base64 ?? "", "base64");
    if (!screenshot.ok || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("screenshot is not a PNG");
    }
    log("navigate/getState/screenshot OK", { bytes: png.length, title: state.state.title });

    const afterNavigate = await list();
    if (afterNavigate.find((candidate) => candidate.active)?.nativeTabId !== activeNativeTab) {
      throw new Error("navigation moved Chrome foreground");
    }

    const closed = await backend.execute(context(), { method: "close", tabId: tab.tabId });
    if (!closed.ok) throw new Error(`close failed: ${JSON.stringify(closed)}`);
    const afterClose = await poll(
      async () => {
        const tabs = await list();
        return tabs.some((candidate) => candidate.nativeTabId === agentNativeTabId) ? null : tabs;
      },
      10_000,
      "agent tab removed",
    );
    if (afterClose.find((candidate) => candidate.active)?.nativeTabId !== activeNativeTab) {
      throw new Error("closing a tab moved Chrome foreground");
    }
    log("background close OK");

    // 持久 generation：重启 Main bridge 后真实扩展 resume 必须领取更大代次。
    const firstGeneration = connection.generation;
    await server.stop();
    stores = createExtensionPersistentStores({ userDataPath: stateDir });
    server = createServerInstance(stores, extensionId, events);
    ({ port: bridgePort } = await server.start());
    await reconnectThroughPopup(cdp, sessionId, bridgePort);
    const resumed = await poll(
      () => server.listConnectedProfiles()[0] ?? null,
      30_000,
      "resumed connection",
    );
    log("resumed generation:", resumed.generation);
    if (resumed.generation <= firstGeneration) {
      throw new Error(
        `generation did not increase across restart: ${firstGeneration} -> ${resumed.generation}`,
      );
    }

    console.log(
      "\nP1 SMOKE PASS: background tab + navigate/getState/screenshot + close without foreground switch + persistent generation",
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
    await new Promise((resolve) => fixture.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp profile:", error.message),
    );
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp state:", error.message),
    );
  }
}

main().catch((error) => {
  console.error("\nP1 SMOKE FAIL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
