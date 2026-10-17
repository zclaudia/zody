/* eslint-disable max-lines -- T4.1 桌面 E2E 覆盖设置页表单、gateway 状态和手机 channel，场景必须共享同一套交互辅助函数。 */
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readSettings,
  seedSettings,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../helpers/desktop-app.js";
import { dismissOccupationOnboarding } from "../helpers/occupation-onboarding.js";
import { waitForToastContaining } from "../helpers/conversation-session-toast.js";
import { loginWithApiKey } from "../helpers/v4-conversation.js";
import {
  connectFakePhone,
  resolveGatewayE2EConfig,
  type FakePhoneSession,
  type GatewayE2EConfig,
} from "../helpers/mobile-remote-gateway.js";

/**
 * RC-E2E-REMOTE-ACCESS-01（T4.1）：桌面设置页的远程访问配置、状态与手机链路。
 *
 * 表单、开关和「测试连接」不依赖真实 gateway；gateway 相关场景在没有
 * `ZCODE_GATEWAY_IT_URL` 等凭证时用 `this.skip()` 明确跳过（原因见测试名和 deviations）。
 */

const REMOTE_ACCESS_SETTINGS = 'data-testid="remote-access-settings"';
const GATEWAY_URL_INPUT = "remote-access-gateway-url";
const NAMESPACE_INPUT = "remote-access-namespace";
const CREDENTIAL_INPUT = "remote-access-credential";
const SAVE_CONFIG_BUTTON = "remote-access-save-config";
const SAVE_CREDENTIAL_BUTTON = "remote-access-save-credential";
const CLEAR_CREDENTIAL_BUTTON = "remote-access-clear-credential";
const CREDENTIAL_STATUS = "remote-access-credential-status";
const TOGGLE = "remote-access-toggle";
const GATEWAY_STATUS = "remote-access-gateway-status";
const MOBILE_STATUS = "remote-access-mobile-status";
const TEST_CONNECTION_BUTTON = "remote-access-test-connection";

const REMOTE_CONTROL_TRIGGER =
  'button[aria-label="移动端远程控制"], button[aria-label="Mobile remote control"]';
const DIALOG_SCROLL = '[data-testid="web-remote-control-dialog-scroll"]';
const DIALOG_MOBILE_STATUS = '[data-testid="web-remote-control-mobile-status"]';
const DIALOG_DISCONNECT_CLIENT = '[data-testid="web-remote-control-disconnect-client"]';

let gatewayConfig: GatewayE2EConfig | null = null;

// 最近项目不能是当前已打开的 workspace（registry 会排除 openWorkspacePaths），
// 因此单独创建一个未打开目录作为「最近项目」目标。
const RECENT_PROJECT_PATH = join(dirname(DEFAULT_WORKSPACE), "RecentProjectFromPhone");

async function setInputValue(testIdValue: string, value: string) {
  await setInputValueByTestIdDom(testIdValue, value, {
    timeout: 10000,
    timeoutMsg: `没有找到输入框 ${testIdValue}`,
  });
}

/**
 * browser.refresh 后偶发回到 API Key 欢迎页（隔离 profile 的登录态丢失）。
 * 先等工作区，失败时按真实 UI 走一次 API Key 登录再等。
 */
async function ensureWorkspaceReady(allowLoginRetry = true) {
  try {
    await waitForDefaultWorkspaceReady(60000);
    return;
  } catch (error) {
    if (!allowLoginRetry || !(await $('[data-testid="login-use-api-key-button"]').isExisting())) {
      throw error;
    }
  }
  await loginWithApiKey();
  await ensureWorkspaceReady(false);
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15000 });
}

async function openRemoteAccessSettings() {
  await openSettings();
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"), {
    timeout: 15000,
  });
  await $(`[${REMOTE_ACCESS_SETTINGS}]`).waitForDisplayed({ timeout: 15000 });
}

async function closeSettings() {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15000 });
}

async function saveCredential(credential: string) {
  await setInputValue(CREDENTIAL_INPUT, credential);
  await clickTestIdByDom(SAVE_CREDENTIAL_BUTTON, { timeout: 15000 });
  await waitForToastContaining(["凭证已保存", "凭证格式不正确"]);
}

/**
 * E2E 的桌面产物按 production 模式构建，renderer 的 `isLocalDevelopmentRuntime` 为 false，
 * 因此表单会拒绝本地 gateway 的 http 地址；Main 在未打包运行时仍允许 http。
 * gateway 场景通过 seedSettings 写入地址，再走真实的凭证保存、测试连接和开关链路。
 */
async function seedRemoteAccessConfig(config: GatewayE2EConfig) {
  await seedSettings({
    remoteAccess: {
      enabled: false,
      gatewayUrl: config.gatewayUrl,
      namespace: config.namespace,
    },
  });
  await browser.refresh();
  await ensureWorkspaceReady();
  await openRemoteAccessSettings();
  expect(await $(`[data-testid="${GATEWAY_URL_INPUT}"]`).getValue()).toBe(config.gatewayUrl);
}

async function setRemoteAccessEnabled(enabled: boolean) {
  // 保存凭证/配置后 Switch 会短暂进入 disabled（pending 未清理），直接 click 会被忽略。
  await browser.waitUntil(async () => $(`[data-testid="${TOGGLE}"]`).isEnabled(), {
    timeout: 15000,
    timeoutMsg: "远程访问开关一直处于禁用状态",
  });
  const toggle = await $(`[data-testid="${TOGGLE}"]`);
  const state = await toggle.getAttribute("data-state");
  if ((state === "checked") !== enabled) {
    await toggle.click();
  }
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${TOGGLE}"]`).getAttribute("data-state")) ===
      (enabled ? "checked" : "unchecked"),
    {
      timeout: 15000,
      timeoutMsg: `远程访问开关没有变成 ${enabled ? "开启" : "关闭"}`,
    },
  );
}

async function waitForGatewayState(state: string, reason?: string, timeout = 30000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const gateway = await $(`[data-testid="${GATEWAY_STATUS}"]`);
      if ((await gateway.getAttribute("data-state")) !== state) {
        return false;
      }
      if (!reason) {
        return true;
      }
      return (await gateway.getAttribute("data-reason")) === reason;
    },
    {
      interval: 500,
      timeout,
      timeoutMsg: `gateway 状态没有变成 ${state}${reason ? `(${reason})` : ""}`,
    },
  );
}

async function waitForMobileConnected(connected: boolean, timeout = 30000): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${MOBILE_STATUS}"]`).getAttribute("data-connected")) ===
      String(connected),
    { interval: 500, timeout, timeoutMsg: `手机连接状态没有变成 ${connected}` },
  );
}

async function configureAndEnableRemoteAccess(config: GatewayE2EConfig, credential: string) {
  await seedRemoteAccessConfig(config);
  await saveCredential(credential);
  await setRemoteAccessEnabled(true);
}

function requireGatewayConfig(testContext: Mocha.Context): GatewayE2EConfig {
  if (!gatewayConfig) {
    testContext.skip();
    // this.skip() 在 Mocha 中会抛控制流异常；这一行只用于类型收窄。
    throw new Error("missing gateway e2e config");
  }
  return gatewayConfig;
}

describe("桌面设置页远程访问", () => {
  before(async () => {
    gatewayConfig = await resolveGatewayE2EConfig();
  });

  beforeEach(async () => {
    await dismissOccupationOnboarding();
    await seedSettings({
      locale: "zh-CN",
      localePreference: "zh-CN",
      remoteAccess: { enabled: false, gatewayUrl: "", namespace: "zcode" },
    });
    await browser.refresh();
    await ensureWorkspaceReady();
  });

  it("RA-SET-01: 设置页展示远程访问字段，非法地址不会写入设置", async () => {
    await openRemoteAccessSettings();

    expect(await $(`[data-testid="${GATEWAY_URL_INPUT}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${NAMESPACE_INPUT}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${CREDENTIAL_INPUT}"]`).isDisplayed()).toBe(true);
    expect(await $(`[data-testid="${TEST_CONNECTION_BUTTON}"]`).isDisplayed()).toBe(true);

    await setInputValue(GATEWAY_URL_INPUT, "not-a-url");
    await clickTestIdByDom(SAVE_CONFIG_BUTTON, { timeout: 15000 });
    await waitForToastContaining("请输入有效的 http(s) gateway 地址");

    const settings = await readSettings();
    expect(settings.remoteAccess?.gatewayUrl ?? "").toBe("");
  });

  it("RA-SET-02: 凭证格式校验，且凭证只写入 Main 不进入 settings", async () => {
    await openRemoteAccessSettings();

    await setInputValue(CREDENTIAL_INPUT, "zgd_wrong_kind");
    await clickTestIdByDom(SAVE_CREDENTIAL_BUTTON, { timeout: 15000 });
    await waitForToastContaining("凭证格式不正确");

    await saveCredential("zgb_e2e_only_credential");
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${CREDENTIAL_STATUS}"]`).getAttribute("data-configured")) ===
        "true",
      { interval: 500, timeout: 15000, timeoutMsg: "保存凭证后状态没有变成已配置" },
    );
    expect(await $(`[data-testid="${CREDENTIAL_INPUT}"]`).getValue()).toBe("");

    const settings = await readSettings();
    expect(JSON.stringify(settings)).not.toContain("zgb_e2e_only_credential");
    expect(settings.remoteAccess?.gatewayUrl ?? "").toBe("");

    await clickTestIdByDom(CLEAR_CREDENTIAL_BUTTON, { timeout: 15000 });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${CREDENTIAL_STATUS}"]`).getAttribute("data-configured")) ===
        "false",
      { interval: 500, timeout: 15000, timeoutMsg: "清除凭证后状态没有变成未配置" },
    );
  });

  it("RA-SET-03: 配置不完整时开启远程访问显示 unconfigured", async () => {
    await openRemoteAccessSettings();

    await setRemoteAccessEnabled(true);
    await waitForGatewayState("error", "unconfigured");
    expect(await $(`[data-testid="${TOGGLE}"]`).getAttribute("data-state")).toBe("checked");

    await setRemoteAccessEnabled(false);
    await waitForGatewayState("disabled");
  });

  it("RA-SET-04: 保存配置和凭证后连接状态变为 online", async function () {
    const config = requireGatewayConfig(this);
    await seedRemoteAccessConfig(config);
    await saveCredential(config.backendCredential);

    // 「测试连接」使用当前表单值和已保存凭证，不应改动开关或持久化配置。
    await clickTestIdByDom(TEST_CONNECTION_BUTTON, { timeout: 15000 });
    await waitForToastContaining("Gateway 连接成功");
    expect((await readSettings()).remoteAccess?.enabled).toBe(false);

    await setRemoteAccessEnabled(true);
    await waitForGatewayState("online", undefined, 60000);

    const settings = await readSettings();
    expect(settings.remoteAccess?.enabled).toBe(true);
    expect(settings.remoteAccess?.gatewayUrl).toBe(config.gatewayUrl);
    expect(settings.remoteAccess?.namespace).toBe(config.namespace);
  });

  it("RA-SET-05: 凭证错误时显示 credential-invalid", async function () {
    const config = requireGatewayConfig(this);
    await configureAndEnableRemoteAccess(config, "zgb_e2e_invalid_credential");
    await waitForGatewayState("error", "credential-invalid", 60000);

    // 恢复正确凭证，避免影响同文件后续手机场景。
    await saveCredential(config.backendCredential);
    await setRemoteAccessEnabled(false);
    await waitForGatewayState("disabled");
  });

  it("RA-SET-06: 手机连接后弹层显示已连接，断开手机生效", async function () {
    const config = requireGatewayConfig(this);
    await configureAndEnableRemoteAccess(config, config.backendCredential);
    await waitForGatewayState("online", undefined, 60000);

    let phone: FakePhoneSession | null = null;
    try {
      phone = await connectFakePhone(config, {
        clientInstanceId: "zcode-e2e-phone-disconnect",
        clientName: "E2E Phone",
      });
      await waitForMobileConnected(true);

      // 有手机连接时「测试连接」必须禁用并说明原因。
      expect(
        await $(`[data-testid="${TEST_CONNECTION_BUTTON}"]`).getAttribute("disabled"),
      ).not.toBeNull();

      await closeSettings();
      const trigger = await $(REMOTE_CONTROL_TRIGGER);
      await trigger.waitForClickable({ timeout: 20000 });
      await trigger.click();
      await $(DIALOG_SCROLL).waitForDisplayed({ timeout: 20000 });
      await browser.waitUntil(
        async () => (await $(DIALOG_MOBILE_STATUS).getAttribute("data-connected")) === "true",
        { interval: 500, timeout: 20000, timeoutMsg: "弹层没有显示手机已连接" },
      );

      await $(DIALOG_DISCONNECT_CLIENT).click();
      await browser.waitUntil(
        async () => (await $(DIALOG_MOBILE_STATUS).getAttribute("data-connected")) === "false",
        { interval: 500, timeout: 20000, timeoutMsg: "断开手机后弹层仍显示已连接" },
      );
    } finally {
      phone?.close();
      await setRemoteAccessEnabledSafe(false);
    }
  });

  it("RA-SET-07: 手机请求打开最近项目后桌面新增标签页", async function () {
    const config = requireGatewayConfig(this);
    await mkdir(RECENT_PROJECT_PATH, { recursive: true });
    await seedSettings({ recentProjects: [RECENT_PROJECT_PATH] });
    await configureAndEnableRemoteAccess(config, config.backendCredential);
    await waitForGatewayState("online", undefined, 60000);

    let phone: FakePhoneSession | null = null;
    try {
      phone = await connectFakePhone(config, {
        clientInstanceId: "zcode-e2e-phone-recent-project",
        clientName: "E2E Phone",
      });
      await waitForMobileConnected(true);

      phone.sendPayload({ zcode_type: "bootstrap-request", requestId: "e2e-bootstrap" });
      const bootstrap = await phone.waitForPayload(
        (payload) =>
          payload.zcode_type === "bootstrap-response" && payload.requestId === "e2e-bootstrap",
      );
      const result = bootstrap.result as {
        recentProjects?: Array<{ id: string; label: string }>;
      };
      const project = result.recentProjects?.find(
        (candidate) => candidate.label === basename(RECENT_PROJECT_PATH),
      );
      if (!project) {
        this.skip();
      }

      phone.sendPayload({
        zcode_type: "workspace-open-request",
        requestId: "e2e-open-recent",
        recentProjectId: project.id,
      });
      const openResponse = await phone.waitForPayload(
        (payload) =>
          payload.zcode_type === "workspace-open-response" &&
          payload.requestId === "e2e-open-recent",
      );
      expect(openResponse.success).toBe(true);

      // 侧边栏 workspace item 的 test id 携带 path；比 header title 更稳定，
      // 也不受新标签页是否立即成为 active tab 影响。
      const openedWorkspaceTestId = testId(TID_WORKSPACE_ITEM, RECENT_PROJECT_PATH);
      await browser.waitUntil(
        async () => (await $(`[data-testid="${openedWorkspaceTestId}"]`)).isExisting(),
        { interval: 500, timeout: 30000, timeoutMsg: "桌面没有新增最近项目标签页" },
      );
    } finally {
      phone?.close();
      await setRemoteAccessEnabledSafe(false);
    }
  });
});

async function setRemoteAccessEnabledSafe(enabled: boolean) {
  try {
    if (await $(`[data-testid="${TOGGLE}"]`).isExisting()) {
      await setRemoteAccessEnabled(enabled);
    }
  } catch {
    // 清理失败不覆盖测试主断言。
  }
}
