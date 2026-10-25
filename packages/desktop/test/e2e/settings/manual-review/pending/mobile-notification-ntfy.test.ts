import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import { clickTestIdByDom } from "../../../helpers/desktop-app.js";
import { dismissOccupationOnboarding } from "../../../helpers/occupation-onboarding.js";
import {
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  seedSettings,
  setInputValueByTestIdDom,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  getV4PaneSnapshot,
} from "../../../helpers/v4-conversation.js";

type P8Credentials = {
  gatewayUrl: string;
  namespace: string;
  adminToken: string;
  backendCredential: string;
};

type NotificationRow = {
  notification_id: string;
  backend_id: string;
  task_id: string;
  session_id: string;
  source_event_id: string;
  source_kind: string;
  kind: string;
  delivery_state: string;
  outbox_state: string;
  attempts: number;
  occurred_at: string;
};

const marker = "E2E_MOBILE_PHASE1_P8_PUSH";
const sharedDir = join(process.cwd(), ".tmp/mobile-remote-p8-push");
const mf08SourceDir = resolve(process.cwd(), "../../.tmp/mobile-remote-p8-push/workspace/mf08");
const mf08WorkspacePath = join(DEFAULT_WORKSPACE, "MF08-fixtures");
const readyPath = join(sharedDir, "desktop-ready.json");
const triggerPath = join(sharedDir, "trigger-task.json");
const resultPath = join(sharedDir, "desktop-result.json");
const clickVerifiedPath = join(sharedDir, "click-verified.json");
const releasePath = join(sharedDir, "release.json");
const stagePath = join(sharedDir, "desktop-stage.json");
const credentialsPath = process.env.ZODY_P8_CREDENTIAL_FILE?.trim();

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
      success?: boolean;
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
      .prepare(
        `SELECT n.notification_id, n.backend_id, n.task_id, n.session_id, n.source_event_id,
          n.source_kind, n.kind, n.delivery_state, n.occurred_at,
          o.state AS outbox_state, o.attempts
        FROM mobile_notification n JOIN mobile_notification_outbox o USING(notification_id)
        WHERE n.backend_id = ? AND n.task_id = ? AND n.source_kind = 'turn.completed'
        ORDER BY n.occurred_at DESC LIMIT 1`,
      )
      .get(backendId, taskId) as NotificationRow | undefined;
  } finally {
    database.close();
  }
}

function readReceiptCount(dbPath: string, backendId: string, notificationId: string) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count FROM mobile_notification_read
         WHERE backend_id = ? AND notification_id = ?`,
      )
      .get(backendId, notificationId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

async function setRemoteAccess(credentials: P8Credentials) {
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
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({
    timeout: 15_000,
  });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteAccess"));
  await $('[data-testid="remote-access-settings"]').waitForDisplayed({
    timeout: 15_000,
  });
  await setInputValueByTestIdDom("remote-access-credential", credentials.backendCredential, {
    timeout: 15_000,
  });
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

describe("P8 pending: isolated Gateway → ntfy → Android task completion click", () => {
  it("produces a real runtime completion, waits for Android click, and records the scoped read receipt", async function () {
    this.timeout(45 * 60_000);
    if (!credentialsPath) this.skip();
    const credentials = JSON.parse(await readFile(credentialsPath!, "utf8")) as P8Credentials;
    await Promise.all(
      [readyPath, triggerPath, resultPath, clickVerifiedPath, releasePath, stagePath].map((path) =>
        rm(path, { force: true }),
      ),
    );
    const markStage = async (stage: string) =>
      writeEvidence(stagePath, { stage, at: new Date().toISOString() });
    await markStage("onboarding");
    await dismissOccupationOnboarding();
    await markStage("remote-access-settings");
    await setRemoteAccess(credentials);
    await markStage("gateway-backend-online");
    const backendId = await getOnlineBackend(credentials);

    // Setup uses the normal E2E provider configuration; the submitted prompt still enters the CLI runtime.
    await markStage("provider-setup");
    await prepareV4ConversationE2E();
    await markStage("provider-ready");
    await cp(mf08SourceDir, mf08WorkspacePath, { recursive: true, force: true });
    const mf08ManifestPath = join(mf08WorkspacePath, "manifest.json");
    const mf08Manifest = JSON.parse(await readFile(mf08ManifestPath, "utf8")) as {
      workspacePath: string;
      files: Array<{ name: string; path: string }>;
    };
    mf08Manifest.workspacePath = mf08WorkspacePath;
    mf08Manifest.files = mf08Manifest.files.map((file) => ({
      ...file,
      path: join(mf08WorkspacePath, file.name),
    }));
    await writeFile(mf08ManifestPath, `${JSON.stringify(mf08Manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await markStage("mf08-fixtures-ready");
    await writeEvidence(readyPath, {
      state: "desktop-ready",
      gatewayUrl: credentials.gatewayUrl,
      namespace: credentials.namespace,
      backendId,
      workspacePath: DEFAULT_WORKSPACE,
      mf08FixturePath: mf08WorkspacePath,
      expectedPromptMarker: marker,
      triggerFile: triggerPath,
      resultFile: resultPath,
      clickVerifiedFile: clickVerifiedPath,
      releaseFile: releasePath,
    });

    await waitForFile(triggerPath, "Android ready/background trigger", 15 * 60_000);
    await markStage("runtime-turn-submitted");
    await sendV4Prompt(`${marker} Please respond with the exact text P8_RUNTIME_COMPLETION_OK.`);
    await waitForV4TimelineContaining("P8_RUNTIME_COMPLETION_OK", 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "runtime turn did not complete",
      60_000,
    );
    const taskId = (await getV4PaneSnapshot()).sessionId;
    if (!taskId || taskId === "draft")
      throw new Error("Completed runtime fixture did not retain its task id");

    const dbPath = join(getE2EAppDataPaths().homeDir, ".zody", "v2", "mobile-notifications.sqlite");
    const deadline = Date.now() + 45_000;
    let notification: NotificationRow | undefined;
    while (Date.now() < deadline) {
      try {
        notification = readNotification(dbPath, backendId, taskId);
      } catch {
        /* Database may not exist before the first real event. */
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
      throw new Error("Runtime completion did not reach an accepted Host outbox state");
    }
    await writeEvidence(resultPath, {
      state: "runtime-completed-and-ntfy-accepted",
      backendId,
      workspacePath: DEFAULT_WORKSPACE,
      taskId,
      sessionId: notification.session_id,
      notificationId: notification.notification_id,
      sourceEventId: notification.source_event_id,
      sourceKind: notification.source_kind,
      kind: notification.kind,
      deliveryState: notification.delivery_state,
      outboxState: notification.outbox_state,
      attempts: notification.attempts,
      occurredAt: notification.occurred_at,
      sqliteRow: notification,
    });
    await markStage("awaiting-android-click");

    await waitForFile(
      clickVerifiedPath,
      "Android notification tap and task route verification",
      20 * 60_000,
    );
    const receiptDeadline = Date.now() + 60_000;
    while (
      Date.now() < receiptDeadline &&
      readReceiptCount(dbPath, backendId, notification.notification_id) < 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (readReceiptCount(dbPath, backendId, notification.notification_id) < 1) {
      throw new Error(
        "Android click did not produce a notification read receipt after route verification",
      );
    }
    await writeEvidence(resultPath, {
      state: "click-route-read-receipt-recorded",
      backendId,
      taskId,
      notificationId: notification.notification_id,
      readReceiptCount: readReceiptCount(dbPath, backendId, notification.notification_id),
    });
    await markStage("awaiting-release");
    await waitForFile(releasePath, "operator release after remaining device checks", 30 * 60_000);
  });
});
