import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { prepareR3NormalHost } from "../../../helpers/cua-r3-normal-host.js";
import { isAbsolute, resolve } from "node:path";
import {
  readR2PermissionCards,
  answerR2Permission,
  allowR2NodePermission,
} from "../../../helpers/cua-r2-dialog.js";
import { readR1PermissionDialog } from "../../../helpers/cua-r1-dialog.js";
import {
  parseR1IdentityRows,
  r1IdentityMatches,
  projectR1NetworkStats,
} from "../../../helpers/cua-r1-receipt.js";
import { screenshotEvidence } from "../../../helpers/cua-screenshot-evidence.js";
import {
  r2PngDigest,
  r2CaptureAuditFromLog,
  r2CaptureRejectionsFromLog,
} from "../../../helpers/cua-r2-capture-evidence.js";
import { controlAudits, fixtureWindows } from "../../../helpers/cua-r2-write-monitor.js";
import {
  inspectR2Effect,
  type R2BusinessSnapshot,
  type R2WriteReceipt,
} from "../../../helpers/cua-r2-receipt.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { readUpstreamToolResultFromRequest } from "../../../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../../../helpers/network-capture-proxy.js";
import {
  CUA_SCREENSHOT_MODEL,
  CUA_SCREENSHOT_PROVIDER,
  seedCuaScreenshotProvider,
} from "../../../helpers/cua-screenshot-provider.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  createE2EReplayFixtureVariables,
  resolveE2ERuntimePath,
} from "../../../helpers/e2e-runtime-paths.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../../../helpers/upstream-replay-server.js";
import { selectRegistryProviderModelById } from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const NAME = "conversation-session-cua-r2-capture";
const TOOL_ID = "toolu_cua_r2_capture";
const MARKER = "E2E_CUA_R2_CAPTURE";
let server: UpstreamReplayServer | undefined;
let captured: E2ENetworkCaptureArtifact | undefined;
let evidence = "",
  manifestPath = "",
  logDirectory = "",
  inspector = "";
let auditBaseline: { control: number; capture: number; rejection: number } | undefined;
const record: Record<string, unknown> = {
  passed: false,
  liveAcceptance: false,
  decisions: [],
};
type Fixture = R2BusinessSnapshot & {
  title: string;
  targetMarker: string;
  siblingMarker: string;
  barrierEnabled: boolean;
};
async function snapshot(): Promise<Fixture> {
  const f = JSON.parse(await readFile(manifestPath, "utf8")) as Fixture;
  if (
    f.fixtureKind !== "controlled-ax-write-v1" ||
    !Number.isSafeInteger(f.pid) ||
    f.pid <= 0 ||
    !Number.isSafeInteger(f.targetWindow) ||
    !Number.isSafeInteger(f.siblingWindow) ||
    f.targetWindow <= 0 ||
    f.siblingWindow <= 0 ||
    f.targetWindow === f.siblingWindow ||
    typeof f.title !== "string" ||
    !f.title ||
    f.barrierEnabled !== false ||
    f.targetMarker !== "E2E_R2_TARGET_BODY" ||
    f.siblingMarker !== "E2E_R2_SIBLING_BODY" ||
    f.target.ignoreEffects !== false
  )
    throw new Error("R2 capture fixture identity or no-barrier mode invalid");
  process.kill(f.pid, 0);
  return f;
}
async function captureAudits() {
  const names = (await readdir(logDirectory)).filter((name) =>
    /^\d{4}-\d{2}-\d{2}\.log$/.test(name),
  );
  const logs = await Promise.all(
    names.sort().map((name) => readFile(resolve(logDirectory, name), "utf8")),
  );
  return logs.flatMap(r2CaptureAuditFromLog);
}
async function captureRejections() {
  const names = (await readdir(logDirectory)).filter((name) =>
    /^\d{4}-\d{2}-\d{2}\.log$/.test(name),
  );
  const logs = await Promise.all(
    names.sort().map((name) => readFile(resolve(logDirectory, name), "utf8")),
  );
  return logs.flatMap(r2CaptureRejectionsFromLog);
}
/** 截图卡不依赖正文卡；仅在唯一可见、目标精确且默认拒绝时确认 allow-once。 */
async function allowScreenshot(pid: number, windowId: number) {
  const card = await browser.execute(() => {
    const lists = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
      (list) =>
        ["Permission required", "需要权限"].includes(list.getAttribute("aria-label") ?? "") &&
        list.getClientRects().length > 0,
    );
    if (lists.length !== 1 || lists[0]?.closest("[data-cua-confirm-kind]")) return null;
    const root = lists[0]?.parentElement?.parentElement?.parentElement;
    const rows = Array.from(
      root?.querySelectorAll('[data-cua-screenshot-confirm-target="true"] dl dt') ?? [],
    ).map((dt): [string, string] => [
      (dt.textContent ?? "").trim(),
      dt.nextElementSibling?.tagName === "DD"
        ? (dt.nextElementSibling.textContent ?? "").trim()
        : "",
    ]);
    const selected = lists[0]?.querySelector('[role="option"][aria-selected="true"]');
    return {
      rows,
      requestId:
        lists[0]
          ?.closest("[data-permission-request-id]")
          ?.getAttribute("data-permission-request-id") ?? null,
      defaultReject: selected?.getAttribute("data-permission-option-kind") === "rejectOnce",
    };
  });
  if (
    !card ||
    !r1IdentityMatches(parseR1IdentityRows(card.rows), pid, windowId) ||
    !card.defaultReject ||
    !card.requestId
  )
    throw new Error("R2 capture screenshot card identity/default rejection mismatch");
  for (let n = 0; n < 2; n++) {
    const clicked = await browser.execute(
      (shouldAlreadyBeSelected, expectedId) => {
        const lists = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"]')).filter(
          (list) =>
            ["Permission required", "需要权限"].includes(list.getAttribute("aria-label") ?? "") &&
            list.getClientRects().length > 0,
        );
        if (
          lists.length !== 1 ||
          lists[0]?.closest("[data-cua-confirm-kind]") ||
          lists[0]
            ?.closest("[data-permission-request-id]")
            ?.getAttribute("data-permission-request-id") !== expectedId
        )
          return false;
        const button = lists[0]?.querySelector<HTMLButtonElement>(
          '[data-permission-option-kind="allowOnce"]',
        );
        if (
          !button ||
          button.disabled ||
          (button.getAttribute("aria-selected") === "true") !== shouldAlreadyBeSelected
        )
          return false;
        button.click();
        return true;
      },
      n === 1,
      card.requestId,
    );
    if (!clicked) throw new Error("R2 capture screenshot allow-once control unavailable");
    if (n === 0)
      await browser.waitUntil(
        () =>
          browser.execute((expectedId) => {
            const lists = Array.from(
              document.querySelectorAll<HTMLElement>('[role="listbox"]'),
            ).filter(
              (list) =>
                ["Permission required", "需要权限"].includes(
                  list.getAttribute("aria-label") ?? "",
                ) && list.getClientRects().length > 0,
            );
            return (
              lists.length === 1 &&
              !lists[0]?.closest("[data-cua-confirm-kind]") &&
              lists[0]
                ?.closest("[data-permission-request-id]")
                ?.getAttribute("data-permission-request-id") === expectedId &&
              lists[0]
                ?.querySelector('[data-permission-option-kind="allowOnce"]')
                ?.getAttribute("aria-selected") === "true"
            );
          }, card.requestId),
        { timeout: 10_000, interval: 30 },
      );
  }
  await browser.waitUntil(
    () =>
      browser.execute(
        (expectedId) =>
          !Array.from(document.querySelectorAll<HTMLElement>("[data-permission-request-id]")).some(
            (root) =>
              root.getAttribute("data-permission-request-id") === expectedId &&
              root.getClientRects().length > 0,
          ),
        card.requestId,
      ),
    { timeout: 10_000, interval: 30 },
  );
  return card.requestId;
}
function safeFailure(content: string, isError: boolean) {
  const codes = [
    ...new Set(
      content.match(
        /\b(?:permission_denied|not_authorized|screen_locked|broker_unavailable|element_unavailable|structured_state_unavailable|action_unavailable|timeout|invalid_request|stale_state|internal|cua_native_capture_closed|R2_CAPTURE_[A-Z_]+)\b/gi,
      ) ?? [],
    ),
  ];
  return { received: true, isError, codes };
}
function validateWindows(rows: Array<{ id: number; pid: number; title: string }>, f: Fixture) {
  return (
    rows.length === 2 &&
    rows.some((row) => row.id === f.targetWindow && row.pid === f.pid && row.title === f.title) &&
    rows.some((row) => row.id === f.siblingWindow && row.pid === f.pid && row.title === f.title)
  );
}

describe("CUA R2 same-scope screenshot borrows control lease", () => {
  before(async function () {
    this.timeout(process.env.ZODY_CUA_R3_NORMAL_HOST === "1" ? 1_800_000 : 120_000);
    const binary = process.env.ZODY_E2E_PACKAGED_APP_PATH?.trim() ?? "";
    manifestPath = process.env.ZODY_CUA_R2_FIXTURE_MANIFEST?.trim() ?? "";
    evidence = process.env.ZODY_CUA_R2_EVIDENCE_DIR?.trim() ?? "";
    logDirectory = process.env.ZODY_E2E_RUNTIME_LOG_DIR?.trim() ?? "";
    inspector = process.env.ZODY_CUA_R2_WINDOW_INSPECTOR?.trim() ?? "";
    if (
      process.platform !== "darwin" ||
      ![binary, manifestPath, evidence, logDirectory, inspector].every(isAbsolute) ||
      binary.startsWith("/Applications/")
    )
      throw new Error(
        "R2 capture requires an independent signed candidate, normal fixture, log directory and window inspector",
      );
    if (process.env.ZODY_CUA_R3_NORMAL_HOST === "1") await prepareR3NormalHost();
    const f = await snapshot();
    await mkdir(evidence, { recursive: true });
    await mkdir(resolveE2ERuntimePath("cua-r2-capture"), { recursive: true });
    await writeFile(resolveE2ERuntimePath("cua-r2-capture", "manifest.json"), JSON.stringify(f), {
      mode: 0o600,
    });
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "r2-capture-replay.json"),
      artifactWriter: async (_path, artifact) => {
        captured = artifact as E2ENetworkCaptureArtifact;
      },
      fixtureVariables: createE2EReplayFixtureVariables(),
      fixturePaths: [
        resolve(process.cwd(), "test/e2e/fixtures/upstream/common.json"),
        resolve(process.cwd(), `test/e2e/fixtures/upstream/conversation-session/${NAME}.json`),
      ],
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: () => seedCuaScreenshotProvider(server!.baseUrl),
    });
    await prepareV4ConversationE2E({ skipProvider: true });
  });
  after(async () => {
    await server?.stop();
    if (isAbsolute(logDirectory) && auditBaseline) {
      record.captureRejections = (await captureRejections().catch(() => [])).slice(
        auditBaseline.rejection,
      );
      record.partialControlAudits = (await controlAudits().catch(() => [])).slice(
        auditBaseline.control,
      );
      record.partialCaptureAudits = (await captureAudits().catch(() => [])).slice(
        auditBaseline.capture,
      );
    }
    if (evidence)
      await writeFile(
        resolve(evidence, "r2-capture-receipt.json"),
        JSON.stringify(
          {
            ...record,
            network: projectR1NetworkStats(captured, CUA_SCREENSHOT_MODEL),
            humanReviewComplete: false,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    await clearAppData();
  });
  it("retains control across independently confirmed pixel capture", async function () {
    this.timeout(180_000);
    const before = await snapshot(),
      windowsBefore = await fixtureWindows(inspector, before);
    if (!validateWindows(windowsBefore, before))
      throw new Error("R2 capture initial OS window metadata mismatch");
    record.before = before;
    record.windowsBefore = windowsBefore;
    const controlBaseline = (await controlAudits()).length,
      captureBaseline = (await captureAudits()).length;
    auditBaseline = {
      control: controlBaseline,
      capture: captureBaseline,
      rejection: (await captureRejections()).length,
    };
    await startNewV4Draft();
    await selectRegistryProviderModelById(CUA_SCREENSHOT_MODEL, {
      providerId: CUA_SCREENSHOT_PROVIDER,
      providerName: "CUA R1 fixture",
      includePlainModelFallback: false,
    });
    await sendV4PromptAndWaitAccepted(
      `${MARKER}: run the controlled fixture.`,
      MARKER,
      "R2 capture submission missing",
    );
    const answered = new Set<string>();
    const decisions: Array<{
      kind: string;
      requestId: string;
      identity: { pid: number; windowId: number };
    }> = [];
    let screenshotCount = 0,
      failure: unknown;
    await browser.waitUntil(
      async () => {
        try {
          for (const card of await readR2PermissionCards()) {
            if (
              (card.kind !== "read" && card.kind !== "control") ||
              !card.requestId ||
              answered.has(card.requestId)
            )
              continue;
            if (
              !card.defaultReject ||
              card.forbidden ||
              !card.identity ||
              card.identity.pid !== before.pid ||
              card.identity.windowId !== before.targetWindow
            )
              throw new Error(
                "R2 capture read/control card identity or default rejection mismatch",
              );
            answered.add(card.requestId);
            await answerR2Permission(card.kind, true, card.requestId);
            decisions.push({
              kind: card.kind,
              requestId: card.requestId,
              identity: card.identity,
            });
            record.decisions = decisions;
            return false;
          }
          if (await allowR2NodePermission()) return false;
          const dialog = await readR1PermissionDialog();
          if (dialog.kind === "other") {
            if (screenshotCount !== 0)
              throw new Error("R2 capture unexpected extra screenshot card");
            const screenshotId = await allowScreenshot(before.pid, before.targetWindow);
            if (answered.has(screenshotId))
              throw new Error("R2 capture screenshot reused another confirmation request");
            answered.add(screenshotId);
            screenshotCount++;
            record.screenshotCount = screenshotCount;
            record.screenshotRequestId = screenshotId;
            return false;
          }
          return Boolean(
            captured?.records.some((row) =>
              readUpstreamToolResultFromRequest(row.requestJson, TOOL_ID),
            ),
          );
        } catch (error) {
          failure = error;
          return true;
        }
      },
      {
        timeout: 120_000,
        interval: 100,
        timeoutMsg: "R2 capture independent permissions or tool result missing",
      },
    );
    const requests = captured?.records ?? [];
    const result = requests
      .map((row) => readUpstreamToolResultFromRequest(row.requestJson, TOOL_ID))
      .find(Boolean);
    if (result) record.toolResult = safeFailure(result.content, result.isError);
    if (failure) throw failure;
    if (!result || result.isError)
      throw new Error("R2 capture actual tool result failed; see safe evidence");
    await waitForV4TimelineContaining(`${MARKER}_DONE`, 60_000);
    const match = result.content.match(/R2_CAPTURE_RECEIPT:(\{[^\n]*\})/);
    if (!match) throw new Error("R2 capture actual receipt missing");
    const parsed = JSON.parse(match[1]!) as {
      pid: number;
      windowId: number;
      firstStateId: string;
      combinedStateId: string;
      combinedIndex: number;
      receipts: R2WriteReceipt[];
    };
    if (
      parsed.pid !== before.pid ||
      parsed.windowId !== before.targetWindow ||
      typeof parsed.firstStateId !== "string" ||
      !/^[0-9]{1,20}$/.test(parsed.firstStateId) ||
      typeof parsed.combinedStateId !== "string" ||
      !/^[0-9]{1,20}$/.test(parsed.combinedStateId) ||
      parsed.firstStateId === parsed.combinedStateId ||
      !Number.isSafeInteger(parsed.combinedIndex) ||
      parsed.combinedIndex < 0 ||
      !Array.isArray(parsed.receipts) ||
      parsed.receipts.length !== 2
    )
      throw new Error("R2 capture state/receipt association invalid");
    const safeReceipts: R2WriteReceipt[] = parsed.receipts.map((receipt) => {
      if (
        !receipt ||
        receipt.action_sent !== true ||
        receipt.dispatch_status !== "sent" ||
        receipt.code !== undefined ||
        !["not_requested", "synced"].includes(receipt.state_sync_status)
      )
        throw new Error("R2 capture action receipt invalid");
      return {
        action_sent: true,
        dispatch_status: "sent",
        state_sync_status: receipt.state_sync_status,
      };
    });
    // 同一真实 tool_result 可在多个 provider continuation 中重现；每份都必须只有一个相同 PNG。
    const images = requests
      .map((row) => ({
        basic: screenshotEvidence(row.requestJson, TOOL_ID),
        digest: r2PngDigest(row.requestJson, TOOL_ID),
      }))
      .filter((item) => item.basic.imageCount > 0);
    const firstImage = images[0];
    if (
      !firstImage?.basic.valid ||
      !firstImage.digest ||
      images.some(
        (item) =>
          !item.basic.valid ||
          item.basic.imageCount !== 1 ||
          !item.digest ||
          item.basic.width !== item.digest.width ||
          item.basic.height !== item.digest.height ||
          JSON.stringify(item.digest) !== JSON.stringify(firstImage.digest),
      )
    )
      throw new Error("R2 capture provider PNG missing or ambiguous");
    const digest = firstImage.digest;
    record.png = digest;
    let after = await snapshot();
    await browser.waitUntil(
      async () => {
        after = await snapshot();
        return after.target.requests - before.target.requests >= 2;
      },
      { timeout: 10_000 },
    );
    const windowsAfter = await fixtureWindows(inspector, after);
    const effect = inspectR2Effect({
      before,
      after,
      method: "left_click",
      receipts: safeReceipts,
      count: 2,
    });
    record.after = after;
    record.windowsAfter = windowsAfter;
    record.effect = effect;
    record.receipts = safeReceipts;
    if (!effect.ok || !validateWindows(windowsAfter, after))
      throw new Error("R2 capture independent target/sibling effect invalid");
    await browser.waitUntil(
      async () =>
        (await controlAudits()).length >= controlBaseline + 4 &&
        (await captureAudits()).length >= captureBaseline + 1,
      {
        timeout: 15_000,
        interval: 100,
        timeoutMsg: "R2 capture actual native audits missing",
      },
    );
    const controls = (await controlAudits()).slice(controlBaseline),
      captures = (await captureAudits()).slice(captureBaseline);
    record.controlAudits = controls;
    record.captureAudits = captures;
    if (controls.length !== 4 || captures.length !== 1)
      throw new Error("R2 capture native audit count mismatch");
    const [a, b, c, d] = controls;
    if (
      a.event !== "admitted" ||
      b.event !== "completed" ||
      c.event !== "admitted" ||
      d.event !== "completed" ||
      a.dispatch_status !== "possibly_sent" ||
      b.dispatch_status !== "sent" ||
      c.dispatch_status !== "possibly_sent" ||
      d.dispatch_status !== "sent" ||
      !Number.isSafeInteger(a.attempt) ||
      a.attempt < 1 ||
      a.attempt !== b.attempt ||
      !Number.isSafeInteger(c.attempt) ||
      c.attempt <= a.attempt ||
      c.attempt !== d.attempt ||
      !/^[a-f0-9]{16}$/.test(a.scope) ||
      [b, c, d].some((row) => row.scope !== a.scope)
    )
      throw new Error("R2 capture control audit association mismatch");
    const cap = captures[0]!;
    if (
      cap.sha256 !== digest.sha256 ||
      cap.bytes !== digest.bytes ||
      cap.width !== digest.width ||
      cap.height !== digest.height ||
      cap.machineLeaseReleased !== false ||
      cap.machineLeaseBorrowReturned !== true
    )
      throw new Error("R2 capture PNG/native borrow evidence mismatch");
    if (
      screenshotCount !== 1 ||
      decisions.filter((d) => d.kind === "read").length < 3 ||
      decisions.filter((d) => d.kind === "control").length !== 2
    )
      throw new Error("R2 capture independent confirmation sequence incomplete");
    record.controlAudits = controls;
    record.captureAudit = cap;
    record.stateIds = {
      first: parsed.firstStateId,
      combined: parsed.combinedStateId,
    };
    record.passed = true;
  });
});
