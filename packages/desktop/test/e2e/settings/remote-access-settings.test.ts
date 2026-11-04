/* eslint-disable max-lines -- T4.1 桌面 E2E 覆盖设置页表单、gateway 状态和手机 channel，场景必须共享同一套交互辅助函数。 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  TID_WORKSPACE_ITEM,
  testId,
} from "@zody/shared";
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
import { MOBILE_REMOTE_HISTORY_SEARCH_FIXTURE } from "../helpers/provider-readiness-history-fixture.js";
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
 * `ZODY_GATEWAY_IT_URL` 等凭证时用 `this.skip()` 明确跳过（原因见测试名和 deviations）。
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
const DISCONNECT_CLIENT_BUTTON = "remote-access-disconnect-client";

let gatewayConfig: GatewayE2EConfig | null = null;

// 最近项目不能是当前已打开的 workspace（registry 会排除 openWorkspacePaths），
// 因此单独创建一个未打开目录作为「最近项目」目标。
const RECENT_PROJECT_PATH = join(dirname(DEFAULT_WORKSPACE), "RecentProjectFromPhone");
const MOBILE_FILE_FIXTURE_NAME = "mobile-remote-e2e-fixture.txt";
const MOBILE_FILE_FIXTURE_CONTENT = "mobile-remote-file-rpc-fixture-content";
const MOBILE_HISTORY_SEARCH_QUERY = "mobile-remote-search-snippet-token";

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

async function verifyMobileHtmlWithRealGateway(
  config: GatewayE2EConfig,
  backendId: string,
  fixtureName: string,
  fixtureContent: string,
) {
  const viteServer = await createServer({
    configFile: join(process.cwd(), "../web/vite.config.ts"),
    root: join(process.cwd(), "../web"),
    mode: "development",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let mobileBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Vite did not bind a local mobile-web port");
    }
    mobileBrowser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ZODY_E2E_CHROME_BINARY?.trim() ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    const mobileContext = await mobileBrowser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    try {
      const mobilePage = await mobileContext.newPage();
      await mobilePage.goto(`http://127.0.0.1:${address.port}/mobile.html`, {
        waitUntil: "domcontentloaded",
      });
      await mobilePage.locator('[data-mobile-remote-page="settings"]').waitFor();
      await mobilePage.locator("#mobile-remote-gateway-url").fill(config.gatewayUrl);
      await mobilePage.locator("#mobile-remote-namespace").fill(config.namespace);
      await mobilePage.locator("#mobile-remote-credential").fill(config.deviceCredential);
      await mobilePage.locator('[data-mobile-remote-settings-submit="true"]').click();

      await mobilePage.locator('[data-mobile-remote-page="backend-picker"]').waitFor();
      await mobilePage.locator(`[data-mobile-remote-backend-item="${backendId}"]`).waitFor();
      await mobilePage.locator('[data-mobile-remote-backend-confirm="true"]').click();
      const mobileSearchEntry = mobilePage.getByRole("button", {
        name: /Search history|搜索历史/u,
      });
      try {
        await mobileSearchEntry.waitFor({ timeout: 30000 });
      } catch {
        const pageName = await mobilePage
          .locator("[data-mobile-remote-page]")
          .getAttribute("data-mobile-remote-page")
          .catch(() => "unknown");
        const alertText = await mobilePage
          .getByRole("alert")
          .allTextContents()
          .catch(() => []);
        throw new Error(
          `Real mobile client did not reach home (setup page=${pageName}; alerts=${alertText.join(" | ") || "none"})`,
        );
      }
      await waitForMobileConnected(true);

      await mobileSearchEntry.click();
      await mobilePage.locator('[data-mobile-page="search"]').waitFor();
      await mobilePage
        .getByRole("textbox", {
          name: /Search titles and messages|搜索标题和消息正文/u,
        })
        .fill("no-match-mobile-e2e-query");
      await mobilePage.getByRole("button", { name: /^(Search|搜索)$/u }).click();
      await mobilePage.getByText(/^(No matching tasks|未找到匹配任务)$/u).waitFor();

      await mobilePage
        .getByRole("textbox", {
          name: /Search titles and messages|搜索标题和消息正文/u,
        })
        .fill(MOBILE_HISTORY_SEARCH_QUERY);
      await mobilePage.getByRole("button", { name: /^(Search|搜索)$/u }).click();
      const historyResult = mobilePage
        .getByRole("button")
        .filter({ hasText: MOBILE_REMOTE_HISTORY_SEARCH_FIXTURE.title })
        .filter({ hasText: MOBILE_HISTORY_SEARCH_QUERY });
      await historyResult.waitFor();
      await historyResult.click();
      await mobilePage.locator('[data-mobile-page="chat"]').waitFor();
      await mobilePage
        .getByText(MOBILE_REMOTE_HISTORY_SEARCH_FIXTURE.userText, { exact: true })
        .waitFor();

      await mobilePage.getByRole("button", { name: /^(Back to task home|返回任务首页)$/u }).click();
      await mobilePage
        .locator("li")
        .filter({ hasText: DEFAULT_WORKSPACE })
        .getByRole("button", { name: /^(Files|文件)$/u })
        .first()
        .click();
      await mobilePage.locator('[data-testid="mobile-file-browser"]').waitFor();
      const fixtureRow = mobilePage
        .locator("[data-mobile-file-row]")
        .filter({ hasText: fixtureName });
      await fixtureRow.waitFor();
      await fixtureRow.click();
      await mobilePage.getByText(fixtureContent, { exact: false }).waitFor();

      await mobilePage.getByRole("button", { name: /^(Close|关闭)$/u }).click();
      await mobilePage.getByRole("button", { name: /^(Notifications|通知)$/u }).click();
      await mobilePage.getByText(/^(No notifications|暂无通知)$/u).waitFor();
    } finally {
      await mobileContext.close();
    }
  } finally {
    await mobileBrowser?.close();
    await viteServer.close();
  }
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15000 });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({
    timeout: 15000,
  });
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
      allowMobileOpenArbitraryPath: true,
    },
  });
  await browser.refresh();
  await ensureWorkspaceReady();
  await openRemoteAccessSettings();
  await browser.waitUntil(
    async () => (await $(`[data-testid="${GATEWAY_URL_INPUT}"]`).getValue()) === config.gatewayUrl,
    {
      timeout: 10000,
      timeoutMsg: "隔离 Gateway 地址没有从设置文件加载到远控表单",
    },
  );
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

/** 侧栏入口图标：gateway online 时带 text-success，其余状态置灰（text-foreground-subtle）。 */
async function expectTriggerHighlighted(highlighted: boolean) {
  await browser.waitUntil(
    async () => {
      const isHighlighted = await browser.execute((selector) => {
        const icon = document.querySelector<HTMLElement>(selector)?.querySelector("svg");
        return icon?.classList.contains("text-success") ?? false;
      }, REMOTE_CONTROL_TRIGGER);
      return isHighlighted === highlighted;
    },
    {
      interval: 500,
      timeout: 20000,
      timeoutMsg: `侧栏远控入口没有${highlighted ? "高亮" : "置灰"}`,
    },
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
      remoteAccess: {
        enabled: false,
        gatewayUrl: "",
        namespace: "zcode",
        allowMobileOpenArbitraryPath: true,
      },
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
      {
        interval: 500,
        timeout: 15000,
        timeoutMsg: "保存凭证后状态没有变成已配置",
      },
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
      {
        interval: 500,
        timeout: 15000,
        timeoutMsg: "清除凭证后状态没有变成未配置",
      },
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

  it("RA-SET-08: 未连接 gateway 时侧栏入口置灰，点击跳转设置页远程访问且不弹窗", async () => {
    await expectTriggerHighlighted(false);
    const trigger = await $(REMOTE_CONTROL_TRIGGER);
    await trigger.waitForClickable({ timeout: 20000 });
    await trigger.click();

    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({
      timeout: 15000,
    });
    await $(`[${REMOTE_ACCESS_SETTINGS}]`).waitForDisplayed({ timeout: 15000 });
    // 入口只导航，不改变开关。
    expect(await $(`[data-testid="${TOGGLE}"]`).getAttribute("data-state")).toBe("unchecked");
    expect(await $('[role="dialog"]').isExisting()).toBe(false);
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

  it("RA-SET-06: 手机连接后侧栏入口高亮，点击跳转设置页并可断开手机", async function () {
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
      await expectTriggerHighlighted(true);
      await trigger.click();
      // 入口不弹窗，只落到设置页「远程访问」分区；断开手机在设置页完成。
      await $(`[${REMOTE_ACCESS_SETTINGS}]`).waitForDisplayed({
        timeout: 20000,
      });
      await waitForMobileConnected(true);

      await clickTestIdByDom(DISCONNECT_CLIENT_BUTTON, { timeout: 15000 });
      await waitForMobileConnected(false);
    } finally {
      phone?.close();
      await setRemoteAccessEnabledSafe(false);
    }
  });

  it("RA-SET-07: 手机真实页面搜索、浏览文件和读取通知", async function () {
    const config = requireGatewayConfig(this);
    await mkdir(RECENT_PROJECT_PATH, { recursive: true });
    await mkdir(DEFAULT_WORKSPACE, { recursive: true });
    await writeFile(
      join(DEFAULT_WORKSPACE, MOBILE_FILE_FIXTURE_NAME),
      MOBILE_FILE_FIXTURE_CONTENT,
      "utf8",
    );
    await seedSettings({ recentProjects: [RECENT_PROJECT_PATH] });
    await configureAndEnableRemoteAccess(config, config.backendCredential);
    await waitForGatewayState("online", undefined, 60000);

    let phone: FakePhoneSession | null = null;
    try {
      phone = await connectFakePhone(config, {
        clientInstanceId: "zcode-e2e-phone-recent-project",
        clientName: "E2E Phone",
      });
      const activePhone = phone;
      await waitForMobileConnected(true);

      phone.sendPayload({
        zcode_type: "bootstrap-request",
        requestId: "e2e-bootstrap",
      });
      const bootstrap = await phone.waitForPayload(
        (payload) =>
          payload.zcode_type === "bootstrap-response" && payload.requestId === "e2e-bootstrap",
      );
      const result = bootstrap.result as {
        mobileCapabilities?: {
          historySearch?: number;
          fileBrowser?: number;
          notificationFeed?: number;
        };
        workspaces?: Array<{
          workspacePath: string;
          workspaceIdentity?: string;
        }>;
        recentProjects?: Array<{ id: string; label: string }>;
      };
      expect(result.mobileCapabilities).toMatchObject({
        historySearch: 1,
        fileBrowser: 1,
        notificationFeed: 1,
      });
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

      // Search uses the same per-workspace index path as the phone UI. Query every workspace
      // in the freshly returned scope so this exercises Main -> owning Host routing end to end.
      phone.sendPayload({
        zcode_type: "workspace-list-request",
        requestId: "e2e-workspaces",
      });
      const workspaceResponse = await phone.waitForPayload(
        (payload) =>
          payload.zcode_type === "workspace-list-response" &&
          payload.requestId === "e2e-workspaces",
      );
      const workspaces =
        (
          workspaceResponse.result as {
            workspaces?: Array<{
              workspacePath: string;
              workspaceIdentity?: string;
            }>;
          }
        ).workspaces ??
        result.workspaces ??
        [];
      const workspaceKeys = workspaces
        .map((workspace) => workspace.workspaceIdentity?.trim() || workspace.workspacePath)
        .sort();
      expect(workspaceKeys.length).toBeGreaterThan(0);
      const scopeSignature = JSON.stringify([...new Set(workspaceKeys)]);
      const searchOutcomes = await Promise.all(
        workspaceKeys.map(async (workspaceKey, index) => {
          const requestId = `e2e-search-${index}`;
          const outcomePromise = activePhone.waitForPayload(
            (payload) =>
              payload.zcode_type === "mobile-history-search-outcome" &&
              payload.requestId === requestId,
          );
          activePhone.sendPayload({
            zcode_type: "mobile-history-search-request",
            requestId,
            context: {
              backendId: activePhone.backendId,
              connectionGeneration: 1,
              workspaceKey,
              requestId,
            },
            queryGeneration: 1,
            scopeSignature,
            query: MOBILE_HISTORY_SEARCH_QUERY,
            includeArchived: false,
            limit: 50,
          });
          return outcomePromise;
        }),
      );
      expect(searchOutcomes).toHaveLength(workspaceKeys.length);
      for (const outcome of searchOutcomes) {
        expect(outcome.status).toBe("ok");
        expect(outcome.items).toBeInstanceOf(Array);
      }
      const searchItems = searchOutcomes.flatMap((outcome) =>
        Array.isArray(outcome.items) ? outcome.items : [],
      ) as Array<{
        task?: { taskId?: string; title?: string };
        snippets?: string[];
      }>;
      expect(searchItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            task: expect.objectContaining({
              taskId: MOBILE_REMOTE_HISTORY_SEARCH_FIXTURE.sessionId,
              title: MOBILE_REMOTE_HISTORY_SEARCH_FIXTURE.title,
            }),
            snippets: expect.arrayContaining([
              expect.stringContaining(MOBILE_HISTORY_SEARCH_QUERY),
            ]),
          }),
        ]),
      );

      // 侧边栏 workspace item 的 test id 携带 path；比 header title 更稳定，
      // 也不受新标签页是否立即成为 active tab 影响。
      const openedWorkspaceTestId = testId(TID_WORKSPACE_ITEM, RECENT_PROJECT_PATH);
      await browser.waitUntil(
        async () => (await $(`[data-testid="${openedWorkspaceTestId}"]`)).isExisting(),
        {
          interval: 500,
          timeout: 30000,
          timeoutMsg: "桌面没有新增最近项目标签页",
        },
      );

      // 断开协议级探针后，真实 mobile.html 通过 Playwright 接入同一 Gateway、Main 和 Host。
      // 页面内输入的 credential 仅存在于隔离测试进程，不写日志、报告或截图。
      await openRemoteAccessSettings();
      phone.close();
      phone = null;
      await waitForMobileConnected(false);
      await verifyMobileHtmlWithRealGateway(
        config,
        activePhone.backendId,
        MOBILE_FILE_FIXTURE_NAME,
        MOBILE_FILE_FIXTURE_CONTENT,
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
