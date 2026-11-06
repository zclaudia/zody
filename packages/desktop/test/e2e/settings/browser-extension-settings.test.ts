import { createECDH, createHmac } from "node:crypto";
import { createServer } from "node:net";
import { WebSocket } from "ws";
import {
  EXTENSION_BRIDGE_EXTENSION_ID,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  parseExtensionBridgeServerMessage,
  serializeExtensionBridgeMessage,
  type ExtensionBridgeClientMessage,
  type ExtensionBridgeServerMessage,
} from "@zody/shared/browser-extension-transport";
import {
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zody/shared";
import {
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";
import { sel } from "../helpers/selectors.js";

/**
 * P3b：真实 Desktop Main controller + typed IPC + 设置页 UI。
 *
 * Chrome 扩展本身用协议级 fake WebSocket 代替（明确 fake 边界），但配对、hello、
 * proof、welcome、Profile 展示和撤销都走真实 ExtensionBridgeController；真实 Chrome
 * 生命周期继续由 P3a smoke 覆盖，不能把本测试当成真实 Chrome 已验收。
 */

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function readTestIdText(testIdValue: string): Promise<string | null> {
  return browser.execute((id) => {
    const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return node?.textContent ?? null;
  }, testIdValue);
}

function isTestIdExisting(testIdValue: string): Promise<boolean> {
  return browser.execute(
    (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
    testIdValue,
  );
}

class FakeChromeExtension {
  private readonly socket: WebSocket;
  private readonly received: ExtensionBridgeServerMessage[] = [];
  private readonly waiters: Array<{
    type: ExtensionBridgeServerMessage["type"];
    resolve: (message: ExtensionBridgeServerMessage) => void;
  }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `chrome-extension://${EXTENSION_BRIDGE_EXTENSION_ID}` },
    });
    this.socket.on("message", (data) => {
      const message = parseExtensionBridgeServerMessage(data.toString());
      this.received.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (index >= 0) this.waiters.splice(index, 1)[0]?.resolve(message);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
  }

  send(message: ExtensionBridgeClientMessage): void {
    this.socket.send(serializeExtensionBridgeMessage(message));
  }

  next<T extends ExtensionBridgeServerMessage["type"]>(
    type: T,
  ): Promise<Extract<ExtensionBridgeServerMessage, { type: T }>> {
    const existing = this.received.find((message) => message.type === type);
    if (existing) {
      this.received.splice(this.received.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ExtensionBridgeServerMessage, { type: T }>);
    }
    return new Promise((resolve) => {
      this.waiters.push({
        type,
        resolve: (message) =>
          resolve(message as Extract<ExtensionBridgeServerMessage, { type: T }>),
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function pairFakeExtension(port: number, pairingCode: string): Promise<FakeChromeExtension> {
  const client = new FakeChromeExtension(port);
  await client.open();
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  client.send({
    type: "hello",
    protocolVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    extensionId: EXTENSION_BRIDGE_EXTENSION_ID,
    extensionVersion: "0.1.0",
    profileInstanceId: `e2e-profile-${Date.now()}`,
    clientPublicKey: ecdh.getPublicKey("base64url", "uncompressed"),
  });
  const required = await client.next("pairing.required");
  const proof = createHmac("sha256", pairingCode)
    .update(required.nonce, "utf8")
    .digest("base64url");
  client.send({
    type: "pairing.proof",
    pairingSessionId: required.pairingSessionId,
    nonce: required.nonce,
    proof,
  });
  await client.next("welcome");
  return client;
}

describe("Chrome extension browser settings E2E", () => {
  let fakeExtension: FakeChromeExtension | undefined;

  afterEach(() => {
    fakeExtension?.close();
    fakeExtension = undefined;
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForDefaultWorkspaceReady(60000);
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    await $(sel(testId(TID_SETTINGS_SECTION_NAV, "browser"))).click();
    await $('[data-testid="browser-extension-settings"]').waitForDisplayed({ timeout: 15000 });
  });

  it("pairs a fake extension through the real Main controller, then revokes it", async function () {
    this.timeout(90000);
    // 端口占用时不能自动扫描；先通过设置页切到一个空闲端口，同时覆盖 Main 先重启再持久化。
    const port = await reserveFreePort();
    await setInputValueByTestIdDom("browser-extension-port-input", String(port), {
      timeout: 10000,
      timeoutMsg: "没有找到 bridge 端口输入框",
    });
    await clickTestIdByDom("browser-extension-port-save", { timeout: 10000 });
    await browser.waitUntil(
      async () => (await readTestIdText("browser-extension-status"))?.includes("listening"),
      { timeout: 15000, timeoutMsg: "Bridge 没有在新端口就绪" },
    );

    await clickTestIdByDom("browser-extension-begin-pairing", { timeout: 10000 });
    await $('[data-testid="browser-extension-pairing-code"]').waitForDisplayed({
      timeout: 10000,
    });
    const pairingCode = (await readTestIdText("browser-extension-pairing-code"))?.trim();
    if (!pairingCode) throw new Error("设置页没有展示配对码");

    fakeExtension = await pairFakeExtension(port, pairingCode);

    await browser.waitUntil(
      async () => {
        const status = await readTestIdText("browser-extension-status");
        if (!status) return false;
        return await browser.execute(() =>
          Array.from(document.querySelectorAll("[data-testid^='browser-extension-profile-']")).some(
            (node) =>
              node.textContent?.includes("Connected") || node.textContent?.includes("已连接"),
          ),
        );
      },
      { timeout: 20000, timeoutMsg: "配对成功后没有出现已连接的 Profile" },
    );

    expect(await isTestIdExisting("browser-extension-pairing-code")).toBe(false);

    // 默认 backend 只写当前窗口 owner；选择后通过同一 IPC 读回，并验证 renderer reload 不丢。
    const browserId = await browser.execute(async () => {
      const bridge = (
        window as Window & {
          zody?: {
            getBrowserExtensionStatus?: () => Promise<{
              profiles: Array<{ browserId: string }>;
            } | null>;
          };
        }
      ).zody;
      const status = await bridge?.getBrowserExtensionStatus?.();
      return status?.profiles[0]?.browserId ?? null;
    });
    if (!browserId) throw new Error("没有读到当前窗口的 Profile browserId");
    await clickTestIdByDom("browser-extension-default-select", { timeout: 10000 });
    await clickTestIdByDom(`browser-extension-default-option-${browserId}`, { timeout: 10000 });
    await browser.waitUntil(
      async () =>
        (await browser.execute(async () => {
          const bridge = (
            window as Window & {
              zody?: {
                getBrowserExtensionStatus?: () => Promise<{
                  defaultBrowserId?: string;
                } | null>;
              };
            }
          ).zody;
          return (await bridge?.getBrowserExtensionStatus?.())?.defaultBrowserId;
        })) === browserId,
      { timeout: 15000, timeoutMsg: "窗口默认 backend 没有写回 Main" },
    );

    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);
    const afterReload = await browser.execute(async () => {
      const bridge = (
        window as Window & {
          zody?: {
            getBrowserExtensionStatus?: () => Promise<{
              defaultBrowserId?: string;
            } | null>;
          };
        }
      ).zody;
      return (await bridge?.getBrowserExtensionStatus?.())?.defaultBrowserId;
    });
    expect(afterReload).toBe(browserId);

    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
    await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
    await $(sel(testId(TID_SETTINGS_SECTION_NAV, "browser"))).click();
    await $('[data-testid="browser-extension-settings"]').waitForDisplayed({ timeout: 15000 });

    await clickTestIdByDom("browser-extension-revoke", { timeout: 10000 });
    await clickTestIdByDom("browser-extension-revoke-confirm", { timeout: 10000 });
    await browser.waitUntil(
      async () =>
        !(await browser.execute(() =>
          Boolean(document.querySelector("[data-testid^='browser-extension-profile-']")),
        )),
      { timeout: 15000, timeoutMsg: "撤销后 Profile 仍然存在" },
    );
    const defaultAfterRevoke = await browser.execute(async () => {
      const bridge = (
        window as Window & {
          zody?: {
            getBrowserExtensionStatus?: () => Promise<{
              defaultBrowserId?: string;
            } | null>;
          };
        }
      ).zody;
      return (await bridge?.getBrowserExtensionStatus?.())?.defaultBrowserId;
    });
    // WebDriver 把 undefined 序列化为 null。
    expect(defaultAfterRevoke).toBeNull();
  });
});
