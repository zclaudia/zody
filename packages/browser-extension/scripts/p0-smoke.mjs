/*
 * P0 真实 headed Chrome smoke：
 * 1. 在独立的临时 Profile 中加载扩展（不读取开发者日常 Chrome Profile）。
 * 2. 通过 Zody ExtensionBridgeServer 完成高熵配对。
 * 3. attach 一个测试 tab，执行 Runtime.evaluate。
 * 4. 空闲 2 分钟（不发送任何 CDP 命令）后再次 Runtime.evaluate，验证 offscreen WebSocket
 *    与 chrome.debugger attachment 仍有效。
 *
 * 使用原始 CDP 只驱动 popup 页面；测试 tab 由 Chrome 启动参数打开，避免 Playwright/CDP
 * 先占用它的 debugger，导致 chrome.debugger.attach 失败。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionBridgeServer,
  createInMemoryExtensionCredentialStore,
  createInMemoryExtensionGenerationStore,
} from "../../desktop/src/main/extensionBridge/index.ts";
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
// 默认必须覆盖设计要求的 2 分钟空闲；调试脚本时可用 env 缩短，但正式验收不得设置。
const IDLE_MS = Number(process.env.ZODY_P0_IDLE_MS ?? 120_500);
if (!Number.isFinite(IDLE_MS) || IDLE_MS < 0) {
  throw new Error("ZODY_P0_IDLE_MS must be a non-negative number");
}

async function main() {
  if (!existsSync(join(distDir, "manifest.json"))) {
    throw new Error(
      `extension is not built: ${distDir} (run pnpm --filter @zcode/browser-extension build)`,
    );
  }
  const manifest = JSON.parse(await readFile(join(distDir, "manifest.json"), "utf8"));
  const extensionId = extensionIdFromManifest(manifest);
  const chromePath = await findChromeExecutable();
  const userDataDir = await mkdtemp(join(tmpdir(), "zody-p0-chrome-"));
  if (!userDataDir.startsWith(tmpdir())) {
    throw new Error("refusing to run with a non-temporary Chrome profile");
  }
  log("chrome:", chromePath);
  log("extension id:", extensionId);
  log("isolated profile:", userDataDir);

  const fixture = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>Zody P0 Fixture</title></head>" +
        '<body data-marker="p0-fixture"><h1 id="marker">P0 Fixture</h1></body></html>',
    );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = fixture.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/fixture`;
  log("fixture:", fixtureUrl);

  const detachedEvents = [];
  const server = new ExtensionBridgeServer({
    port: 0,
    expectedExtensionId: extensionId,
    credentialStore: createInMemoryExtensionCredentialStore(),
    generationStore: createInMemoryExtensionGenerationStore(),
    logger: {
      debug: () => undefined,
      info: (...args) => log("bridge:", ...args),
      warn: (...args) => log("bridge warn:", ...args),
      error: (...args) => log("bridge error:", ...args),
    },
    onExtensionMessage: (_profile, message) => {
      if (message.type === "target.detached" || message.type === "target.closed") {
        detachedEvents.push(message);
      }
    },
  });
  const { port: bridgePort } = await server.start();
  const ticket = server.beginPairing({ windowId: "p0-smoke" });
  log("pairing session:", ticket.pairingSessionId);

  const stderr = [];
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    // Chrome 137+ 在 branded 构建默认禁用 --load-extension；测试环境保留该命令行开关。
    "--disable-features=Translate,MediaRouter,DisableLoadExtensionCommandLineSwitch",
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    fixtureUrl,
  ];
  const child = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr.push(text);
    if (stderr.length > 200) stderr.shift();
  });

  let cdp;
  try {
    const { port: devtoolsPort, browserPath } = await readDevToolsPort(userDataDir, child, stderr);
    cdp = await CdpConnection.connect(`ws://127.0.0.1:${devtoolsPort}${browserPath}`);
    log("devtools connected on", devtoolsPort);

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
    // P0 smoke 使用随机端口；扩展默认端口是共享常量，两端必须能一致地覆盖。
    await evaluate(
      cdp,
      sessionId,
      `chrome.storage.local.set({ 'zody.bridgePort': ${bridgePort} })`,
    );
    await evaluate(cdp, sessionId, "document.getElementById('reconnect').click()");

    let shownSession;
    try {
      shownSession = await poll(
        () =>
          evaluate(cdp, sessionId, "document.getElementById('pairing-session')?.textContent || ''"),
        30_000,
        "pairing session in popup",
      );
    } catch (error) {
      await dumpPairingDiagnostics(cdp, sessionId, stderr);
      throw error;
    }
    if (shownSession !== ticket.pairingSessionId) {
      throw new Error(`popup pairing session mismatch: ${shownSession}`);
    }
    log("popup shows the same pairing session id");

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

    const connection = await poll(
      () => server.listConnectedProfiles()[0] ?? null,
      20_000,
      "authenticated extension connection",
    );
    log("paired:", {
      profileInstanceId: connection.profileInstanceId,
      generation: connection.generation,
    });

    const profile = connection.profileInstanceId;
    const tabsResponse = await server.request(
      profile,
      { type: "tabs.list", requestId: randomUUID() },
      10_000,
    );
    if (!tabsResponse.ok || !tabsResponse.tabs) {
      throw new Error(`tabs.list failed: ${JSON.stringify(tabsResponse.failure ?? tabsResponse)}`);
    }
    const fixtureTab = tabsResponse.tabs.find((tab) =>
      tab.url.startsWith(`http://127.0.0.1:${fixturePort}/`),
    );
    if (!fixtureTab) {
      throw new Error(`fixture tab not found in: ${JSON.stringify(tabsResponse.tabs)}`);
    }
    log("fixture native tab:", fixtureTab.nativeTabId);

    const attachResponse = await server.request(
      profile,
      {
        type: "debugger.attach",
        requestId: randomUUID(),
        target: {
          browserId: connection.browserId,
          browserGeneration: connection.generation,
          connectionId: connection.connectionId,
          nativeTabId: fixtureTab.nativeTabId,
          tabClass: "user",
        },
      },
      20_000,
    );
    if (!attachResponse.ok || !attachResponse.attachmentId) {
      throw new Error(
        `debugger.attach failed: ${JSON.stringify(attachResponse.failure ?? attachResponse)}`,
      );
    }
    log("attached:", attachResponse.attachmentId);
    const targetRef = {
      browserId: connection.browserId,
      browserGeneration: connection.generation,
      connectionId: connection.connectionId,
      nativeTabId: fixtureTab.nativeTabId,
      attachmentId: attachResponse.attachmentId,
    };

    const evaluateInTab = async (expression) => {
      const response = await server.request(
        profile,
        {
          type: "cdp.request",
          requestId: randomUUID(),
          targetRef,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        },
        20_000,
      );
      if (!response.ok) {
        throw new Error(
          `Runtime.evaluate failed: ${JSON.stringify(response.error ?? response.failure)}`,
        );
      }
      return response.result?.result?.value;
    };

    const titleBefore = await evaluateInTab("document.title");
    log("Runtime.evaluate before idle:", titleBefore);
    if (titleBefore !== "Zody P0 Fixture") {
      throw new Error(`unexpected fixture title: ${titleBefore}`);
    }

    log(`idling ${IDLE_MS} ms without sending CDP commands...`);
    await sleep(IDLE_MS);

    if (detachedEvents.length > 0) {
      throw new Error(`attachment was detached during idle: ${JSON.stringify(detachedEvents)}`);
    }
    if (!server.isConnected(profile)) {
      throw new Error("extension WebSocket disconnected during idle");
    }
    const stateAfter = await evaluateInTab(
      "({ title: document.title, marker: document.body.dataset.marker })",
    );
    log("Runtime.evaluate after idle:", stateAfter);
    if (stateAfter?.title !== "Zody P0 Fixture" || stateAfter?.marker !== "p0-fixture") {
      throw new Error(`unexpected page state after idle: ${JSON.stringify(stateAfter)}`);
    }

    const detachResponse = await server.request(
      profile,
      { type: "debugger.detach", requestId: randomUUID(), targetRef },
      10_000,
    );
    if (!detachResponse.ok) {
      throw new Error(
        `debugger.detach failed: ${JSON.stringify(detachResponse.failure ?? detachResponse)}`,
      );
    }
    log("detached cleanly");

    console.log("\nP0 SMOKE PASS: pairing + attach + 2 minute idle + Runtime.evaluate");
    process.exitCode = 0;
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(5_000).then(() => child.kill("SIGKILL")),
    ]);
    await server.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => log("warning: failed to remove temp profile:", error.message),
    );
  }
}

async function dumpPairingDiagnostics(cdp, sessionId, stderr) {
  const diagnostics = {
    statusText: await evaluate(
      cdp,
      sessionId,
      "document.getElementById('status')?.textContent",
    ).catch((error) => error.message),
    messageText: await evaluate(
      cdp,
      sessionId,
      "document.getElementById('message')?.textContent",
    ).catch((error) => error.message),
    storage: await evaluate(cdp, sessionId, "chrome.storage.local.get(null)").catch(
      (error) => error.message,
    ),
    targets: await cdp.send("Target.getTargets").catch((error) => error.message),
    chromeStderr: stderr.slice(-20),
  };
  log("pairing diagnostics:", JSON.stringify(diagnostics, null, 2));
  const offscreen = diagnostics.targets?.targetInfos?.find((target) =>
    target.url.endsWith("/offscreen.html"),
  );
  if (!offscreen) return;
  try {
    const { sessionId: offscreenSession } = await cdp.send("Target.attachToTarget", {
      targetId: offscreen.targetId,
      flatten: true,
    });
    const events = [];
    cdp.onEvent = (message) => {
      if (
        message.sessionId === offscreenSession &&
        (message.method === "Runtime.exceptionThrown" ||
          message.method === "Runtime.consoleAPICalled" ||
          message.method === "Log.entryAdded")
      ) {
        events.push(message);
      }
    };
    await cdp.send("Runtime.enable", {}, offscreenSession);
    await cdp.send("Log.enable", {}, offscreenSession);
    await cdp.send("Page.enable", {}, offscreenSession);
    await cdp.send("Page.reload", { ignoreCache: true }, offscreenSession);
    await sleep(3_000);
    const storage = await evaluate(cdp, offscreenSession, "chrome.storage.local.get(null)").catch(
      (error) => error.message,
    );
    log(
      "offscreen diagnostics:",
      JSON.stringify({ storage, events: events.slice(0, 20) }, null, 2),
    );
    cdp.onEvent = null;
  } catch (error) {
    log("offscreen diagnostics failed:", error.message);
  }
}

main().catch((error) => {
  console.error("\nP0 SMOKE FAIL:", error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
