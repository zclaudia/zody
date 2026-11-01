import { EXTENSION_BRIDGE_DEFAULT_PORT } from "@zcode/shared/browser-extension-transport";
import { ExtensionBridgeClient, type BridgeSocketLike } from "./bridgeClient.js";
import { EXTENSION_ID, EXTENSION_VERSION } from "./constants.js";
import { log } from "./log.js";
import { STORAGE_KEYS, type BridgeClientStorage } from "./storage.js";
import {
  isRecord,
  type NativeBridgeMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "./workerProtocol.js";

/**
 * Offscreen document 是唯一 WebSocket 所有者。
 * 它不执行 chrome.tabs/chrome.debugger；这些由 service worker 负责。
 */
async function sendToWorker(message: WorkerRequest): Promise<WorkerResponse> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (isRecord(response) && typeof response.ok === "boolean") {
      return response as unknown as WorkerResponse;
    }
    return { ok: false, error: { message: "service worker did not respond" } };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : "service worker unavailable",
        failureCode: "internal_error",
      },
    };
  }
}

/**
 * 该 Chrome 版本的 offscreen document 不暴露 chrome.storage；持久化统一由
 * service worker 代理，键仍保存在 chrome.storage.local，offscreen 不保留第二份真相。
 */
const storage: BridgeClientStorage = {
  async get<T>(key: string): Promise<T | undefined> {
    const response = await sendToWorker({
      target: "worker",
      op: "storage.get",
      payload: { key },
    });
    if (!response.ok) throw new Error(response.error?.message ?? "storage.get failed");
    return (response.data as { value?: T } | undefined)?.value;
  },
  async set(key: string, value: unknown): Promise<void> {
    const response = await sendToWorker({
      target: "worker",
      op: "storage.set",
      payload: { key, value },
    });
    if (!response.ok) throw new Error(response.error?.message ?? "storage.set failed");
  },
  async remove(key: string): Promise<void> {
    const response = await sendToWorker({
      target: "worker",
      op: "storage.remove",
      payload: { key },
    });
    if (!response.ok) throw new Error(response.error?.message ?? "storage.remove failed");
  },
};

const client = new ExtensionBridgeClient({
  storage,
  extensionId: chrome.runtime.id ?? EXTENSION_ID,
  extensionVersion: EXTENSION_VERSION,
  defaultPort: EXTENSION_BRIDGE_DEFAULT_PORT,
  createSocket: (url) => new WebSocket(url) as unknown as BridgeSocketLike,
  sendToWorker,
  onStatus: (status) => {
    void storage.set(STORAGE_KEYS.status, status);
  },
});

void client.start().catch((error: unknown) => {
  log.error("failed to start bridge client", error instanceof Error ? error.name : "unknown");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRecord(message) || message.target !== "offscreen") return false;
  if (
    message.type === "native.event" ||
    message.type === "native.detached" ||
    message.type === "native.targetClosed" ||
    message.type === "native.claimDecision"
  ) {
    client.handleNativeMessage(message as unknown as NativeBridgeMessage);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "pairing.submit") {
    const pairingCode = typeof message.pairingCode === "string" ? message.pairingCode : "";
    const pairingSessionId =
      typeof message.pairingSessionId === "string" ? message.pairingSessionId : "";
    void client
      .submitPairingCode(pairingCode, pairingSessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: { message: error instanceof Error ? error.message : "pairing failed" },
        });
      });
    return true;
  }
  if (message.type === "reconnect") {
    client.forceReconnect();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
