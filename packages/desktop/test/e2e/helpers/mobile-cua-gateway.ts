import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zody/shared";
import { clickTestIdByDom, readSettings, setInputValueByTestIdDom } from "./desktop-app.js";
import type { GatewayE2EConfig } from "./mobile-remote-gateway.js";
import { GatewayClient } from "@zclaudia/gateway-client";

/** 配置当前桌面唯一 Host 的 gateway；凭证只通过现有设置界面保存。 */
export async function configureMobileGateway(config: GatewayE2EConfig) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({
    timeout: 15_000,
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"), {
    timeout: 15_000,
  });
  await $('[data-testid="remote-access-settings"]').waitForDisplayed({
    timeout: 15_000,
  });
  await setInputValueByTestIdDom("remote-access-gateway-url", config.gatewayUrl, {
    timeout: 15_000,
  });
  await setInputValueByTestIdDom("remote-access-namespace", config.namespace, {
    timeout: 15_000,
  });
  await clickTestIdByDom("remote-access-save-config", { timeout: 15_000 });
  await browser.waitUntil(
    async () => {
      const settings = await readSettings();
      return (
        settings.remoteAccess?.gatewayUrl === config.gatewayUrl &&
        settings.remoteAccess?.namespace === config.namespace
      );
    },
    { timeout: 15_000, timeoutMsg: "Remote gateway config not persisted" },
  );
  await browser.waitUntil(
    async () => (await $('[data-testid="remote-access-save-config"]')).isEnabled(),
    { timeout: 15_000 },
  );
  await setInputValueByTestIdDom("remote-access-credential", config.backendCredential, {
    timeout: 15_000,
  });
  await clickTestIdByDom("remote-access-save-credential", { timeout: 15_000 });
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="remote-access-credential-status"]').getAttribute(
        "data-configured",
      )) === "true",
    { timeout: 15_000, timeoutMsg: "Desktop backend credential was not saved" },
  );
  const client = new GatewayClient({
    url: config.gatewayUrl,
    credential: config.deviceCredential,
    namespace: config.namespace,
    reconnect: false,
  });
  const before = new Set(
    (await client.discoverBackends()).filter((x) => x.online).map((x) => x.backendId),
  );
  const toggle = await $('[data-testid="remote-access-toggle"]');
  await browser.waitUntil(() => toggle.isEnabled(), { timeout: 15_000 });
  if ((await toggle.getAttribute("data-state")) !== "checked") await toggle.click();
  await browser.waitUntil(async () => (await toggle.getAttribute("data-state")) === "checked", {
    timeout: 15_000,
    timeoutMsg: "Desktop remote toggle did not accept click",
  });
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="remote-access-gateway-status"]').getAttribute("data-state")) ===
      "online",
    { timeout: 60_000, timeoutMsg: "Desktop gateway did not become online" },
  );
  let added: string[] = [];
  await browser.waitUntil(
    async () => {
      added = (await client.discoverBackends())
        .filter((x) => x.online && !before.has(x.backendId))
        .map((x) => x.backendId);
      if (added.length > 1) throw new Error("Ambiguous new desktop backend identities");
      return added.length === 1;
    },
    { timeout: 30_000, timeoutMsg: "New candidate backend not discovered" },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  return added[0]!;
}
