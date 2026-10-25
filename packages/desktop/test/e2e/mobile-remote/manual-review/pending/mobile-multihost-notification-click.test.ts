import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  buildRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  testId,
} from "@zcode/shared";
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
type HandoffLabel = "A" | "B" | "revoked" | "recovered";

const marker = "E2E_MOBILE_P8_MULTIHOST_NOTIFICATION";
const workspacePath = process.env.ZCODE_E2E_P8_MULTIHOST_WORKSPACE_PATH?.trim() ?? "";
const sshPorts = [
  Number(process.env.ZCODE_E2E_P8_MULTIHOST_A_PORT),
  Number(process.env.ZCODE_E2E_P8_MULTIHOST_B_PORT),
] as const;
const passwordFiles = [
  process.env.ZCODE_E2E_P8_MULTIHOST_A_PASSWORD_FILE?.trim() ?? "",
  process.env.ZCODE_E2E_P8_MULTIHOST_B_PASSWORD_FILE?.trim() ?? "",
] as const;
const sharedDir = resolve(
  process.env.ZCODE_P8_MULTIHOST_HANDOFF_DIR?.trim() ||
    join(process.cwd(), "../../.tmp/mobile-remote-p8-multihost-click"),
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

async function connectWorkspace(config: SSHConnectionConfig, label: "A" | "B") {
  const identity = buildRemoteWorkspaceIdentity(workspacePath, {
    kind: "ssh",
    host: config.host,
    port: config.port,
    username: config.username,
  });
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
  if (!tab.remoteSessionId) throw new Error(`Host ${label} connected without a remoteSessionId`);
  return { identity, remoteSessionId: tab.remoteSessionId };
}

async function emitRuntimeNotification(options: {
  stageLabel: HandoffLabel;
  workspaceLabel: "A" | "B";
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
    `${marker}: Host ${options.workspaceLabel} 的 ${options.stageLabel} 通知触发 turn 未被接受`,
  );
  await options.markStage(`${options.stageLabel}:wait-assistant`);
  await waitForV4AssistantMessageContaining(options.taskResponse, 120_000);
  await options.markStage(`${options.stageLabel}:wait-idle`);
  const completed = await waitForV4ConversationState(
    (snapshot) =>
      Boolean(snapshot.taskId && snapshot.taskId !== "draft") &&
      snapshot.state === "idle" &&
      snapshot.queueCount === 0,
    `${marker}: Host ${options.workspaceLabel} runtime turn 未完成`,
    120_000,
  );
  const taskId = completed.taskId;
  if (!taskId)
    throw new Error(`Host ${options.workspaceLabel} runtime turn completed without taskId`);
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
      `Host ${options.workspaceLabel} runtime task is owned by ${taskSnapshot.workspaceKey}, expected ${expectedWorkspaceKey}`,
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
  }
  if (
    !notification ||
    notification.delivery_state !== "accepted" ||
    notification.outbox_state !== "accepted"
  ) {
    throw new Error(
      `Host ${options.workspaceLabel} runtime completion did not reach an accepted notification outbox state`,
    );
  }
  if (
    notification.workspace_identity !== options.identity ||
    notification.remote_session_id !== options.remoteSessionId
  ) {
    throw new Error(
      `Host ${options.workspaceLabel} notification lost its current workspace identity or remoteSessionId`,
    );
  }
  await writeEvidence(resultPath(options.stageLabel), {
    state: "runtime-completed-and-push-accepted",
    label: options.stageLabel,
    workspaceLabel: options.workspaceLabel,
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

async function waitForClickEvidence(
  label: HandoffLabel,
  expected: NotificationRow,
  dbPath: string,
) {
  await waitForFile(
    clickPath(label),
    `Android system-card click acknowledgement ${label}`,
    45 * 60_000,
  );
  const click = JSON.parse(await readFile(clickPath(label), "utf8")) as Record<string, unknown>;
  const expectedRoute =
    label === "revoked"
      ? { label, notificationId: expected.notification_id, rejected: true }
      : {
          label,
          notificationId: expected.notification_id,
          workspaceIdentity: expected.workspace_identity,
          remoteSessionId: expected.remote_session_id,
          taskId: expected.task_id,
          sessionId: expected.session_id,
        };
  for (const [key, value] of Object.entries(expectedRoute)) {
    if (click[key] !== value) throw new Error(`Android click ${label} evidence mismatched ${key}`);
  }
  const receiptCount = readReceiptCount(dbPath, expected.backend_id, expected.notification_id);
  const expectedReceiptCount = label === "revoked" ? 0 : 1;
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
    notificationId: expected.notification_id,
    readReceiptCount: receiptCount,
    confirmedRoute: expectedRoute,
  });
  await writeEvidence(verificationPath, { state: `click-${label}-verified`, results });
}

describe("P8 pending: multi-Host Android notification click routing", () => {
  it("completes real turns on two SSH identities and verifies each Android click receipt", async function () {
    this.timeout(90 * 60_000);
    if (
      !credentialPath ||
      !workspacePath ||
      sshPorts.some((port) => !Number.isSafeInteger(port)) ||
      passwordFiles.some((path) => !path)
    )
      this.skip();
    const credentials = JSON.parse(await readFile(credentialPath!, "utf8")) as P8Credentials;
    const [passwordA, passwordB] = await Promise.all(
      passwordFiles.map((path) => readFile(path, "utf8")),
    );
    const sshConfigs = [sshPorts[0], sshPorts[1]].map((port, index) => ({
      host: "127.0.0.1",
      port,
      username: "root",
      password: [passwordA, passwordB][index]!.trim(),
    })) as [SSHConnectionConfig, SSHConnectionConfig];
    await mkdir(sharedDir, { recursive: true, mode: 0o700 });
    const handoffLabels: HandoffLabel[] = ["A", "B", "revoked", "recovered"];
    await Promise.all(
      [
        readyPath,
        releasePath,
        verificationPath,
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
    let providerA: SSHLifecycleProvider | undefined;
    let providerB: SSHLifecycleProvider | undefined;
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

      providerA = await createSSHLifecycleProvider(sshConfigs[0], marker);
      disposeProviders.push(providerA);
      const targetA = await connectWorkspace(sshConfigs[0], "A");
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
      providerB = await createSSHLifecycleProvider(sshConfigs[1], marker);
      disposeProviders.push(providerB);
      const targetB = await connectWorkspace(sshConfigs[1], "B");
      if (
        targetA.identity === targetB.identity ||
        targetA.remoteSessionId === targetB.remoteSessionId
      ) {
        throw new Error(
          "The two SSH workspaces did not retain distinct identity and session scopes",
        );
      }

      await writeEvidence(readyPath, {
        state: "two-hosts-ready",
        gatewayUrl: credentials.gatewayUrl,
        namespace: credentials.namespace,
        backendId,
        workspacePath,
        e2eHome: getE2EAppDataPaths().homeDir,
        notificationDatabasePath: dbPath,
        hostPids,
        targets: [
          {
            label: "A",
            workspaceIdentity: targetA.identity,
            remoteSessionId: targetA.remoteSessionId,
          },
          {
            label: "B",
            workspaceIdentity: targetB.identity,
            remoteSessionId: targetB.remoteSessionId,
          },
        ],
        stages: [
          "trigger-A.json",
          "click-A.json",
          "trigger-B.json",
          "click-B.json",
          "trigger-revoked.json",
          "click-revoked.json",
          "trigger-recovered.json",
          "click-recovered.json",
          "release.json",
        ],
      });
      await markStage("waiting-for-android-ready-and-trigger-A");

      await waitForFile(
        triggerPath("A"),
        "trigger A after Android login and subscription setup",
        30 * 60_000,
      );
      const notificationA = await emitRuntimeNotification({
        stageLabel: "A",
        workspaceLabel: "A",
        handle: hostAHandle,
        identity: targetA.identity,
        remoteSessionId: targetA.remoteSessionId,
        taskResponse: "P8_MULTIHOST_A_RUNTIME_COMPLETION_OK",
        provider: providerA,
        backendId,
        dbPath,
        markStage,
      });
      if (readReceiptCount(dbPath, backendId, notificationA.notification_id) !== 0) {
        throw new Error("Notification A was read before the Android click was acknowledged");
      }
      await markStage("awaiting-android-click-A");
      await waitForClickEvidence("A", notificationA, dbPath);

      await waitForFile(triggerPath("B"), "trigger B after Android click A", 30 * 60_000);
      const notificationB = await emitRuntimeNotification({
        stageLabel: "B",
        workspaceLabel: "B",
        handle: windowBHandle,
        identity: targetB.identity,
        remoteSessionId: targetB.remoteSessionId,
        taskResponse: "P8_MULTIHOST_B_RUNTIME_COMPLETION_OK",
        provider: providerB,
        backendId,
        dbPath,
        markStage,
      });
      if (readReceiptCount(dbPath, backendId, notificationB.notification_id) !== 0) {
        throw new Error("Notification B was read before the Android click was acknowledged");
      }
      if (readReceiptCount(dbPath, backendId, notificationA.notification_id) !== 1) {
        throw new Error("Clicking B changed notification A's read receipt");
      }
      await markStage("awaiting-android-click-B");
      await waitForClickEvidence("B", notificationB, dbPath);
      if (readReceiptCount(dbPath, backendId, notificationA.notification_id) !== 1) {
        throw new Error("Clicking B changed notification A's read receipt");
      }
      await waitForFile(
        triggerPath("revoked"),
        "trigger C before device credential revocation",
        30 * 60_000,
      );
      const notificationC = await emitRuntimeNotification({
        stageLabel: "revoked",
        workspaceLabel: "A",
        handle: hostAHandle,
        identity: targetA.identity,
        remoteSessionId: targetA.remoteSessionId,
        taskResponse: "P8_MULTIHOST_REVOKED_RUNTIME_COMPLETION_OK",
        provider: providerA,
        backendId,
        dbPath,
        markStage,
      });
      if (readReceiptCount(dbPath, backendId, notificationC.notification_id) !== 0) {
        throw new Error("Notification C was read before the device credential was revoked");
      }
      await markStage("awaiting-device-revocation-and-old-card-click-C");
      await waitForClickEvidence("revoked", notificationC, dbPath);
      if (readReceiptCount(dbPath, backendId, notificationC.notification_id) !== 0) {
        throw new Error("Revoked device credential recorded a read receipt for the old card C");
      }

      await waitForFile(
        triggerPath("recovered"),
        "trigger D after Android credential reconfiguration",
        30 * 60_000,
      );
      const notificationD = await emitRuntimeNotification({
        stageLabel: "recovered",
        workspaceLabel: "B",
        handle: windowBHandle,
        identity: targetB.identity,
        remoteSessionId: targetB.remoteSessionId,
        taskResponse: "P8_MULTIHOST_RECOVERED_RUNTIME_COMPLETION_OK",
        provider: providerB,
        backendId,
        dbPath,
        markStage,
      });
      if (readReceiptCount(dbPath, backendId, notificationD.notification_id) !== 0) {
        throw new Error("Notification D was read before the recovered Android click");
      }
      await markStage("awaiting-recovered-credential-click-D");
      await waitForClickEvidence("recovered", notificationD, dbPath);
      if (
        readReceiptCount(dbPath, backendId, notificationA.notification_id) !== 1 ||
        readReceiptCount(dbPath, backendId, notificationB.notification_id) !== 1 ||
        readReceiptCount(dbPath, backendId, notificationD.notification_id) !== 1
      ) {
        throw new Error(
          "Final read receipt set failed A/B isolation or recovered D authorization check",
        );
      }
      const recoveredOldClickReceiptCount = readReceiptCount(
        dbPath,
        backendId,
        notificationC.notification_id,
      );
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
        throw new Error("Notification clicks changed the set of injected Local Host processes");
      }
      await writeEvidence(join(sharedDir, "final-host-pids.json"), {
        state: "host-process-set-unchanged",
        initialHostPids: hostPids,
        finalHostPids,
      });
      await markStage("awaiting-release-after-four-device-stages");
      await writeEvidence(join(sharedDir, "final-receipts.json"), {
        a: readReceiptCount(dbPath, backendId, notificationA.notification_id),
        b: readReceiptCount(dbPath, backendId, notificationB.notification_id),
        revokedCardC: recoveredOldClickReceiptCount,
        recoveredCardD: readReceiptCount(dbPath, backendId, notificationD.notification_id),
        note: "C is asserted unread when clicked under revoked credentials; re-authentication may consume the pending click later.",
      });
      await waitForFile(releasePath, "root release after device checks", 45 * 60_000);
    } finally {
      await Promise.all(
        disposeProviders.map((provider) => provider.tunnel.close().catch(() => undefined)),
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
