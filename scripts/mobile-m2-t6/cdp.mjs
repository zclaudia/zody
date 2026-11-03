import WebSocket from "ws";

/**
 * M2-T6 Android WebView CDP 驱动。
 *
 * Playwright 的 `connectOverCDP` 会调用 `Browser.setDownloadBehavior`，Android WebView 不支持；
 * 这里直接连页面 target，只使用 `Runtime.evaluate`。调用方需先执行 `adb forward`。
 */
const devtoolsPort = Number(process.env.ZODY_E2E_DEVTOOLS_PORT || 9222);

export async function listTargets() {
  // force-stop/Activity 重建后 adb forward 会短暂失效；重试避免一次 fetch failed 终止整轮 E2E。
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error("webview devtools target list unavailable");
}

export async function waitForTarget(predicate, timeoutMs = 30000, label = "target") {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await listTargets();
    const found = last.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `timed out waiting for ${label}; targets=${JSON.stringify(last.map((target) => target.url))}`,
  );
}

export class CdpPage {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
    this.ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(JSON.stringify(message.error));
        error.navigation = /navigated or closed/u.test(message.error.message ?? "");
        reject(error);
      } else {
        resolve(message.result);
      }
    });
    // target 被导航/Activity 重建销毁时，未完成的 evaluate 必须 reject，否则顶层 await 会悬空。
    const rejectPending = () => {
      for (const { reject } of this.pending.values()) {
        const error = new Error("target closed");
        error.navigation = true;
        reject(error);
      }
      this.pending.clear();
    };
    this.ws.on("close", rejectPending);
    this.ws.on("error", rejectPending);
  }

  static async connect(predicate, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      const target = await waitForTarget(predicate, Math.max(1000, deadline - Date.now()));
      try {
        const page = new CdpPage(target);
        await page.ready;
        return page;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw lastError ?? new Error("failed to connect to target");
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluate failed: ${result.exceptionDetails.text} ${JSON.stringify(
          result.exceptionDetails.exception?.description ?? "",
        )}`,
      );
    }
    return result.result?.value;
  }

  async waitFor(expression, timeoutMs = 30000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression);
        if (value) return value;
      } catch {
        // 导航期间 execution context 会短暂失效。
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // best-effort
    }
  }
}
