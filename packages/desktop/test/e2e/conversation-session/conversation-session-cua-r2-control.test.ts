import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  readR2PermissionCards,
  answerR2Permission,
  allowR2NodePermission,
} from "../helpers/cua-r2-dialog.js";
import { beginWriteTrial } from "../helpers/cua-r2-write-monitor.js";
import { readOptional } from "../helpers/cua-r1-read-monitor.js";
import { clearAppData } from "../helpers/desktop-app.js";
import { readUpstreamToolResultFromRequest } from "../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../helpers/network-capture-proxy.js";
import {
  CUA_R1_MODEL,
  CUA_R1_PROVIDER,
  seedCuaR1Provider,
} from "../helpers/cua-r1-provider.js";
import {
  inspectR2Effect,
  readR2TrialReceipt,
  type R2BusinessSnapshot,
  type R2WriteReceipt,
} from "../helpers/cua-r2-receipt.js";
import { projectR1NetworkStats } from "../helpers/cua-r1-receipt.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import {
  createE2EReplayFixtureVariables,
  resolveE2ERuntimePath,
} from "../helpers/e2e-runtime-paths.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../helpers/upstream-replay-server.js";
import { selectRegistryProviderModelById } from "../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const NAME = "conversation-session-cua-r2-control";
let server: UpstreamReplayServer | undefined;
let captured: E2ENetworkCaptureArtifact | undefined;
let manifestPath = "",
  evidence = "";
const records: unknown[] = [];
let runFailed = false;
const monitor = process.env.ZODY_CUA_R2_MONITOR_RUN?.trim() ?? "";
const inspector = process.env.ZODY_CUA_R2_WINDOW_INSPECTOR?.trim() ?? "";
let monitorTrialIndex = 0,
  barrierSequence = 0;
const liveTrials: unknown[] = [];
const openMonitorTrials = new Map<string, Awaited<ReturnType<typeof beginWriteTrial>>>();

async function snapshot(): Promise<R2BusinessSnapshot> {
  const f = JSON.parse(await readFile(manifestPath, "utf8")) as R2BusinessSnapshot;
  if (
    f.fixtureKind !== "controlled-ax-write-v1" ||
    !Number.isSafeInteger(f.pid) ||
    f.pid <= 0 ||
    !Number.isSafeInteger(f.targetWindow) ||
    !Number.isSafeInteger(f.siblingWindow) ||
    f.targetWindow <= 0 ||
    f.siblingWindow <= 0 ||
    f.targetWindow === f.siblingWindow
  )
    throw new Error("R2 controlled fixture identity missing");
  process.kill(f.pid, 0);
  return f;
}

describe("CUA-AX-R2 nine writes: real input, return states and independent effects", () => {
  before(async function () {
    this.timeout(120_000);
    manifestPath = process.env.ZODY_CUA_R2_FIXTURE_MANIFEST?.trim() ?? "";
    evidence = process.env.ZODY_CUA_R2_EVIDENCE_DIR?.trim() ?? "";
    const binary = process.env.ZODY_E2E_PACKAGED_APP_PATH?.trim() ?? "";
    if (
      process.platform !== "darwin" ||
      ![manifestPath, evidence, binary].every(isAbsolute) ||
      binary.startsWith("/Applications/")
    )
      throw new Error(
        "R2 requires an explicit independent signed macOS candidate, controlled manifest and evidence directory",
      );
    if (monitor && (!isAbsolute(monitor) || !isAbsolute(inspector)))
      throw new Error("R2 live monitor requires absolute run and OS inspector");
    const fixture = await snapshot();
    if (monitor) {
      // 中文原因：两轮的屏障和监测序号均从零开始，复用旧进程/命令会令首笔失配；在提交任何 SDK 前拒绝。
      if (
        (fixture as R2BusinessSnapshot & { barrierEnabled?: boolean }).barrierEnabled !== true ||
        fixture.target.requests !== 0 ||
        fixture.sibling.requests !== 0 ||
        (await readOptional(resolve(monitor, "command.json"))) ||
        (await readOptional(resolve(monitor, "operator-ready.json")))
      )
        throw new Error("R2 manual round requires fresh barrier fixture and monitor directory");
    }
    await mkdir(evidence, { recursive: true });
    await mkdir(resolveE2ERuntimePath("cua-r2"), { recursive: true });
    await writeFile(resolveE2ERuntimePath("cua-r2", "manifest.json"), JSON.stringify(fixture), {
      mode: 0o600,
    });
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "replay.json"),
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
      afterElectronProcessExit: () => seedCuaR1Provider(server!.baseUrl),
    });
    await prepareV4ConversationE2E({ skipProvider: true });
  });
  beforeEach(function () {
    if (runFailed) this.skip();
  });
  afterEach(async function () {
    if (this.currentTest?.state === "failed") runFailed = true;
    if (runFailed)
      for (const [id, active] of openMonitorTrials) {
        const incomplete = await active
          .finish(undefined, true)
          .catch((error) => ({ trialId: id, captureError: String(error), liveAcceptance: false }));
        liveTrials.push(incomplete);
        await writeFile(
          resolve(evidence, `incomplete-${id}.json`),
          JSON.stringify(incomplete, null, 2),
        );
        openMonitorTrials.delete(id);
      }
    if (monitor)
      await writeFile(
        resolve(evidence, "r2-write-trials.json"),
        JSON.stringify(liveTrials, null, 2),
      );
  });
  after(async () => {
    await server?.stop();
    if (evidence)
      await writeFile(
        resolve(evidence, "r2-functional-receipts.json"),
        JSON.stringify(
          {
            records,
            network: projectR1NetworkStats(captured, CUA_R1_MODEL),
            matchedFixtures: captured?.records.map((record) => ({
              fixtureId: record.replay?.fixtureId ?? null,
              status: record.status,
              statusCode: record.statusCode ?? null,
            })),
            noninterferenceAcceptance:
              Boolean(monitor) &&
              liveTrials.length === 9 &&
              liveTrials.every((record: any) => record.score?.status === "successful"),
            humanReviewComplete: false,
            limits:
              "R2 nine paths per platform; human review pending. No R3 repetition or fault matrix.",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    await clearAppData();
  });

  for (const kind of ["left_click", "perform_action", "set_value"] as const) {
    it(`CUA-AX-R2 ${kind}: independent business effects`, async function () {
      this.timeout(monitor ? 1_200_000 : 180_000);
      const before = await snapshot();
      await startNewV4Draft();
      await selectRegistryProviderModelById(CUA_R1_MODEL, {
        providerId: CUA_R1_PROVIDER,
        providerName: "CUA R1 fixture",
        includePlainModelFallback: false,
      });
      if (monitor && kind === "left_click") {
        await writeFile(
          resolve(evidence, "operator-request.json"),
          JSON.stringify({ readyForHuman: true, SDKStarted: false, monitor }),
        );
        // 人工就绪只在提交 SDK 调用之前等待，不占用工具 cell 或 AX 调用。
        await browser.waitUntil(
          async () => {
            const r = await readOptional(resolve(monitor, "operator-ready.json"));
            return r?.ready === true;
          },
          {
            timeout: 900_000,
            interval: 250,
            timeoutMsg: "R2 explicit human input readiness missing",
          },
        );
        const prior = (await readOptional(resolve(monitor, "last-key.json")))?.key?.sequence ?? 0;
        await browser.waitUntil(
          async () => {
            const k = await readOptional(resolve(monitor, "last-key.json"));
            return k?.key?.sequence > prior && k.key.sourcePID === 0;
          },
          {
            timeout: 60_000,
            interval: 50,
            timeoutMsg: "R2 requires new real hardware typing before SDK starts",
          },
        );
      }
      const activeTrials = new Map<number, Awaited<ReturnType<typeof beginWriteTrial>>>();
      const marker = `E2E_CUA_R2_${kind.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${marker}: run the controlled R2 fixture.`,
        marker,
        "R2 submission missing",
      );
      const answered = new Set<string>();
      const count = 3;
      const received = new Map<number, R2WriteReceipt>();
      const caseRecord = {
        kind,
        before,
        receipts: [] as R2WriteReceipt[],
        status: "running",
        error: "",
        decisions: [] as {
          kind: string;
          requestId: string;
          allow: boolean;
          identity: { pid: number; windowId: number };
        }[],
        after: null as R2BusinessSnapshot | null,
        failedToolResult: null as { content: string; isError: boolean } | null,
      };
      records.push(caseRecord);
      let failure: unknown;
      await browser.waitUntil(
        async () => {
          try {
            for (let trial = 0; trial < count; trial++) {
              if (received.has(trial)) continue;
              const result = [...(captured?.records ?? [])]
                .reverse()
                .map((record) =>
                  readUpstreamToolResultFromRequest(
                    record.requestJson,
                    `toolu_cua_r2_${kind}_${trial}`,
                  ),
                )
                .find(Boolean);
              if (!result) continue;
              // 受控夹具失败时保留真实工具错误，区分验证器失败与产品失败。
              try {
                const receipt = readR2TrialReceipt(result, kind, trial);
                const mode = ["none", "compact", "full"][trial];
                expect(receipt.state_sync_status).toBe(
                  mode === "none" ? "not_requested" : "synced",
                );
                const payload = JSON.parse(result.content.match(/R2_RECEIPTS:(\{[^\n]*\})/)![1]!);
                expect(payload.return_state).toBe(mode);
                received.set(trial, receipt);
              } catch (error) {
                caseRecord.failedToolResult = { content: result.content, isError: result.isError };
                throw error;
              }
              if (monitor) {
                const active = activeTrials.get(trial);
                if (!active) throw new Error("R2 control decision/monitor trial was not observed");
                const record = await active.finish(received.get(trial), result.isError);
                liveTrials.push(record);
                openMonitorTrials.delete(active.trialId);
                await writeFile(
                  resolve(evidence, `${record.trialId}.json`),
                  JSON.stringify(record, null, 2),
                );
                await writeFile(
                  resolve(evidence, "r2-write-trials.json"),
                  JSON.stringify(liveTrials, null, 2),
                );
                expect(record.score.status).toBe("successful");
                barrierSequence++;
              }
              caseRecord.receipts = [...received.entries()]
                .sort((a, b) => a[0] - b[0])
                .map((entry) => entry[1]);
              await writeFile(
                resolve(evidence, "r2-live-trials.json"),
                JSON.stringify(records, null, 2),
                { mode: 0o600 },
              );
            }
            if (received.size === count) return true;
            for (const card of await readR2PermissionCards()) {
              const { kind: cardKind, requestId: id } = card;
              if ((cardKind !== "read" && cardKind !== "control") || !id || answered.has(id))
                continue;
              expect(card.identity).toEqual({ pid: before.pid, windowId: before.targetWindow });
              expect(card.forbidden).toBe(false);
              expect(card.defaultReject).toBe(true);
              answered.add(id);
              const allow = true;
              if (monitor && cardKind === "control") {
                const trial = received.size;
                if (activeTrials.has(trial))
                  throw new Error("R2 duplicate control request for one action");
                const active = await beginWriteTrial({
                  fixturePath: manifestPath,
                  monitor,
                  inspector,
                  method: kind,
                  index: monitorTrialIndex++,
                  trial,
                  previousSequence: barrierSequence,
                });
                activeTrials.set(trial, active);
                openMonitorTrials.set(active.trialId, active);
              }
              await answerR2Permission(cardKind, allow, id);
              caseRecord.decisions.push({
                kind: cardKind,
                requestId: id,
                allow,
                identity: card.identity!,
              });
            }
            await allowR2NodePermission();

            return false;
          } catch (error) {
            failure = error;
            runFailed = true;
            caseRecord.status = "failed";
            caseRecord.error = error instanceof Error ? error.message : String(error);
            return true;
          }
        },
        { timeout: 120_000, timeoutMsg: "R2 actual receipts missing" },
      );
      if (failure) throw failure;
      await waitForV4TimelineContaining(`${marker}_DONE`);
      let after = await snapshot();
      await browser.waitUntil(
        async () => {
          after = await snapshot();
          return after.target.requests - before.target.requests >= count;
        },
        { timeout: 10_000 },
      );
      caseRecord.after = after;
      const parsed = { receipts: caseRecord.receipts };
      caseRecord.status = "receipts-complete";
      const result = inspectR2Effect({
        before,
        after,
        method: kind,
        receipts: parsed.receipts,
        count,
        ...(kind === "set_value" ? { value: "E2E_R2_VALUE_2" } : {}),
      });
      records.push({ kind, before, after, result, receipts: parsed.receipts });
      expect(result.ok).toBe(true);
    });
  }
});
