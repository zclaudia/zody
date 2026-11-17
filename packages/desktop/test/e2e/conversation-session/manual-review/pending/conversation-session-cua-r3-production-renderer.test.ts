import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TID_V4_COMPOSER_INPUT, TID_V4_COMPOSER_SEND } from "@zody/shared";
import { runR3ProductionRendererPreflight } from "../../../helpers/cua-r3-production-renderer.js";
import { readR1PermissionDialog, clickR1AllowOnce } from "../../../helpers/cua-r1-dialog.js";
import { readR2PermissionCards } from "../../../helpers/cua-r2-dialog.js";
import { readUpstreamToolResultFromRequest } from "../../../helpers/conversation-session-network.js";
import { fixtureWindows } from "../../../helpers/cua-r2-write-monitor.js";
import type { R2BusinessSnapshot } from "../../../helpers/cua-r2-receipt.js";
import {
  prepareV4ConversationE2E,
  getV4PaneSnapshot,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../../../helpers/upstream-replay-server.js";
import type { E2ENetworkCaptureArtifact } from "../../../helpers/network-capture-proxy.js";
import {
  seedCuaR1Provider,
  CUA_R1_MODEL,
  CUA_R1_PROVIDER,
} from "../../../helpers/cua-r1-provider.js";
import { selectRegistryProviderModelById } from "../../../helpers/upstream-provider.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  resolveE2ERuntimePath,
  createE2EReplayFixtureVariables,
} from "../../../helpers/e2e-runtime-paths.js";

const NAME = "conversation-session-cua-r3-production-renderer";
const MARKER = "E2E_CUA_R3_PRODUCTION_READ";
const TOOL_ID = "toolu_cua_r3_production_read";
const FIXTURES = resolve(import.meta.dirname, "../../../fixtures/upstream");
let evidence = "",
  manifestPath = "";
let server: UpstreamReplayServer | undefined, captured: E2ENetworkCaptureArtifact | undefined;
const record: Record<string, unknown> = {
  passed: false,
  writes: 0,
  liveModel: false,
  humanReviewComplete: false,
};
type Fixture = R2BusinessSnapshot & {
  title: string;
  targetMarker: string;
  siblingMarker: string;
  barrierEnabled: boolean;
};
const snapshot = async () => JSON.parse(await readFile(manifestPath, "utf8")) as Fixture;

describe("CUA-AX-R3-02 production renderer without store observation bridge", () => {
  before(async function () {
    this.timeout(120_000);
    evidence = process.env.ZODY_CUA_R3_EVIDENCE_DIR?.trim() ?? "";
    manifestPath = process.env.ZODY_CUA_R3_FIXTURE_MANIFEST?.trim() ?? "";
    if (![evidence, manifestPath].every(isAbsolute))
      throw new Error("R3 requires explicit isolated evidence and fixture");
    await mkdir(evidence, { recursive: true });
    const f = await snapshot();
    if (
      f.fixtureKind !== "controlled-ax-write-v1" ||
      f.barrierEnabled ||
      f.targetMarker !== "E2E_R2_TARGET_BODY" ||
      f.siblingMarker !== "E2E_R2_SIBLING_BODY"
    )
      throw new Error("R3 controlled fixture mismatch");
    process.kill(f.pid, 0);
    await mkdir(resolveE2ERuntimePath("cua-r3-production"), { recursive: true });
    await writeFile(resolveE2ERuntimePath("cua-r3-production", "manifest.json"), JSON.stringify(f));
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "replay.json"),
      artifactWriter: async (_p, artifact) => {
        captured = artifact as E2ENetworkCaptureArtifact;
      },
      fixtureVariables: createE2EReplayFixtureVariables(),
      fixturePaths: [
        resolve(FIXTURES, "common.json"),
        resolve(FIXTURES, `conversation-session/${NAME}.json`),
      ],
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: () => seedCuaR1Provider(server!.baseUrl),
    });
    await runR3ProductionRendererPreflight();
    record.process = await browser.electron.execute((electron) => ({
      pid: process.pid,
      cwd: process.cwd(),
      executable: electron.app.getPath("exe"),
      appPath: electron.app.getAppPath(),
      packaged: electron.app.isPackaged,
      screenPermission: electron.systemPreferences.getMediaAccessStatus("screen"),
    }));
    const facts = record.process as { cwd: string; executable: string; packaged: boolean };
    expect(facts.cwd).toBe(process.cwd());
    expect(facts.executable).toBe(process.env.ZODY_E2E_PACKAGED_APP_PATH);
    expect(facts.packaged).toBe(true);
    record.storeBridgeAbsent = await browser.execute(() => !("__zcodeSessionStoreE2E" in window));
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectRegistryProviderModelById(CUA_R1_MODEL, {
      providerId: CUA_R1_PROVIDER,
      providerName: "CUA R1 fixture",
      includePlainModelFallback: false,
    });
  });
  after(async () => {
    await server?.stop();
    if (captured)
      record.network = {
        requestCount: captured.records.length,
        complete: captured.records.filter((r) => r.status === "complete").length,
      };
    if (evidence)
      await writeFile(
        resolve(evidence, "production-renderer-receipt.json"),
        JSON.stringify(record, null, 2) + "\n",
        { mode: 0o600 },
      );
  });
  it("cold starts outside the repo and delivers one independently authorized target read through ordinary DOM", async function () {
    this.timeout(180_000);
    const before = await snapshot();
    record.before = before;
    const inspector = process.env.ZODY_CUA_R2_WINDOW_INSPECTOR?.trim() ?? "";
    const windowsBefore = await fixtureWindows(inspector, before);
    record.windowsBefore = windowsBefore;
    expect(windowsBefore.length).toBe(2);
    const input = await browser.$(
      `[data-testid="${TID_V4_COMPOSER_INPUT}"][contenteditable="true"]`,
    );
    await input.waitForClickable({ timeout: 30_000 });
    await input.click();
    // 普通WebDriver键入让Lexical执行真实输入路径；不调用/注入其测试bridge，不直接改DOM文本。
    await browser.keys(`${MARKER}: run the controlled observation fixture.`);
    const send = await browser.$(`[data-testid="${TID_V4_COMPOSER_SEND}"]`);
    await send.waitForEnabled({ timeout: 30_000 });
    await send.click();
    record.submittedOnce = true;
    await browser.waitUntil(
      async () =>
        browser
          .execute(
            (marker, inputId) => ({
              userRow: Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).some(
                (row) =>
                  row.classList.contains("group/user-row") &&
                  (row.textContent ?? "").includes(marker),
              ),
              composerEmpty: !(
                document.querySelector<HTMLElement>(`[data-testid="${inputId}"]`)?.textContent ?? ""
              ).trim(),
            }),
            MARKER,
            TID_V4_COMPOSER_INPUT,
          )
          .then((r) => r.userRow && r.composerEmpty),
      { timeout: 60_000, interval: 100, timeoutMsg: "R3 single submit was not visibly accepted" },
    );
    record.accepted = true;
    const answered = new Set<string>();
    let readCount = 0,
      nodeAllowed = false;
    await browser.waitUntil(
      async () => {
        const dialog = await readR1PermissionDialog();
        if (dialog.kind === "node" && !nodeAllowed) {
          await clickR1AllowOnce("node");
          nodeAllowed = true;
          return false;
        }
        const cards = await readR2PermissionCards();
        for (const card of cards) {
          if (!card.requestId || answered.has(card.requestId)) continue;
          if (
            card.kind !== "read" ||
            !card.defaultReject ||
            card.forbidden ||
            card.identity?.pid !== before.pid ||
            card.identity.windowId !== before.targetWindow ||
            readCount !== 0
          )
            throw new Error("R3 read card scope/default rejection mismatch");
          answered.add(card.requestId);
          readCount++;
          record.readCard = card;
          await clickR1AllowOnce("read", card.requestId);
          return false;
        }
        return Boolean(
          captured?.records.some((r) => readUpstreamToolResultFromRequest(r.requestJson, TOOL_ID)),
        );
      },
      {
        timeout: 120_000,
        interval: 100,
        timeoutMsg: "R3 independent read or actual provider result missing",
      },
    );
    const result = captured?.records
      .map((r) => readUpstreamToolResultFromRequest(r.requestJson, TOOL_ID))
      .find(Boolean);
    if (!result || result.isError || !result.content.includes("E2E_R3_PRODUCTION_READ_OK"))
      throw new Error("R3 real SDK tool result did not prove target read");
    const diag = /R1_DIAG:(\{[^\n]+\})/.exec(result.content);
    record.result = {
      isError: result.isError,
      marker: true,
      targetSeen: result.content.includes('"targetSeen":true'),
      siblingLeak: result.content.includes('"siblingLeak":true'),
      diagnosticPresent: Boolean(diag),
    };
    expect(result.content).toContain('"targetSeen":true');
    expect(result.content).toContain('"siblingLeak":false');
    expect(readCount).toBe(1);
    await waitForV4TimelineContaining(`${MARKER}_DONE`, 60_000);
    const after = await snapshot();
    record.after = after;
    record.windowsAfter = await fixtureWindows(inspector, after);
    expect(after).toEqual(before);
    expect(record.windowsAfter).toEqual(windowsBefore);
    record.session = await getV4PaneSnapshot();
    expect((record.session as { sessionId: string }).sessionId).not.toBe("draft");
    expect(record.storeBridgeAbsent).toBe(true);
    record.passed = true;
  });
});
