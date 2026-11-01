import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

export function log(...args) {
  console.log(`[p0-smoke ${new Date().toISOString()}]`, ...args);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extensionIdFromManifest(manifest) {
  const hash = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

export async function findChromeExecutable() {
  const explicit = process.env.ZODY_SMOKE_CHROME_PATH?.trim();
  if (explicit) {
    if (!existsSync(explicit))
      throw new Error(`ZODY_SMOKE_CHROME_PATH does not exist: ${explicit}`);
    return explicit;
  }
  const cacheRoot =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? join(homedir(), "AppData", "Local", "ms-playwright")
        : join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cacheRoot)) {
    const entries = await readdir(cacheRoot).catch(() => []);
    const chromiumDirs = entries
      .filter((entry) => entry.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const entry of chromiumDirs) {
      const candidates =
        process.platform === "darwin"
          ? [
              join(
                cacheRoot,
                entry,
                "chrome-mac-arm64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
              ),
              join(
                cacheRoot,
                entry,
                "chrome-mac-x64",
                "Google Chrome for Testing.app",
                "Contents",
                "MacOS",
                "Google Chrome for Testing",
              ),
            ]
          : process.platform === "win32"
            ? [
                join(cacheRoot, entry, "chrome-win64", "chrome.exe"),
                join(cacheRoot, entry, "chrome-win", "chrome.exe"),
              ]
            : [
                join(cacheRoot, entry, "chrome-linux64", "chrome"),
                join(cacheRoot, entry, "chrome-linux", "chrome"),
              ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const standard =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of standard) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome/Chrome for Testing executable found; set ZODY_SMOKE_CHROME_PATH");
}

export class CdpConnection {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (this.onEvent) this.onEvent(message);
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close() {
    this.socket.close();
  }
}

export async function readDevToolsPort(userDataDir, child, stderr) {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chrome exited during startup (code ${child.exitCode}): ${stderr.join("")}`);
    }
    if (existsSync(portFile)) {
      const [portLine, pathLine] = (await readFile(portFile, "utf8")).trim().split("\n");
      if (portLine && pathLine) {
        return { port: Number.parseInt(portLine, 10), browserPath: pathLine };
      }
    }
    await sleep(200);
  }
  throw new Error(`Chrome did not expose a DevTools port: ${stderr.join("")}`);
}

export async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (response.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`,
    );
  }
  return response.result?.value;
}

export async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
