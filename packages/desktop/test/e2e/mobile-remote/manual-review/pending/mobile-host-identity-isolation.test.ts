import { readFile } from "node:fs/promises";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zody/shared";
import {
  clickTestIdByDom,
  seedSettings,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { dismissOccupationOnboarding } from "../../../helpers/occupation-onboarding.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  type SSHLifecycleProvider,
} from "../../../helpers/ssh-remote-lifecycle.js";
import { openSubagentHostWindow, readHostBoundary } from "../../../helpers/subagent-host-window.js";
import {
  connectFakePhone,
  resolveGatewayE2EConfig,
  type FakePhoneSession,
  type GatewayE2EConfig,
} from "../../../helpers/mobile-remote-gateway.js";

/** MN/MS P8 candidate: distinct real Local Hosts, SSH targets, Main routing and Gateway protocol probe. */
const REMOTE_ACCESS_SETTINGS = 'data-testid="remote-access-settings"';
const GATEWAY_URL_INPUT = "remote-access-gateway-url";
const CREDENTIAL_INPUT = "remote-access-credential";
const SAVE_CREDENTIAL_BUTTON = "remote-access-save-credential";
const CREDENTIAL_STATUS = "remote-access-credential-status";
const GATEWAY_STATUS = "remote-access-gateway-status";
const REMOTE_ACCESS_TOGGLE = "remote-access-toggle";
const WORKSPACE_PATH = process.env.ZODY_E2E_P8_IDENTITY_WORKSPACE_PATH?.trim() ?? "";
const SSH_A_PORT = Number(process.env.ZODY_E2E_P8_IDENTITY_A_PORT);
const SSH_B_PORT = Number(process.env.ZODY_E2E_P8_IDENTITY_B_PORT);
const SSH_A_PASSWORD_FILE = process.env.ZODY_E2E_P8_IDENTITY_A_PASSWORD_FILE?.trim() ?? "";
const SSH_B_PASSWORD_FILE = process.env.ZODY_E2E_P8_IDENTITY_B_PASSWORD_FILE?.trim() ?? "";
const SEARCH_QUERY = "P8_HOST_IDENTITY_SEARCH_TOKEN";
const CASE_MARKER = "E2E_MOBILE_P8_HOST_IDENTITY";

let gateway: GatewayE2EConfig | null = null;

async function configureGateway(config: GatewayE2EConfig) {
  await dismissOccupationOnboarding();
  await seedSettings({
    remoteAccess: {
      enabled: false,
      gatewayUrl: config.gatewayUrl,
      namespace: config.namespace,
      allowMobileOpenArbitraryPath: true,
    },
  });
  await browser.refresh();
  await waitForDefaultWorkspaceReady(60_000);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 30_000 });
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"));
  await $(`[${REMOTE_ACCESS_SETTINGS}]`).waitForDisplayed({ timeout: 15_000 });
  await setInputValueByTestIdDom(GATEWAY_URL_INPUT, config.gatewayUrl);
  await clickTestIdByDom("remote-access-save-config");
  await setInputValueByTestIdDom(CREDENTIAL_INPUT, config.backendCredential);
  await clickTestIdByDom(SAVE_CREDENTIAL_BUTTON);
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${CREDENTIAL_STATUS}"]`).getAttribute("data-configured")) === "true",
    { timeout: 15_000, interval: 300 },
  );
  const toggle = await $(`[data-testid="${REMOTE_ACCESS_TOGGLE}"]`);
  await browser.waitUntil(async () => toggle.isEnabled(), { timeout: 15_000 });
  if ((await toggle.getAttribute("data-state")) !== "checked") await toggle.click();
  await browser.waitUntil(
    async () =>
      (await $(`[data-testid="${GATEWAY_STATUS}"]`).getAttribute("data-state")) === "online",
    { timeout: 60_000, interval: 500 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}

async function disableGateway() {
  try {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 10_000 });
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 10_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"));
    const toggle = await $(`[data-testid="${REMOTE_ACCESS_TOGGLE}"]`);
    await toggle.waitForDisplayed({ timeout: 10_000 });
    if ((await toggle.getAttribute("data-state")) === "checked") await toggle.click();
    await browser.waitUntil(
      async () =>
        (await $(`[data-testid="${GATEWAY_STATUS}"]`).getAttribute("data-state")) !== "online",
      { timeout: 15_000, interval: 300 },
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  } catch {
    // 清理不能覆盖主断言；下次用例启动时仍会将 remote access 设置为 disabled。
  }
}

describe("P8 mobile multi-Host identity isolation", () => {
  before(async () => {
    gateway = await resolveGatewayE2EConfig();
  });

  it("routes search by workspace identity when two Desktop windows share a remote path", async function () {
    if (
      !gateway ||
      !WORKSPACE_PATH ||
      !Number.isSafeInteger(SSH_A_PORT) ||
      !Number.isSafeInteger(SSH_B_PORT) ||
      SSH_A_PORT < 1 ||
      SSH_A_PORT > 65_535 ||
      SSH_B_PORT < 1 ||
      SSH_B_PORT > 65_535 ||
      SSH_A_PORT === SSH_B_PORT ||
      !SSH_A_PASSWORD_FILE ||
      !SSH_B_PASSWORD_FILE
    ) {
      this.skip();
      return;
    }
    const config = gateway;
    await configureGateway(config);

    let phone: FakePhoneSession | undefined;
    const providers: SSHLifecycleProvider[] = [];
    try {
      const [passwordA, passwordB] = await Promise.all([
        readFile(SSH_A_PASSWORD_FILE, "utf8"),
        readFile(SSH_B_PASSWORD_FILE, "utf8"),
      ]);
      const targetA = {
        host: "127.0.0.1",
        port: SSH_A_PORT,
        username: "root",
        password: passwordA.trim(),
      };
      const targetB = {
        host: "127.0.0.1",
        port: SSH_B_PORT,
        username: "root",
        password: passwordB.trim(),
      };

      // 通过测试专用 Host preload 的 ready 事件记录 pid，明确把每个新窗口映射到
      // 实际 Local Host UtilityProcess；仅建立两个 SSH 连接不能证明是两个 Host。
      const readyPids = async () =>
        new Set(
          (await readHostBoundary())
            .filter((event) => event.kind === "ready")
            .map((event) => event.pid),
        );
      const waitForNewReadyPids = async (previous: Set<number>) => {
        let newPids: number[] = [];
        await browser.waitUntil(
          async () => {
            newPids = [...(await readyPids())].filter((pid) => !previous.has(pid));
            return newPids.length > 0;
          },
          {
            timeout: 15_000,
            interval: 100,
            timeoutMsg: "新窗口 Local Host 没有写入新的 ready PID",
          },
        );
        return newPids;
      };
      const readyPidsBeforeA = await readyPids();
      const windowA = await openSubagentHostWindow();
      const hostAReadyPids = await waitForNewReadyPids(readyPidsBeforeA);
      expect(hostAReadyPids).toHaveLength(1);
      expect(windowA.windowId).toBeGreaterThan(0);
      await waitForDefaultWorkspaceReady(60_000);
      const providerA = await createSSHLifecycleProvider(targetA, CASE_MARKER);
      providers.push(providerA);
      const taskA = await connectSSHWorkspaceAndSendFirstTurn({
        caseMarker: CASE_MARKER,
        config: targetA,
        provider: providerA,
        label: "A",
        workspacePath: WORKSPACE_PATH,
      });

      const windowsBeforeB = await browser.getWindowHandles();
      const readyPidsBeforeB = await readyPids();
      const windowB = await openSubagentHostWindow();
      // openSubagentHostWindow 的 ready 等待可能被窗口 A 的旧 ready 事件满足，必须等待 PID 集合增长。
      const hostBReadyPids = await waitForNewReadyPids(readyPidsBeforeB);
      expect(hostBReadyPids).toHaveLength(1);
      expect(windowB.windowId).not.toBe(windowA.windowId);
      expect(hostBReadyPids[0]).not.toBe(hostAReadyPids[0]);
      const handleB = windowB.handle;
      expect(windowsBeforeB).not.toContain(handleB);
      await waitForDefaultWorkspaceReady(60_000);
      // 每个 Host 的 SSH forwarding 独立于其他窗口；B 使用自己的真实 SSH tunnel。
      const providerB = await createSSHLifecycleProvider(targetB, CASE_MARKER);
      providers.push(providerB);
      const taskB = await connectSSHWorkspaceAndSendFirstTurn({
        caseMarker: CASE_MARKER,
        config: targetB,
        provider: providerB,
        label: "B",
        workspacePath: WORKSPACE_PATH,
      });
      expect(taskA.identity).not.toBe(taskB.identity);
      expect(taskA.remoteSessionId).not.toBe(taskB.remoteSessionId);

      const rendererWorkspaceProjections = [] as Array<{
        label: string;
        tabs: Array<{
          workspacePath: string;
          workspaceIdentity?: string;
          remoteSessionId?: string;
        }>;
      }>;
      for (const target of [
        { label: "A", handle: windowA.handle },
        { label: "B", handle: windowB.handle },
      ]) {
        await browser.switchToWindow(target.handle);
        const tabs = await browser.execute((workspacePath) => {
          const store = (
            window as unknown as {
              __zcodeTabStoreE2E?: { getState: () => { tabs: Array<Record<string, unknown>> } };
            }
          ).__zcodeTabStoreE2E;
          return (store?.getState().tabs ?? [])
            .filter((tab) => tab.workspacePath === workspacePath)
            .map((tab) => ({
              workspacePath: String(tab.workspacePath),
              workspaceIdentity:
                typeof tab.workspaceIdentity === "string" ? tab.workspaceIdentity : undefined,
              remoteSessionId:
                typeof tab.remoteSessionId === "string" ? tab.remoteSessionId : undefined,
            }));
        }, WORKSPACE_PATH);
        rendererWorkspaceProjections.push({ label: target.label, tabs });
      }
      await browser.switchToWindow(windowB.handle);

      // Gateway app-level transport originates from the current Desktop runtime; Main routes each scope to its owner Host.
      phone = await connectFakePhone(config, {
        clientInstanceId: "zcode-e2e-host-identity-isolation",
        clientName: "P8 identity isolation phone",
      });
      const hostPidsBeforeSearch = [...(await readyPids())].sort((left, right) => left - right);

      const bootstrapPromise = phone.waitForPayload(
        (payload) =>
          payload.zody_type === "bootstrap-response" &&
          payload.requestId === "p8-identity-bootstrap",
      );
      phone.sendPayload({ zody_type: "bootstrap-request", requestId: "p8-identity-bootstrap" });
      const bootstrap = await bootstrapPromise;
      expect(
        (bootstrap.result as { mobileCapabilities?: { historySearch?: number } })
          .mobileCapabilities,
      ).toMatchObject({ historySearch: 1 });

      const workspaceListRequest = "p8-identity-workspaces";
      const workspaceListPromise = phone.waitForPayload(
        (payload) =>
          payload.zody_type === "workspace-list-response" &&
          payload.requestId === workspaceListRequest,
      );
      phone.sendPayload({ zody_type: "workspace-list-request", requestId: workspaceListRequest });
      const workspaceListResponse = await workspaceListPromise;
      const workspaces =
        (
          workspaceListResponse.result as {
            workspaces?: Array<{
              workspacePath: string;
              workspaceIdentity?: string;
              remoteSessionId?: string;
              connectionState?: string;
            }>;
          }
        ).workspaces ?? [];
      const samePath = workspaces.filter((workspace) => workspace.workspacePath === WORKSPACE_PATH);
      const identities = [
        ...new Set(
          samePath.map((workspace) => workspace.workspaceIdentity?.trim()).filter(Boolean),
        ),
      ];
      expect(identities).toEqual(expect.arrayContaining([taskA.identity, taskB.identity]));

      const scopeSignature = JSON.stringify(identities);
      const outcomes = await Promise.all(
        identities.map(async (workspaceKey, index) => {
          const requestId = `p8-identity-search-${index}`;
          const outcomePromise = phone!.waitForPayload(
            (payload) =>
              payload.zody_type === "mobile-history-search-outcome" &&
              payload.requestId === requestId,
          );
          phone!.sendPayload({
            zody_type: "mobile-history-search-request",
            requestId,
            context: {
              backendId: phone!.backendId,
              connectionGeneration: 1,
              workspaceKey,
              requestId,
            },
            queryGeneration: 1,
            scopeSignature,
            query: SEARCH_QUERY,
            includeArchived: false,
            limit: 50,
          });
          return outcomePromise;
        }),
      );
      for (const [index, outcome] of outcomes.entries()) {
        const workspaceKey = identities[index];
        const workspace = samePath.find(
          (candidate) => candidate.workspaceIdentity?.trim() === workspaceKey,
        );
        if (outcome.status !== "ok") {
          throw new Error(
            `P8: identity-scoped search failed ${JSON.stringify({
              status: outcome.status,
              errorCode: outcome.errorCode,
              workspace: workspace && {
                identity: workspace.workspaceIdentity,
                hasRemoteSessionId: Boolean(workspace.remoteSessionId),
                remoteSessionMatchesTask:
                  workspace.remoteSessionId ===
                  [taskA, taskB].find((task) => task.identity === workspaceKey)?.remoteSessionId,
                connectionState: workspace.connectionState,
              },
              rendererWorkspaceProjections,
            })}`,
          );
        }
        const items = outcome.items as Array<{
          task?: { workspaceIdentity?: string };
          workspaceKey?: string;
          remoteSessionId?: string;
          snippets?: string[];
        }>;
        const expectedTask = [taskA, taskB].find((task) => task.identity === workspaceKey);
        const expectedContentMarker = workspaceKey === taskA.identity ? "alpha" : "beta";
        expect(items.length).toBeGreaterThan(0);
        expect(
          items.every(
            (item) =>
              item.workspaceKey === workspaceKey &&
              item.task?.workspaceIdentity === workspaceKey &&
              item.remoteSessionId === expectedTask?.remoteSessionId,
          ),
        ).toBe(true);
        expect(
          items.some((item) =>
            item.snippets?.some(
              (snippet) =>
                snippet.includes(SEARCH_QUERY) && snippet.includes(expectedContentMarker),
            ),
          ),
        ).toBe(true);
      }
      expect([...(await readyPids())].sort((left, right) => left - right)).toEqual(
        hostPidsBeforeSearch,
      );
      expect(hostPidsBeforeSearch).toEqual(
        expect.arrayContaining(hostAReadyPids.concat(hostBReadyPids)),
      );

      /*
       * Keep forged scope probes after successful identity scoped search so that the real routing
       * assertions remain readable above; altered backend/workspace targets must be rejected.
       */

      const invalidBackendPromise = phone.waitForPayload(
        (payload) =>
          payload.zody_type === "mobile-history-search-outcome" &&
          payload.requestId === "p8-identity-forged-backend",
      );
      phone.sendPayload({
        zody_type: "mobile-history-search-request",
        requestId: "p8-identity-forged-backend",
        context: {
          backendId: "forged-backend",
          connectionGeneration: 1,
          workspaceKey: identities[0]!,
          requestId: "p8-identity-forged-backend",
        },
        queryGeneration: 1,
        scopeSignature,
        query: SEARCH_QUERY,
        includeArchived: false,
        limit: 50,
      });
      expect((await invalidBackendPromise).status).toBe("offline");

      const invalidWorkspacePromise = phone.waitForPayload(
        (payload) =>
          payload.zody_type === "mobile-history-search-outcome" &&
          payload.requestId === "p8-identity-forged-workspace",
      );
      phone.sendPayload({
        zody_type: "mobile-history-search-request",
        requestId: "p8-identity-forged-workspace",
        context: {
          backendId: phone.backendId,
          connectionGeneration: 1,
          workspaceKey: WORKSPACE_PATH,
          requestId: "p8-identity-forged-workspace",
        },
        queryGeneration: 1,
        scopeSignature,
        query: SEARCH_QUERY,
        includeArchived: false,
        limit: 50,
      });
      expect((await invalidWorkspacePromise).status).toBe("closed");
    } finally {
      phone?.close();
      await Promise.all(providers.map((entry) => entry.tunnel.close().catch(() => undefined)));
      await disableGateway();
      await seedSettings({
        remoteAccess: {
          enabled: false,
          gatewayUrl: config.gatewayUrl,
          namespace: config.namespace,
          allowMobileOpenArbitraryPath: true,
        },
      });
    }
  });
});
