import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { GatewayE2EConfig } from "./mobile-remote-gateway.js";
import { resolve } from "node:path";
import { mobileCuaBridgeScript } from "./mobile-cua-url.js";
import { startMobileCuaAssetProxy } from "./mobile-cua-asset-proxy.js";

/** 手机仅附着到已经注册的桌面 Host；调用方负责启动和验证该 Host。 */
export async function openMobileCuaPage(input: {
  backendId: string;
  config: GatewayE2EConfig;
  onStage?: (stage: string) => void;
}): Promise<{
  page: Page;
  proxyStats: { retry429: number };
  close(): Promise<void>;
}> {
  let instance: Browser | undefined;
  let context: BrowserContext | undefined;
  let proxy: Awaited<ReturnType<typeof startMobileCuaAssetProxy>> | undefined;
  try {
    input.onStage?.("browser-launch");
    instance = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ZODY_E2E_CHROME_BINARY?.trim() ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    context = await instance.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      // 仅隔离的测试浏览器使用临时 localhost CA；桌面进程仍需显式信任该 CA。
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    input.onStage?.("browser-context-ready");
    let initNameError = false;
    const diagnostics = {
      socketCreated: 0,
      socketClosed: 0,
      socketErrors: 0,
      cspErrors: 0,
      scriptErrors: 0,
      peerReady: 0,
      gatewayErrors: 0,
      consoleErrorKinds: [] as string[],
    };
    page.on("websocket", (socket) => {
      diagnostics.socketCreated += 1;
      socket.on("close", () => {
        diagnostics.socketClosed += 1;
      });
      socket.on("socketerror", () => {
        diagnostics.socketErrors += 1;
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        try {
          const frame = JSON.parse(payload) as { type?: string };
          if (frame.type === "peer_ready") diagnostics.peerReady += 1;
          if (frame.type === "gateway_error") diagnostics.gatewayErrors += 1;
        } catch {
          /* 不保存任意帧内容。 */
        }
      });
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const value = message.text();
      if (/content security policy|refused to connect/u.test(value.toLowerCase()))
        diagnostics.cspErrors += 1;
      for (const kind of ["TypeError", "ReferenceError", "Invalid URL", "WebSocket", "ERR_CERT"])
        if (value.includes(kind) && !diagnostics.consoleErrorKinds.includes(kind))
          diagnostics.consoleErrorKinds.push(kind);
    });
    page.on("pageerror", (error) => {
      diagnostics.scriptErrors += 1;
      if (/__name.*not defined|Can't find variable: __name/u.test(error.message))
        initNameError = true;
    });
    page.setDefaultTimeout(30_000);
    proxy = await startMobileCuaAssetProxy(input.config, input.backendId);
    const origin = proxy.origin;
    const proxyStats = proxy.stats;
    // 模拟 Android 向 release Remote 提供只读 session context，不修改产品守卫。
    const bridgeContext = {
      schemaVersion: 1,
      sessionId: "cua-mobile-e2e",
      gatewayUrl: input.config.gatewayUrl,
      namespace: input.config.namespace,
      credential: input.config.deviceCredential,
      backendId: input.backendId,
      clientInstanceId: "cua-mobile-e2e-client",
      appVersion: "1.0.0",
      bridgeCapabilities: {
        schemaVersion: 1,
        bridgeVersion: 1,
        appVersion: "1.0.0",
        capabilities: ["session-context"],
      },
    };
    await page.addInitScript({
      content: `(function(){const d={socketAttempts:0,socketThrows:0,rejections:0,errors:0};globalThis.__cuaStartupDiagnostic=d;const Original=globalThis.WebSocket;globalThis.WebSocket=new Proxy(Original,{construct:function(target,args,newTarget){d.socketAttempts++;try{return Reflect.construct(target,args,newTarget)}catch(e){d.socketThrows++;throw e}}});addEventListener('unhandledrejection',function(){d.rejections++});addEventListener('error',function(){d.errors++})})()`,
    });
    // 使用原始 JS 字符串避免测试编译器对闭包注入未绑定的命名辅助函数。
    await page.addInitScript({ content: mobileCuaBridgeScript(bridgeContext) });
    try {
      input.onStage?.("mobile-navigation");
      await page.goto(`${origin}/assets/remote/index.html`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      const secureLoopback = await page.evaluate(
        () => window.isSecureContext && window.location.hostname === "127.0.0.1",
      );
      if (!secureLoopback) throw new Error("Mobile page is not a loopback secure context");
      input.onStage?.("mobile-document-loaded");
      const bridgeReady = await page.evaluate(() => {
        const bridge = (
          globalThis as unknown as {
            ZodyRemoteBridge?: Record<string, unknown>;
          }
        ).ZodyRemoteBridge;
        return Boolean(
          bridge &&
          typeof bridge.getSessionContext === "function" &&
          typeof bridge.returnShell === "function",
        );
      });
      if (!bridgeReady) throw new Error("Mobile test bridge missing");
      input.onStage?.("mobile-bridge-ready");
      await page
        .getByRole("button", { name: /Search history|搜索历史/u })
        .waitFor({ timeout: 60_000 });
      input.onStage?.("mobile-home-ready");
    } catch {
      const screenshotPath = process.env.ZODY_CUA_R1_EVIDENCE_DIR?.trim();
      if (screenshotPath)
        await page
          .screenshot({
            path: resolve(screenshotPath, "mobile-startup-failure.png"),
            timeout: 5_000,
          })
          .catch(() => {});
      const diagnostic = await page
        .locator("body")
        .innerText({ timeout: 5_000 })
        .catch(() => "");
      const bridgePresent = await page
        .evaluate(() =>
          Boolean((globalThis as unknown as { ZodyRemoteBridge?: unknown }).ZodyRemoteBridge),
        )
        .catch(() => false);
      const startupDiagnostic = await page
        .evaluate(
          () =>
            (globalThis as unknown as { __cuaStartupDiagnostic?: unknown })
              .__cuaStartupDiagnostic ?? null,
        )
        .catch(() => null);
      const known = [
        "native-bridge-unavailable",
        "ZodyRemoteBridge is not available",
        "session-context-invalid",
        "bridge-version-unsupported",
        "unsupported-capability",
        "upgrade-required",
        "release-url-unavailable",
        "network-error",
        "http-error",
        "invalid-manifest",
      ].filter((code) => diagnostic.includes(code));
      throw new Error(
        `Mobile startup failed; bridgePresent=${bridgePresent}; initNameError=${initNameError}; diagnostics=${JSON.stringify(diagnostics)}; startupDiagnostic=${JSON.stringify(startupDiagnostic)}; knownCodes=${JSON.stringify(known)}; proxyStats=${JSON.stringify(proxyStats)}`,
      );
    }
    const currentContext = context;
    const currentBrowser = instance;
    const currentProxy = proxy;
    return {
      page,
      proxyStats,
      async close() {
        await currentContext.close();
        await currentBrowser.close();
        await currentProxy.close();
      },
    };
  } catch (error) {
    await context?.close();
    await instance?.close();
    await proxy?.close();
    throw error;
  }
}

/** 只在当前可见手机聊天 pane 命中真实触摸，返回不可变读卡 ID。 */
export async function tapMobileCuaStop(page: Page, expectedRequestId: string) {
  const viewport = page.viewportSize();
  if (
    !viewport ||
    viewport.width !== 390 ||
    !(await page.evaluate(() => navigator.maxTouchPoints > 0))
  )
    throw new Error("Mobile CUA Stop requires a 390px touch viewport");
  const chat = page.locator('[data-mobile-page="chat"]');
  await chat.waitFor({ state: "visible" });
  const card = chat.locator('[data-cua-confirm-kind="read"]').filter({
    has: page.locator('[data-permission-option-kind="rejectOnce"][aria-selected="true"]'),
  });
  await card.first().waitFor({ state: "visible", timeout: 60_000 });
  if ((await card.count()) !== 1 || !(await card.isVisible()))
    throw new Error("Mobile read card is not uniquely visible and default-denied");
  if ((await card.getAttribute("data-permission-request-id")) !== expectedRequestId)
    throw new Error("Mobile read card does not match desktop request");
  const pane = card.locator('xpath=ancestor::*[starts-with(@data-testid,"v4-session-pane-")][1]');
  const stops = pane.locator('[data-testid="v4-stop"]');
  const visible = [];
  for (const stop of await stops.all()) if (await stop.isVisible()) visible.push(stop);
  if (visible.length !== 1 || !(await visible[0]!.isEnabled()))
    throw new Error("Mobile current pane must expose exactly one enabled Stop");
  const box = await visible[0]!.boundingBox();
  if (!box || box.height < 44) throw new Error("Mobile Stop touch target is shorter than 44px");
  await visible[0]!.tap();
  return {
    viewport,
    targetHeight: box.height,
    requestId: expectedRequestId,
    activation: "playwright-tap",
  };
}
