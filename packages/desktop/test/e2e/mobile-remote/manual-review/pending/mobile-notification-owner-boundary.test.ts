import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_TASK_SETTINGS_BUTTON,
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_ITEM,
  buildRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  testId,
} from "@zody/shared";
import {
  clickTestIdByDom,
  seedSettings,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { dismissOccupationOnboarding } from "../../../helpers/occupation-onboarding.js";
import { openSubagentHostWindow, readHostBoundary } from "../../../helpers/subagent-host-window.js";
import {
  createSSHLifecycleProvider,
  SSH_LIFECYCLE_MODEL_ID,
  type SSHLifecycleProvider,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  clickLastEnabledSSHDialogButton,
  fillSSHPasswordSettings,
  openSSHRemoteDialog,
  selectSSHRemoteDirectory,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
  type SSHConnectionConfig,
} from "../../../helpers/ssh-remote-p0.js";
import { selectUpstreamProviderModelById } from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";
import { getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { getTaskStoreSnapshot } from "../../../helpers/conversation-session-store.js";

type P8Credentials = {
  gatewayUrl: string;
  namespace: string;
  adminToken: string;
  backendCredential: string;
};

type NotificationRow = {
  notification_id: string;
  backend_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  remote_session_id: string | null;
  task_id: string;
  session_id: string;
  source_event_id: string;
  source_kind: string;
  kind: string;
  delivery_state: string;
  outbox_state: string;
  attempts: number;
  occurred_at: number;
};
type HandoffLabel = "owner" | "taskdeleted" | "workspaceclosed";

const marker = "E2E_MOBILE_P8_OWNER_BOUNDARY";
const workspacePath = process.env.ZCODE_E2E_P8_OWNER_WORKSPACE_PATH?.trim() ?? "";
const sshPort = Number(process.env.ZCODE_E2E_P8_OWNER_PORT);
const passwordFile = process.env.ZCODE_E2E_P8_OWNER_PASSWORD_FILE?.trim() ?? "";
const sharedDir = resolve(
  process.env.ZCODE_P8_OWNER_HANDOFF_DIR?.trim() ||
    join(process.cwd(), "../../.tmp/mobile-remote-p8-owner-boundary"),
);
const credentialPath = process.env.ZCODE_P8_CREDENTIAL_FILE?.trim();
const readyPath = join(sharedDir, "ready.json");
const releasePath = join(sharedDir, "release.json");
const resultPath = (label: HandoffLabel) => join(sharedDir, `result-${label}.json`);
const triggerPath = (label: HandoffLabel) => join(sharedDir, `trigger-${label}.json`);
const clickPath = (label: HandoffLabel) => join(sharedDir, `click-${label}.json`);
const verificationPath = join(sharedDir, "verification.json");

async function waitForFile(path: string, label: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${label} at ${path}`);
}

async function writeEvidence(path: string, value: unknown) {
  await mkdir(sharedDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function getOnlineBackend(credentials: P8Credentials) {
  const gateway = new URL(credentials.gatewayUrl);
  const adminUrl = `http://127.0.0.1:${gateway.port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${adminUrl}/api/admin/backends`, {
      headers: { Authorization: `Bearer ${credentials.adminToken}` },
    });
    if (!response.ok)
      throw new Error(`Isolated Gateway admin read failed (HTTP ${response.status})`);
    const result = (await response.json()) as {
      data?: Array<{ backendId: string; online: unknown }>;
    };
    const backend = result.data?.find((candidate) => candidate.online);
    if (backend) return backend.backendId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Desktop Host did not register with the isolated Gateway");
}

function readNotification(dbPath: string, backendId: string, taskId: string) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return database
      .prepare(`
      SELECT n.notification_id, n.backend_id, n.workspace_key, n.workspace_path,
        n.workspace_identity, n.remote_session_id, n.task_id, n.session_id,
        n.source_event_id, n.source_kind, n.kind, n.delivery_state, n.occurred_at,
        o.state AS outbox_state, o.attempts
      FROM mobile_notification n JOIN mobile_notification_outbox o USING(notification_id)
      WHERE n.backend_id = ? AND n.task_id = ? AND n.source_kind = 'turn.completed'
      ORDER BY n.occurred_at DESC LIMIT 1
    `)
      .get(backendId, taskId) as NotificationRow | undefined;
  } finally {
    database.close();
  }
}

function readReceiptCount(dbPath: string, backendId: string, notificationId: string) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      database
        .prepare(`
      SELECT COUNT(*) AS count FROM mobile_notification_read
      WHERE backend_id = ? AND notification_id = ?
    `)
        .get(backendId, notificationId) as { count: number }
    ).count;
  } finally {
    database.close();
  }
}

async function configureGateway(credentials: P8Credentials) {
  await dismissOccupationOnboarding();
  await seedSettings({
    locale: "en-US",
    localePreference: "en-US",
    remoteAccess: {
      enabled: false,
      gatewayUrl: credentials.gatewayUrl,
      namespace: credentials.namespace,
      allowMobileOpenArbitraryPath: true,
    },
  });
  await browser.refresh();
  await waitForDefaultWorkspaceReady(60_000);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"));
  await $('[data-testid="remote-access-settings"]').waitForDisplayed({ timeout: 15_000 });
  await setInputValueByTestIdDom("remote-access-credential", credentials.backendCredential);
  await clickTestIdByDom("remote-access-save-credential");
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="remote-access-credential-status"]').getAttribute(
        "data-configured",
      )) === "true",
    { timeout: 15_000 },
  );
  const toggle = await $('[data-testid="remote-access-toggle"]');
  await browser.waitUntil(async () => toggle.isEnabled(), { timeout: 15_000 });
  if ((await toggle.getAttribute("data-state")) !== "checked") await toggle.click();
  await browser.waitUntil(
    async () =>
      (await $('[data-testid="remote-access-gateway-status"]').getAttribute("data-state")) ===
      "online",
    { timeout: 60_000 },
  );
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
}

type WindowTabsSnapshot = {
  activeWorkspaceIdentity: string | null;
  activeWorkspacePath: string | null;
  tabs: Array<{
    workspacePath: string | null;
    workspaceIdentity: string | null;
    remoteSessionId: string | null;
  }>;
};

function readWindowTabs(): Promise<WindowTabsSnapshot> {
  return browser.execute(() => {
    type RemoteTab = {
      remoteSessionId?: string;
      workspaceIdentity?: string;
      workspacePath?: string;
    };
    const store = (
      window as Window & {
        __zcodeTabStoreE2E?: {
          getState?: () => {
            activeWorkspaceIdentity?: string | null;
            activeWorkspacePath?: string | null;
            tabs?: RemoteTab[];
          };
        };
      }
    ).__zcodeTabStoreE2E;
    const state = store?.getState?.();
    return {
      activeWorkspaceIdentity: state?.activeWorkspaceIdentity ?? null,
      activeWorkspacePath: state?.activeWorkspacePath ?? null,
      tabs: (state?.tabs ?? []).map((tab) => ({
        workspacePath: tab.workspacePath ?? null,
        workspaceIdentity: tab.workspaceIdentity ?? null,
        remoteSessionId: tab.remoteSessionId ?? null,
      })),
    };
  });
}

async function connectWorkspace(config: SSHConnectionConfig, identity: string) {
  await startNewV4Draft();
  await openSSHRemoteDialog(marker);
  await fillSSHPasswordSettings(config);
  await clickLastEnabledSSHDialogButton(marker);
  await waitForSSHDirectoryStep(marker);
  await selectSSHRemoteDirectory(workspacePath, marker);
  const tab = await waitForRemoteTab({
    caseMarker: marker,
    expectedIdentity: identity,
    expectedPath: workspacePath,
    requireActive: true,
  });
  if (!tab.remoteSessionId) throw new Error("Host A connected without a remoteSessionId");
  return { identity, remoteSessionId: tab.remoteSessionId };
}

async function emitRuntimeNotification(options: {
  stageLabel: HandoffLabel;
  handle: string;
  identity: string;
  remoteSessionId: string;
  taskResponse: string;
  provider: SSHLifecycleProvider;
  backendId: string;
  dbPath: string;
  markStage: (stage: string) => Promise<void>;
}) {
  await options.markStage(`${options.stageLabel}:switch-window`);
  await browser.switchToWindow(options.handle);
  await options.markStage(`${options.stageLabel}:select-provider`);
  await selectUpstreamProviderModelById(SSH_LIFECYCLE_MODEL_ID, {
    includePlainModelFallback: false,
    providerId: options.provider.id,
    providerName: options.provider.name,
  });
  const prompt = `${marker}_${options.stageLabel.toUpperCase()}_TRIGGER`;
  await options.markStage(`${options.stageLabel}:new-draft`);
  await startNewV4Draft();
  await options.markStage(`${options.stageLabel}:send-prompt`);
  await sendV4PromptAndWaitAccepted(
    `${prompt}: 只回复 ${options.taskResponse}`,
    prompt,
    `${marker}: ${options.stageLabel} 通知触发 turn 未被接受`,
  );
  await options.markStage(`${options.stageLabel}:wait-assistant`);
  await waitForV4AssistantMessageContaining(options.taskResponse, 120_000);
  await options.markStage(`${options.stageLabel}:wait-idle`);
  const completed = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${marker}: ${options.stageLabel} runtime turn 未完成`,
    120_000,
  );
  const taskId = completed.taskId;
  if (!taskId) throw new Error(`${options.stageLabel} runtime turn completed without taskId`);
  const taskSnapshot = await getTaskStoreSnapshot(
    taskId,
    resolveWorkspaceKey({ workspacePath, workspaceIdentity: options.identity }),
  );
  const expectedWorkspaceKey = resolveWorkspaceKey({
    workspacePath,
    workspaceIdentity: options.identity,
  });
  if (taskSnapshot.workspaceKey !== expectedWorkspaceKey) {
    await writeEvidence(join(sharedDir, `diagnostic-${options.stageLabel}.json`), {
      state: "runtime-task-not-owned-by-trigger-host",
      label: options.stageLabel,
      taskId,
      expectedWorkspaceKey,
      actualWorkspaceKey: taskSnapshot.workspaceKey,
      taskSnapshot,
    });
    throw new Error(
      `Runtime task is owned by ${taskSnapshot.workspaceKey}, expected ${expectedWorkspaceKey}`,
    );
  }
  await options.markStage(`${options.stageLabel}:runtime-idle:${taskId}`);

  const deadline = Date.now() + 60_000;
  let notification: NotificationRow | undefined;
  while (Date.now() < deadline) {
    try {
      notification = readNotification(options.dbPath, options.backendId, taskId);
    } catch {
      /* database can appear after first event */
    }
    if (notification?.delivery_state === "accepted" && notification.outbox_state === "accepted")
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (
    !notification ||
    notification.delivery_state !== "accepted" ||
    notification.outbox_state !== "accepted"
  ) {
    await writeEvidence(join(sharedDir, `diagnostic-${options.stageLabel}.json`), {
      state: "runtime-idle-without-accepted-notification",
      label: options.stageLabel,
      taskId,
      backendId: options.backendId,
      workspaceIdentity: options.identity,
      remoteSessionId: options.remoteSessionId,
      notification,
    });
    throw new Error(
      `${options.stageLabel} runtime completion did not reach an accepted notification outbox state`,
    );
  }
  if (
    notification.workspace_identity !== options.identity ||
    notification.remote_session_id !== options.remoteSessionId
  ) {
    throw new Error(
      `${options.stageLabel} notification lost its current workspace identity or remoteSessionId`,
    );
  }
  await writeEvidence(resultPath(options.stageLabel), {
    state: "runtime-completed-and-push-accepted",
    label: options.stageLabel,
    backendId: options.backendId,
    workspacePath: notification.workspace_path,
    workspaceKey: notification.workspace_key,
    workspaceIdentity: notification.workspace_identity,
    remoteSessionId: notification.remote_session_id,
    taskId: notification.task_id,
    taskWorkspaceKey: taskSnapshot.workspaceKey,
    sessionId: notification.session_id,
    notificationId: notification.notification_id,
    sourceEventId: notification.source_event_id,
    sourceKind: notification.source_kind,
    kind: notification.kind,
    deliveryState: notification.delivery_state,
    outboxState: notification.outbox_state,
    attempts: notification.attempts,
    occurredAt: notification.occurred_at,
    expectedResponse: options.taskResponse,
    sqliteRow: notification,
  });
  return notification;
}

/** MN06-R3：先归档任务，再从归档列表删除；必须经真实 UI 生命周期入口。 */
async function archiveAndDeleteTask(taskId: string) {
  // 任务行 action（含归档）只在 hover/focus 时挂载；先 moveTo 再等按钮出现。
  const taskRow = await $(`[data-testid="${testId(TID_TASK_ITEM, taskId)}"]`);
  await taskRow.waitForExist({ timeout: 30_000 });
  await taskRow.moveTo();
  const archiveButton = await $(`[data-testid="${testId(TID_TASK_ARCHIVE, taskId)}"]`);
  await archiveButton.waitForExist({ timeout: 10_000 });
  await archiveButton.click();
  // 归档是两段式：第一次点击进入确认态（按钮变 destructive Confirm），再点一次执行。
  await browser.waitUntil(
    async () => (await archiveButton.getText()).trim() === "Confirm",
    { timeout: 10_000, timeoutMsg: "归档按钮没有进入确认态" },
  );
  await archiveButton.click();
  const archivedToggle = await $('button[aria-label="Archived"]');
  await archivedToggle.waitForExist({ timeout: 15_000 });
  await archivedToggle.click();
  // 全新隔离 E2E home 只会有本用例归档的一个任务；出现多个删除按钮即状态泄漏。
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => document.querySelectorAll('button[aria-label="Delete task"]').length,
      )) === 1,
    { timeout: 30_000, timeoutMsg: "归档视图没有收敛到恰好一个待删除任务" },
  );
  const deleteButton = await $('button[aria-label="Delete task"]');
  await deleteButton.click();
  await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
    timeout: 15_000,
    timeoutMsg: "归档任务删除确认按钮没有出现",
  });
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => document.querySelectorAll('button[aria-label="Delete task"]').length,
      )) === 0,
    { timeout: 30_000, timeoutMsg: `任务 ${taskId} 删除后仍留在归档列表` },
  );
  // 关闭归档视图，否则后续 workspace 行（hover 动作入口）不渲染。
  const closeArchived = await $('button[aria-label="Close"]');
  if (await closeArchived.isExisting().catch(() => false)) {
    await closeArchived.click();
  }
}

/** MN06-R3：经 workspace 行 more 菜单真实移除远程 workspace tab。 */
async function removeRemoteWorkspaceTab(identity: string) {
  const row = await $(`[data-testid="${testId(TID_WORKSPACE_ITEM, workspacePath)}"]`);
  await row.waitForExist({ timeout: 15_000 });
  // workspace 行 action 菜单同样只在 hover/focus 时挂载。
  await row.moveTo();
  const moreButton = await row.$('button[aria-label="More"]');
  await moreButton.waitForExist({ timeout: 10_000 });
  await moreButton.click();
  const closeItem = await $(`[data-testid="${testId(TID_WORKSPACE_CLOSE, workspacePath)}"]`);
  await closeItem.waitForDisplayed({ timeout: 10_000 });
  await closeItem.click();
  // 运行中任务才弹确认；本 case 任务均已 idle，若出现确认则按用户确认处理。
  const confirm = await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
  try {
    await confirm.waitForDisplayed({ timeout: 3_000 });
    await confirm.click();
  } catch {
    /* idle workspace removal does not confirm */
  }
  await browser.waitUntil(
    async () =>
      (await readWindowTabs()).tabs.every((tab) => tab.workspaceIdentity !== identity),
    { timeout: 30_000, timeoutMsg: "远程 workspace tab 移除后仍留在 tab 列表" },
  );
}

async function readClickEvidence(
  label: HandoffLabel,
  notification: NotificationRow,
  dbPath: string,
) {
  await waitForFile(clickPath(label), `Android system-card click ${label}`, 45 * 60_000);
  const click = JSON.parse(await readFile(clickPath(label), "utf8")) as Record<string, unknown>;
  const expectedRoute =
    label === "owner"
      ? {
          label,
          notificationId: notification.notification_id,
          workspaceIdentity: notification.workspace_identity,
          remoteSessionId: notification.remote_session_id,
          taskId: notification.task_id,
          sessionId: notification.session_id,
          opened: true,
        }
      : { label, notificationId: notification.notification_id, rejected: true };
  for (const [key, value] of Object.entries(expectedRoute)) {
    if (click[key] !== value) throw new Error(`Android click ${label} evidence mismatched ${key}`);
  }
  const receiptCount = readReceiptCount(dbPath, notification.backend_id, notification.notification_id);
  const expectedReceiptCount = label === "owner" ? 1 : 0;
  if (receiptCount !== expectedReceiptCount) {
    throw new Error(
      `Android click ${label} expected ${expectedReceiptCount} receipt(s), got ${receiptCount}`,
    );
  }
  let results: Array<Record<string, unknown>> = [];
  try {
    results =
      (
        JSON.parse(await readFile(verificationPath, "utf8")) as {
          results?: Array<Record<string, unknown>>;
        }
      ).results ?? [];
  } catch {
    /* the first click acknowledgement creates this file */
  }
  results.push({
    label,
    notificationId: notification.notification_id,
    readReceiptCount: receiptCount,
    confirmedRoute: expectedRoute,
  });
  await writeEvidence(verificationPath, { state: `click-${label}-verified`, results });
}

describe("P8 pending: notification owner boundary and stale-target clicks", () => {
  it("routes a same-identity click to the current owner and rejects deleted/closed targets", async function () {
    this.timeout(90 * 60_000);
    if (!credentialPath || !workspacePath || !Number.isSafeInteger(sshPort) || !passwordFile)
      this.skip();
    const credentials = JSON.parse(await readFile(credentialPath!, "utf8")) as P8Credentials;
    const password = (await readFile(passwordFile, "utf8")).trim();
    const sshConfig: SSHConnectionConfig = {
      host: "127.0.0.1",
      port: sshPort,
      username: "root",
      password,
    };
    await mkdir(sharedDir, { recursive: true, mode: 0o700 });
    const handoffLabels: HandoffLabel[] = ["owner", "taskdeleted", "workspaceclosed"];
    await Promise.all(
      [
        readyPath,
        releasePath,
        verificationPath,
        join(sharedDir, "placeholder-evidence.json"),
        join(sharedDir, "final-host-pids.json"),
        ...handoffLabels.flatMap((label) => [
          resultPath(label),
          triggerPath(label),
          clickPath(label),
        ]),
      ].map((path) => rm(path, { force: true })),
    );

    const markStage = (stage: string) =>
      writeEvidence(join(sharedDir, "stage.json"), { stage, at: new Date().toISOString() });
    const disposeProviders: SSHLifecycleProvider[] = [];
    const initialHandles = await browser.getWindowHandles();
    const readyPids = async () =>
      new Set(
        (await readHostBoundary())
          .filter((event) => event.kind === "ready")
          .map((event) => event.pid),
      );
    try {
      await configureGateway(credentials);
      await prepareV4ConversationE2E();
      await markStage("gateway-backend-online");
      const backendId = await getOnlineBackend(credentials);
      const dbPath = join(
        getE2EAppDataPaths().homeDir,
        ".zody",
        "v2",
        "mobile-notifications.sqlite",
      );
      const identity = buildRemoteWorkspaceIdentity(workspacePath, {
        kind: "ssh",
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
      });

      const readyPidsBeforeA = await readyPids();
      const windowA = await openSubagentHostWindow();
      const hostAHandle = windowA.handle;
      let hostAPids: number[] = [];
      await browser.waitUntil(
        async () => {
          hostAPids = [...(await readyPids())].filter((pid) => !readyPidsBeforeA.has(pid));
          return hostAPids.length > 0;
        },
        {
          timeout: 15_000,
          interval: 100,
          timeoutMsg: "Host A 新窗口没有写入 injected ready PID",
        },
      );
      if (hostAPids.length !== 1) throw new Error("Host A did not start one distinct Local Host");
      await waitForDefaultWorkspaceReady(60_000);

      const provider = await createSSHLifecycleProvider(sshConfig, marker);
      disposeProviders.push(provider);
      const target = await connectWorkspace(sshConfig, identity);

      const pidsBeforeB = await readyPids();
      const windowB = await openSubagentHostWindow();
      const windowBHandle = windowB.handle;
      let pidsAfterB = new Set<number>();
      await browser.waitUntil(
        async () => {
          pidsAfterB = await readyPids();
          return [...pidsAfterB].some((pid) => !pidsBeforeB.has(pid));
        },
        {
          timeout: 15_000,
          interval: 100,
          timeoutMsg: "第二个窗口没有产生新的 Local Host ready PID",
        },
      );
      const hostPids = [
        ...new Set([...hostAPids, ...[...pidsAfterB].filter((pid) => !pidsBeforeB.has(pid))]),
      ].sort((left, right) => left - right);
      if (hostPids.length !== 2) {
        throw new Error("The second Desktop window did not register a distinct Local Host process");
      }
      await waitForDefaultWorkspaceReady(60_000);

      // MC01-R1 前置：窗口 B 必须存在同 identity、无 remoteSessionId 的恢复占位 tab，
      // 且窗口 A 保持带 session 的连接。占位不存在时该场景不成立，直接失败暴露问题。
      let windowBTabs: WindowTabsSnapshot | undefined;
      await browser.switchToWindow(windowBHandle);
      await browser.waitUntil(
        async () => {
          windowBTabs = await readWindowTabs();
          return windowBTabs.tabs.some(
            (tab) => tab.workspaceIdentity === identity && !tab.remoteSessionId,
          );
        },
        {
          timeout: 90_000,
          interval: 1_000,
          timeoutMsg: "窗口 B 没有恢复出同 identity 的无 session 占位 tab",
        },
      );
      await browser.switchToWindow(hostAHandle);
      const windowATabs = await readWindowTabs();
      if (
        !windowATabs.tabs.some(
          (tab) => tab.workspaceIdentity === identity && tab.remoteSessionId === target.remoteSessionId,
        )
      ) {
        throw new Error("窗口 A 失去了带 remoteSessionId 的连接 tab");
      }
      await writeEvidence(join(sharedDir, "placeholder-evidence.json"), {
        state: "stale-placeholder-present",
        workspaceIdentity: identity,
        windowA: windowATabs,
        windowB: windowBTabs,
      });

      await writeEvidence(readyPath, {
        state: "two-windows-ready",
        gatewayUrl: credentials.gatewayUrl,
        namespace: credentials.namespace,
        backendId,
        workspacePath,
        e2eHome: getE2EAppDataPaths().homeDir,
        notificationDatabasePath: dbPath,
        hostPids,
        target: {
          workspaceIdentity: target.identity,
          remoteSessionId: target.remoteSessionId,
        },
        stages: [
          "trigger-owner.json",
          "click-owner.json",
          "trigger-taskdeleted.json",
          "click-taskdeleted.json",
          "trigger-workspaceclosed.json",
          "click-workspaceclosed.json",
          "release.json",
        ],
      });
      await markStage("waiting-for-android-ready-and-trigger-owner");

      await waitForFile(
        triggerPath("owner"),
        "trigger owner after Android login and subscription setup",
        30 * 60_000,
      );
      const notificationOwner = await emitRuntimeNotification({
        stageLabel: "owner",
        handle: hostAHandle,
        identity: target.identity,
        remoteSessionId: target.remoteSessionId,
        taskResponse: "P8_OWNER_CURRENT_OWNER_ROUTING_OK",
        provider,
        backendId,
        dbPath,
        markStage,
      });
      if (readReceiptCount(dbPath, backendId, notificationOwner.notification_id) !== 0) {
        throw new Error("Owner notification was read before the Android click was acknowledged");
      }
      await markStage("awaiting-android-click-owner");
      await readClickEvidence("owner", notificationOwner, dbPath);
      // MC01：手机点击不得切换桌面选中 tab，也不得新建 Host。
      await browser.switchToWindow(hostAHandle);
      const tabsAfterOwnerClick = await readWindowTabs();
      if (
        tabsAfterOwnerClick.activeWorkspaceIdentity !== identity ||
        !tabsAfterOwnerClick.tabs.some(
          (tab) =>
            tab.workspaceIdentity === identity &&
            tab.remoteSessionId === target.remoteSessionId,
        )
      ) {
        throw new Error("Owner click changed the desktop active tab or detached the owner session");
      }

      await waitForFile(triggerPath("taskdeleted"), "trigger taskdeleted stage", 30 * 60_000);
      const notificationTaskDeleted = await emitRuntimeNotification({
        stageLabel: "taskdeleted",
        handle: hostAHandle,
        identity: target.identity,
        remoteSessionId: target.remoteSessionId,
        taskResponse: "P8_OWNER_TASK_DELETED_OK",
        provider,
        backendId,
        dbPath,
        markStage,
      });
      await archiveAndDeleteTask(notificationTaskDeleted.task_id);
      await markStage("awaiting-android-click-taskdeleted");
      await readClickEvidence("taskdeleted", notificationTaskDeleted, dbPath);
      if (readReceiptCount(dbPath, backendId, notificationOwner.notification_id) !== 1) {
        throw new Error("Task-deleted click changed the owner notification read receipt");
      }

      await waitForFile(triggerPath("workspaceclosed"), "trigger workspaceclosed stage", 30 * 60_000);
      const notificationWorkspaceClosed = await emitRuntimeNotification({
        stageLabel: "workspaceclosed",
        handle: hostAHandle,
        identity: target.identity,
        remoteSessionId: target.remoteSessionId,
        taskResponse: "P8_OWNER_WORKSPACE_CLOSED_OK",
        provider,
        backendId,
        dbPath,
        markStage,
      });
      await browser.switchToWindow(hostAHandle);
      await removeRemoteWorkspaceTab(identity);
      await markStage("awaiting-android-click-workspaceclosed");
      await readClickEvidence("workspaceclosed", notificationWorkspaceClosed, dbPath);

      const finalHostPids = [...(await readyPids())].sort((left, right) => left - right);
      if (
        finalHostPids.length !== hostPids.length ||
        hostPids.some((pid, index) => pid !== finalHostPids[index])
      ) {
        await writeEvidence(join(sharedDir, "final-host-pids.json"), {
          state: "unexpected-host-process-change",
          initialHostPids: hostPids,
          finalHostPids,
        });
        throw new Error("Stale-target clicks changed the set of injected Local Host processes");
      }
      await writeEvidence(join(sharedDir, "final-host-pids.json"), {
        state: "host-process-set-unchanged",
        initialHostPids: hostPids,
        finalHostPids,
      });
      await writeEvidence(join(sharedDir, "final-receipts.json"), {
        owner: readReceiptCount(dbPath, backendId, notificationOwner.notification_id),
        taskdeleted: readReceiptCount(
          dbPath,
          backendId,
          notificationTaskDeleted.notification_id,
        ),
        workspaceclosed: readReceiptCount(
          dbPath,
          backendId,
          notificationWorkspaceClosed.notification_id,
        ),
        note: "Owner click must be the only read receipt; deleted-task and closed-workspace cards are rejected without receipts.",
      });
      await markStage("awaiting-release");
      await waitForFile(releasePath, "operator release after device checks", 45 * 60_000);
    } finally {
      await Promise.all(
        disposeProviders.map((providerToDispose) =>
          providerToDispose.tunnel.close().catch(() => undefined),
        ),
      );
      const handles = await browser.getWindowHandles();
      for (const handle of handles) {
        if (!initialHandles.includes(handle)) {
          try {
            await browser.switchToWindow(handle);
            await browser.closeWindow();
          } catch {
            /* only this case's extra window */
          }
        }
      }
      if (initialHandles.length > 0) await browser.switchToWindow(initialHandles[0]!);
    }
  });
});
