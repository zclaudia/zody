import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { readUpstreamToolResultFromRequest } from "../../../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../../../helpers/network-capture-proxy.js";
import {
  CUA_R1_MODEL,
  CUA_R1_PROVIDER,
  seedCuaR1Provider,
} from "../../../helpers/cua-r1-provider.js";
import {
  createE2EReplayFixtureVariables,
  resolveE2ERuntimePath,
} from "../../../helpers/e2e-runtime-paths.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../../../helpers/upstream-replay-server.js";
import { selectRegistryProviderModelById } from "../../../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  startNewV4Draft,
  sendV4PromptAndWaitAccepted,
  waitForV4TimelineContaining,
  getV4PaneSnapshot,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";
import {
  readR2PermissionCards,
  answerR2Permission,
  allowR2NodePermission,
} from "../../../helpers/cua-r2-dialog.js";
import { controlAudits } from "../../../helpers/cua-r2-write-monitor.js";
import { readCEvents, readOptional, writeCControl } from "../../../helpers/cua-r1-read-monitor.js";
import { listToolCallBlocks } from "../../../helpers/conversation-session-tool.js";
import { readCuaV4SessionPhase } from "../../../helpers/cua-v4-session-phase.js";

async function waitFacts(
  check: () => Promise<boolean>,
  options: Parameters<typeof browser.waitUntil>[1],
) {
  let failure: unknown;
  await browser.waitUntil(async () => {
    try {
      return await check();
    } catch (error) {
      failure = error;
      return true;
    }
  }, options);
  if (failure) throw failure;
}
const NAME = "conversation-session-cua-r2-stop";
let server: UpstreamReplayServer | undefined, captured: E2ENetworkCaptureArtifact | undefined;
let fixturePath = "",
  evidence = "";
const records: any[] = [];
async function snapshot() {
  const f = JSON.parse(await readFile(fixturePath, "utf8"));
  if (
    f.fixtureKind !== "controlled-ax-write-v1" ||
    f.barrierEnabled !== true ||
    !Number.isSafeInteger(f.pid) ||
    !Number.isSafeInteger(f.targetWindow) ||
    f.targetWindow === f.siblingWindow
  )
    throw Error("R2 Stop requires actual controlled barrier fixture");
  process.kill(f.pid, 0);
  return f;
}
const unpack = (r: any) => (r?.content ? JSON.parse(r.content[0].text) : r);
function latest(id: string) {
  return [...(captured?.records ?? [])]
    .reverse()
    .map((r) => readUpstreamToolResultFromRequest(r.requestJson, id))
    .find(Boolean);
}
async function permissions(f: any, stopAtControl = false) {
  for (const card of await readR2PermissionCards()) {
    if (card.kind !== "read" && card.kind !== "control") continue;
    expect(card.identity).toEqual({ pid: f.pid, windowId: f.targetWindow });
    expect(card.forbidden).toBe(false);
    expect(card.defaultReject).toBe(true);
    if (card.kind === "control" && stopAtControl) return card;
    await answerR2Permission(card.kind, true, card.requestId!);
  }
  await allowR2NodePermission();
  return null;
}
async function submit(kind: "ui" | "recover" | "sdk", fresh: boolean) {
  const f = await snapshot();
  await writeFile(resolveE2ERuntimePath("cua-r2", "manifest.json"), JSON.stringify(f));
  if (fresh) {
    await startNewV4Draft();
    await selectRegistryProviderModelById(CUA_R1_MODEL, {
      providerId: CUA_R1_PROVIDER,
      providerName: "CUA R1 fixture",
      includePlainModelFallback: false,
    });
  }
  await sendV4PromptAndWaitAccepted(
    `E2E_CUA_R2_STOP_${kind.toUpperCase()}: run controlled Stop acceptance.`,
    `E2E_CUA_R2_STOP_${kind.toUpperCase()}`,
    "R2 Stop prompt missing",
  );
  return f;
}
describe("CUA-AX-R2 controlled UI and SDK Stop ordering", () => {
  before(async function () {
    this.timeout(120_000);
    fixturePath = process.env.ZODY_CUA_R2_FIXTURE_MANIFEST ?? "";
    evidence = process.env.ZODY_CUA_R2_EVIDENCE_DIR ?? "";
    if (
      process.platform !== "darwin" ||
      ![fixturePath, evidence, process.env.ZODY_E2E_PACKAGED_APP_PATH ?? ""].every(isAbsolute)
    )
      throw Error("R2 Stop requires isolated signed candidate and explicit fixture");
    await snapshot();
    await mkdir(evidence, { recursive: true });
    await mkdir(resolveE2ERuntimePath("cua-r2"), { recursive: true });
    await writeFile(
      resolveE2ERuntimePath("cua-r2", "fault-config.json"),
      JSON.stringify({ fixtureDirectory: dirname(fixturePath) }),
    );
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "replay.json"),
      artifactWriter: async (_p, a) => {
        captured = a as E2ENetworkCaptureArtifact;
      },
      fixtureVariables: createE2EReplayFixtureVariables(),
      fixturePaths: [
        resolve(process.cwd(), "test/e2e/fixtures/upstream/common.json"),
        resolve(process.cwd(), `test/e2e/fixtures/upstream/conversation-session/${NAME}.json`),
      ],
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: () => seedCuaR1Provider(server!.baseUrl),
    });
    await prepareV4ConversationE2E({ skipProvider: true });
  });
  after(async () => {
    await server?.stop();
    if (evidence)
      await writeFile(
        resolve(evidence, "r2-stop-receipts.json"),
        JSON.stringify(
          { records, physicalInputAcceptance: false, humanReviewComplete: false },
          null,
          2,
        ),
      );
    await clearAppData();
  });
  it("UI Stop before control decision sends zero; a new turn independently recovers", async function () {
    this.timeout(180_000);
    const before = await submit("ui", true);
    const prior = new Set((await controlAudits()).map((r) => JSON.stringify(r)));
    const priorEvents = new Set((await readCEvents()).map((r) => r.sequence));
    let pending: any;
    await waitFacts(
      async () => {
        pending = await permissions(before, true);
        return !!pending;
      },
      { timeout: 60_000, interval: 50 },
    );
    const sessionId = (await getV4PaneSnapshot()).sessionId!;
    const stop = await browser.$(
      '[data-testid="v4-session-pane-workspace-main"] [data-testid="v4-stop"]',
    );
    expect(await stop.isDisplayed()).toBe(true);
    expect(await stop.isClickable()).toBe(true);
    await stop.click();
    await waitFacts(
      async () => {
        const block = (await listToolCallBlocks()).find((b) => b.toolCallId === "toolu_r2_stop_ui");
        return block?.status === "stopped" && (await readR2PermissionCards()).length === 0;
      },
      { timeout: 60_000 },
    );
    await waitForV4Pane((p) => !p.canStop, "R2 UI Stop did not end turn");
    await waitFacts(
      async () => (await readCuaV4SessionPhase(sessionId)) === "completedInterrupted",
      { timeout: 30_000 },
    );
    const invalidated = (await readCEvents()).filter(
      (e) =>
        !priorEvents.has(e.sequence) &&
        e.event === "invalidated" &&
        (e as { reason?: string }).reason === "owner-revoked",
    );
    expect(invalidated.length).toBeGreaterThan(0);
    const after = await snapshot();
    expect(after).toEqual(before);
    const audit = (await controlAudits()).filter((r) => !prior.has(JSON.stringify(r)));
    expect(audit.some((r) => r.event === "admitted")).toBe(false);
    await browser.pause(400);
    expect(
      captured?.records.some(
        (r) => !!readUpstreamToolResultFromRequest(r.requestJson, "toolu_r2_stop_ui"),
      ),
    ).toBe(false);
    const ui = {
      kind: "ui-before-control",
      before,
      after,
      pending,
      invalidated,
      audit,
      toolStopped: true,
      noProviderContinuation: true,
      passed: true,
    };
    records.push(ui);
    const recoverBefore = await submit("recover", false);
    let result: any;
    await waitFacts(
      async () => {
        await permissions(recoverBefore);
        const p = await readOptional(resolve(dirname(fixturePath), "write-pending.json"));
        if (
          p?.nonce === recoverBefore.barrierNonce &&
          p.sequence === recoverBefore.target.requests + 1
        )
          await writeCControl(dirname(fixturePath), "write-release.json", p);
        result = latest("toolu_r2_stop_recover");
        return !!result;
      },
      { timeout: 60_000, interval: 30 },
    );
    records.push({ kind: "recovery-actual-tool-result", result });
    const match = result.content.match(/R2_RECOVERY:(\{[^\n]*\})/);
    expect(match).not.toBeNull();
    const receipt = unpack(JSON.parse(match![1]));
    expect(receipt.action_sent).toBe(true);
    expect(receipt.dispatch_status).toBe("sent");
    await waitForV4TimelineContaining("E2E_CUA_R2_STOP_RECOVER_DONE");
    const recovered = await snapshot();
    expect(recovered.sibling).toEqual(before.sibling);
    expect(recovered.target.presses).toBe(before.target.presses + 1);
    records.push({
      kind: "new-turn-recovery",
      before: recoverBefore,
      after: recovered,
      receipt,
      passed: true,
    });
  });
  it("SDK Stop after real admission retains sent uncertainty; late effect cannot restore old control", async function () {
    this.timeout(180_000);
    const before = await submit("sdk", true);
    const prior = new Set((await controlAudits()).map((r) => JSON.stringify(r)));
    let result: any;
    await waitFacts(
      async () => {
        await permissions(before);
        result = latest("toolu_r2_stop_sdk");
        return !!result;
      },
      { timeout: 60_000, interval: 30 },
    );
    records.push({ kind: "sdk-actual-tool-result", before, result });
    const match = result.content.match(/R2_STOP_RECEIPTS:(\{[^\n]*\})/);
    expect(match).not.toBeNull();
    const receipt = JSON.parse(match![1]);
    const action = unpack(receipt.result),
      old = unpack(receipt.old);
    expect(receipt.stopped.stopped).toBe(true);
    expect(action.action_sent).toBe(true);
    expect(["sent", "possibly_sent"]).toContain(action.dispatch_status);
    expect(old.action_sent).toBe(false);
    expect(old.dispatch_status).toBe("not_sent");
    await waitForV4TimelineContaining("E2E_CUA_R2_STOP_SDK_DONE");
    let after: any;
    await waitFacts(
      async () => {
        after = await snapshot();
        return after.target.requests === before.target.requests + 1;
      },
      { timeout: 5000 },
    );
    expect(after.target.presses).toBe(before.target.presses + 1);
    expect(after.sibling).toEqual(before.sibling);
    const audit = (await controlAudits()).filter((r) => !prior.has(JSON.stringify(r)));
    expect(audit.filter((r) => r.event === "admitted")).toHaveLength(1);
    expect(audit.filter((r) => r.event === "completed")).toHaveLength(1);
    records.push({ kind: "sdk-after-admission", before, after, receipt, audit, passed: true });
  });
});
