import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  clickTestIdByDom,
  seedSettings,
  setInputValueByTestIdDom,
  DEFAULT_WORKSPACE,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { dismissOccupationOnboarding } from "../../../helpers/occupation-onboarding.js";
import { loginWithApiKey } from "../../../helpers/v4-conversation.js";
import {
  createSSHLifecycleProvider,
  connectSSHWorkspaceAndSendFirstTurn,
  reconnectSSHWorkspace,
  waitForRemoteWorkspaceDisconnected,
  type SSHLifecycleProvider,
} from "../../../helpers/ssh-remote-lifecycle.js";
import { waitForRemoteTab, type SSHConnectionConfig } from "../../../helpers/ssh-remote-p0.js";
import {
  resolveGatewayE2EConfig,
  type GatewayE2EConfig,
} from "../../../helpers/mobile-remote-gateway.js";

const CASE_MARKER = "E2E_MOBILE_P8_SSH_REMOTE";
const SETTINGS = 'data-testid="remote-access-settings"';
const GATEWAY_URL_INPUT = "remote-access-gateway-url";
const CREDENTIAL_INPUT = "remote-access-credential";
const SAVE_CREDENTIAL_BUTTON = "remote-access-save-credential";
const CREDENTIAL_STATUS = "remote-access-credential-status";
const TOGGLE = "remote-access-toggle";
const GATEWAY_STATUS = "remote-access-gateway-status";
const WORKSPACE_PATH = process.env.ZCODE_E2E_P8_REMOTE_WORKSPACE?.trim() ?? "";
const SSH_CONTAINER = process.env.ZCODE_E2E_P8_SSH_CONTAINER?.trim() ?? "";

let gatewayConfig: GatewayE2EConfig | null = null;
let provider: SSHLifecycleProvider | null = null;
let sshConfig: SSHConnectionConfig | null = null;

describe("P8 mobile remote SSH workspace", () => {
  before(async () => {
    gatewayConfig = await resolveGatewayE2EConfig();
  });

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    provider = null;
    await browser.electron.restoreAllMocks();
  });

  it("P8-R01/02 通过 Gateway 搜索和浏览 SSH workspace，断开后更新附件并重读", async function () {
    if (!gatewayConfig || !WORKSPACE_PATH || !SSH_CONTAINER) this.skip();
    const passwordFile = process.env.ZCODE_E2E_P8_SSH_PASSWORD_FILE?.trim();
    if (!passwordFile) this.skip();
    const password = (await readFile(passwordFile, "utf8")).trim();
    sshConfig = {
      host: process.env.ZCODE_E2E_P8_SSH_HOST ?? "127.0.0.1",
      port: Number(process.env.ZCODE_E2E_P8_SSH_PORT),
      username: process.env.ZCODE_E2E_P8_SSH_USERNAME ?? "root",
      password,
    };
    const gateway = gatewayConfig;

    await dismissOccupationOnboarding();
    await seedSettings({
      remoteAccess: {
        enabled: false,
        gatewayUrl: gateway.gatewayUrl,
        namespace: gateway.namespace,
        allowMobileOpenArbitraryPath: true,
      },
    });
    await browser.refresh();
    await ensureWorkspaceReady();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"));
    await $(`[${SETTINGS}]`).waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${GATEWAY_URL_INPUT}"]`).getValue()) === gateway.gatewayUrl,
      { timeout: 10_000, timeoutMsg: "isolated Gateway URL did not load" },
    );
    await setInputValueByTestIdDom(CREDENTIAL_INPUT, gateway.backendCredential);
    await clickTestIdByDom(SAVE_CREDENTIAL_BUTTON);
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${CREDENTIAL_STATUS}"]`).getAttribute("data-configured")) ===
        "true",
      {
        timeout: 15_000,
        interval: 300,
        timeoutMsg: "Gateway credential did not save to the isolated app profile",
      },
    );
    const toggle = await $(`[data-testid="${TOGGLE}"]`);
    await browser.waitUntil(async () => toggle.isEnabled(), { timeout: 15_000 });
    if ((await toggle.getAttribute("data-state")) !== "checked") await toggle.click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${GATEWAY_STATUS}"]`).getAttribute("data-state")) === "online",
      { timeout: 60_000, interval: 500, timeoutMsg: "isolated Gateway did not reach online" },
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    provider = await createSSHLifecycleProvider(sshConfig, CASE_MARKER);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: sshConfig,
      label: "A",
      provider,
      workspacePath: WORKSPACE_PATH,
    });
    const oldRemoteSessionId = task.remoteSessionId;

    const mobile = await openMobilePage(gateway);
    const mobileBackendId = mobile.backendId;
    try {
      await searchAndOpenTask(mobile.page, task.firstPrompt, task.firstReply, task.identity);
      await browseRemoteFile(mobile.page, WORKSPACE_PATH, "REMOTE_SENTINEL_P8_73AC");
    } finally {
      await mobile.close();
    }

    // 仅停止本用例创建的 sshd；容器、端口和 workspace 均由 runner 所有。
    await dockerExec(SSH_CONTAINER, "pkill", "-x", "sshd");
    await waitForRemoteWorkspaceDisconnected(task.identity, CASE_MARKER);
    const disconnectedMobile = await openMobilePage(gateway);
    try {
      expect(disconnectedMobile.backendId).toBe(mobileBackendId);
      const workspaceRow = disconnectedMobile.page
        .locator("li")
        .filter({ hasText: WORKSPACE_PATH })
        .first();
      await workspaceRow.getByText(/Disconnected|未连接/u).waitFor();
      expect(await workspaceRow.getByRole("button", { name: /^(Files|文件)$/u }).count()).toBe(0);
      const workspaceToggle = workspaceRow.locator("button[aria-expanded]");
      await workspaceToggle.click();
      await expectAttribute(workspaceToggle, "aria-expanded", "true");
      const workspaceTasks = workspaceRow.locator('[data-testid^="task-item-"]');
      const workspaceTaskCount = await workspaceTasks.count();
      if (workspaceTaskCount > 0) {
        const existingTask = workspaceRow.locator(
          `[data-testid="${testId(TID_TASK_ITEM, task.taskId)}"]`,
        );
        if (await existingTask.count()) {
          expect(await existingTask.isDisabled()).toBe(true);
        } else {
          for (const existingTask of await workspaceTasks.all()) {
            expect(await existingTask.isDisabled()).toBe(true);
          }
        }
      }
      await assertUnavailableRemoteSearch(disconnectedMobile.page, task.firstPrompt);
      expect(
        await disconnectedMobile.page
          .getByText("LOCAL_SENTINEL_MUST_NEVER_BE_READ", { exact: false })
          .count(),
      ).toBe(0);
    } finally {
      await disconnectedMobile.close();
    }
    await dockerExecDetached(SSH_CONTAINER, "/usr/sbin/sshd", "-D", "-e");
    await reconnectSSHWorkspace(WORKSPACE_PATH, CASE_MARKER);
    const reconnected = await waitForRemoteTab({
      caseMarker: CASE_MARKER,
      expectedIdentity: task.identity,
      expectedPath: WORKSPACE_PATH,
      requireActive: true,
    });
    expect(reconnected.remoteSessionId).not.toBe(oldRemoteSessionId);

    const afterReconnect = await openMobilePage(gateway);
    try {
      expect(afterReconnect.backendId).toBe(mobileBackendId);
      await searchAndOpenTask(
        afterReconnect.page,
        task.firstPrompt,
        task.firstReply,
        task.identity,
      );
      await browseRemoteFile(afterReconnect.page, WORKSPACE_PATH, "REMOTE_SENTINEL_P8_73AC");
      expect(
        await afterReconnect.page
          .getByText("LOCAL_SENTINEL_MUST_NEVER_BE_READ", { exact: false })
          .count(),
      ).toBe(0);
    } finally {
      await afterReconnect.close();
    }
    await publishHandoffAndWaitForRelease(gateway, mobileBackendId);
  });
});

async function ensureWorkspaceReady() {
  try {
    await waitForDefaultWorkspaceReady(60_000);
    return;
  } catch (error) {
    const loginButton = await $('[data-testid="login-use-api-key-button"]');
    if (!(await loginButton.isExisting())) throw error;
  }
  await loginWithApiKey();
  await waitForDefaultWorkspaceReady(60_000);
}

async function expectAttribute(
  locator: import("playwright-core").Locator,
  name: string,
  expected: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await locator.getAttribute(name)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected ${name}=${expected} on mobile workspace row`);
}

async function openMobilePage(config: GatewayE2EConfig) {
  const viteServer = await createServer({
    configFile: resolve(process.cwd(), "../web/vite.config.ts"),
    root: resolve(process.cwd(), "../web"),
    mode: "development",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  let browserInstance: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("mobile Vite server did not bind");
    browserInstance = await chromium.launch({
      headless: true,
      executablePath:
        process.env.ZCODE_E2E_CHROME_BINARY?.trim() ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    const context = await browserInstance.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`http://127.0.0.1:${address.port}/mobile.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-mobile-remote-page="settings"]').waitFor();
    await page.locator("#mobile-remote-gateway-url").fill(config.gatewayUrl);
    await page.locator("#mobile-remote-namespace").fill(config.namespace);
    await page.locator("#mobile-remote-credential").fill(config.deviceCredential);
    await page.locator('[data-mobile-remote-settings-submit="true"]').click();
    await page.locator('[data-mobile-remote-page="backend-picker"]').waitFor();
    const backends = page.locator("[data-mobile-remote-backend-item]");
    await backends.first().waitFor();
    const backendId = await backends.first().getAttribute("data-mobile-remote-backend-item");
    if (!backendId) throw new Error("mobile backend picker did not expose the selected backend id");
    await page.locator('[data-mobile-remote-backend-confirm="true"]').click();
    await page.getByRole("button", { name: /Search history|搜索历史/u }).waitFor();
    return {
      page,
      backendId,
      async close() {
        await context.close();
        await browserInstance?.close();
        await viteServer.close();
      },
    };
  } catch (error) {
    await browserInstance?.close();
    await viteServer.close();
    throw error;
  }
}

async function assertUnavailableRemoteSearch(page: import("playwright-core").Page, query: string) {
  await page.getByRole("button", { name: /Search history|搜索历史/u }).click();
  await page.locator('[data-mobile-page="search"]').waitFor();
  await page
    .getByRole("textbox", { name: /Search titles and messages|搜索标题和消息正文/u })
    .fill(query);
  await page.getByRole("button", { name: /^(Search|搜索)$/u }).click();
  await page
    .getByRole("status")
    .getByText(/offline|离线|不可用|未包含/u)
    .waitFor();
  expect(
    await page.locator('[data-mobile-page="search"] button').filter({ hasText: query }).count(),
  ).toBe(0);
}

async function publishHandoffAndWaitForRelease(gateway: GatewayE2EConfig, backendId: string) {
  const handoffPath = process.env.ZCODE_E2E_P8_REMOTE_HANDOFF_FILE?.trim();
  const releasePath = process.env.ZCODE_E2E_P8_REMOTE_RELEASE_FILE?.trim();
  const deviceCredentialFile = process.env.ZCODE_E2E_P8_REMOTE_DEVICE_CREDENTIAL_FILE?.trim();
  if (!handoffPath || !releasePath || !deviceCredentialFile) {
    throw new Error("P8 Android handoff paths were not configured");
  }
  const { chmod, writeFile, access } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const handoff = {
    gatewayUrl: gateway.gatewayUrl,
    namespace: gateway.namespace,
    backendId,
    deviceCredentialFile,
    localWorkspacePath: DEFAULT_WORKSPACE,
    workspacePath: WORKSPACE_PATH,
    releaseFile: releasePath,
  };
  await writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
  await chmod(handoffPath, 0o600);
  console.log(`P8_REMOTE_HANDOFF_FILE=${handoffPath}`);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      await access(releasePath);
      return;
    } catch {
      await delay(1_000);
    }
  }
  throw new Error("timed out waiting for the Android P8 handoff release file");
}

async function searchAndOpenTask(
  page: import("playwright-core").Page,
  query: string,
  reply: string,
  workspaceIdentity: string,
) {
  await page.getByRole("button", { name: /Search history|搜索历史/u }).click();
  await page.locator('[data-mobile-page="search"]').waitFor();
  await page
    .getByRole("textbox", { name: /Search titles and messages|搜索标题和消息正文/u })
    .fill(query);
  await page.getByRole("button", { name: /^(Search|搜索)$/u }).click();
  const result = page.getByRole("button").filter({ hasText: query });
  await result.first().waitFor();
  await result.first().getByText(workspaceIdentity, { exact: true }).waitFor();
  await result.first().click();
  await page.locator('[data-mobile-page="chat"]').waitFor();
  await page.getByText(reply, { exact: true }).waitFor();
}

async function browseRemoteFile(
  page: import("playwright-core").Page,
  workspacePath: string,
  content: string,
) {
  await page.getByRole("button", { name: /Back to task home|返回任务首页/u }).click();
  await page
    .locator("li")
    .filter({ hasText: workspacePath })
    .getByRole("button", { name: /^(Files|文件)$/u })
    .first()
    .click();
  await page.locator('[data-testid="mobile-file-browser"]').waitFor();
  const row = page.locator("[data-mobile-file-row]").filter({ hasText: "mobile-remote.txt" });
  await row.waitFor();
  await row.click();
  await page.getByText(content, { exact: false }).waitFor();
}

async function dockerExec(container: string, ...args: string[]) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("docker", ["exec", container, ...args]);
}

async function dockerExecDetached(container: string, ...args: string[]) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("docker", ["exec", "-d", container, ...args]);
}
