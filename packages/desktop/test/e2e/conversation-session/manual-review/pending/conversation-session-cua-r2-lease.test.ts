import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
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
} from "../../../helpers/v4-conversation.js";
import {
  readR2PermissionCards,
  answerR2Permission,
  allowR2NodePermission,
} from "../../../helpers/cua-r2-dialog.js";
import { readOptional } from "../../../helpers/cua-r1-read-monitor.js";
import { controlAudits } from "../../../helpers/cua-r2-write-monitor.js";
import { inspectR2Effect } from "../../../helpers/cua-r2-receipt.js";

const NAME = "conversation-session-cua-r2-lease";
const exec = promisify(execFile);
let server: UpstreamReplayServer | undefined;
let captured: E2ENetworkCaptureArtifact | undefined;
let fixturePath = "",
  evidence = "",
  probePath = "",
  runDir = "";
const records: unknown[] = [];
async function snapshot() {
  const f = JSON.parse(await readFile(fixturePath, "utf8"));
  if (
    f.fixtureKind !== "controlled-ax-write-v1" ||
    f.barrierEnabled !== false ||
    !Number.isSafeInteger(f.pid) ||
    f.pid <= 0 ||
    !Number.isSafeInteger(f.targetWindow) ||
    !Number.isSafeInteger(f.siblingWindow) ||
    f.targetWindow <= 0 ||
    f.siblingWindow <= 0 ||
    f.targetWindow === f.siblingWindow
  )
    throw Error("R2 lease requires an independent unblocked fixture");
  process.kill(f.pid, 0);
  return f;
}
function latest(id: string) {
  return [...(captured?.records ?? [])]
    .reverse()
    .map((r) => readUpstreamToolResultFromRequest(r.requestJson, id))
    .find(Boolean);
}
function actualReceipt(result: { content: string } | null | undefined, marker: string) {
  const match = result?.content.match(new RegExp(`${marker}:(\\{[^\\n]*\\})`));
  if (!match) throw Error(`R2 lease missing ${marker} actual provider result`);
  return JSON.parse(match[1]!);
}
async function probe(expected: "busy" | "acquired", origin: number) {
  const elapsedMs = performance.now() - origin;
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(probePath, [], { timeout: 5_000, maxBuffer: 4096 });
  } catch (error) {
    const failed = error as Error & { code?: unknown; stdout?: string; stderr?: string };
    records.push({
      stage: "probe-failed",
      expected,
      elapsedMs,
      exitCode: failed.code ?? null,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    });
    throw error;
  }
  records.push({
    stage: "probe-raw",
    expected,
    elapsedMs,
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const payload: unknown = JSON.parse(String(result.stdout));
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    (payload as { status?: unknown }).status !== expected ||
    result.stderr !== ""
  )
    throw Error(`R2 lease probe returned invalid ${expected} result`);
  return { status: expected, elapsedMs, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}
describe("CUA R2 idle lease across cells", () => {
  before(async function () {
    this.timeout(120_000);
    fixturePath = process.env.ZODY_CUA_R2_FIXTURE_MANIFEST?.trim() ?? "";
    evidence = process.env.ZODY_CUA_R2_EVIDENCE_DIR?.trim() ?? "";
    probePath = process.env.ZODY_CUA_R2_LEASE_PROBE?.trim() ?? "";
    const binary = process.env.ZODY_E2E_PACKAGED_APP_PATH?.trim() ?? "";
    if (
      process.platform !== "darwin" ||
      ![fixturePath, evidence, probePath, binary].every(isAbsolute) ||
      binary.startsWith("/Applications/")
    )
      throw Error(
        "R2 lease requires isolated candidate, fixture, evidence and production lease probe",
      );
    const before = await snapshot();
    await mkdir(evidence, { recursive: true });
    const base = resolveE2ERuntimePath("cua-r2-lease");
    const runId = randomUUID();
    runDir = resolve(base, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(resolve(runDir, "manifest.json"), JSON.stringify(before), { mode: 0o600 });
    await writeFile(resolve(base, "config.json"), JSON.stringify({ runId }), { mode: 0o600 });
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
        resolve(evidence, "r2-lease-receipts.json"),
        JSON.stringify(
          {
            records,
            grant: runDir ? await readOptional(resolve(runDir, "grant.json")) : null,
            observation: runDir ? await readOptional(resolve(runDir, "observation.json")) : null,
            firstToolResult: latest("toolu_r2_lease_first"),
            secondToolResult: latest("toolu_r2_lease_second"),
            humanReviewComplete: false,
            physicalInputAcceptance: false,
          },
          null,
          2,
        ),
      );
    await clearAppData();
  });
  it("proves active contention and expiry without extending the idle lease", async function () {
    this.timeout(240_000);
    const before = await snapshot();
    records.push({ stage: "baseline", before });
    const auditStart = (await controlAudits()).length;
    await startNewV4Draft();
    await selectRegistryProviderModelById(CUA_R1_MODEL, {
      providerId: CUA_R1_PROVIDER,
      providerName: "CUA R1 fixture",
      includePlainModelFallback: false,
    });
    await sendV4PromptAndWaitAccepted(
      "E2E_CUA_R2_LEASE: run the controlled lease trial.",
      "E2E_CUA_R2_LEASE",
      "R2 lease prompt missing",
    );
    let origin: number | undefined,
      busy: Awaited<ReturnType<typeof probe>> | undefined,
      acquired: Awaited<ReturnType<typeof probe>> | undefined;
    let grant: any, observed: any, secondControl: string | undefined;
    let observationElapsed: number | undefined;
    let busyAttempted = false,
      acquiredAttempted = false;
    let failure: Error | undefined;
    const cards: Array<{ kind: string; requestId: string }> = [];
    await browser.waitUntil(
      async () => {
        try {
          // 首次写可能已经落地；真实工具失败或缺标记时立即停止，不得继续或重放。
          const firstResult = latest("toolu_r2_lease_first");
          if (
            firstResult &&
            (firstResult.isError || !firstResult.content.includes("R2_LEASE_FIRST:"))
          ) {
            records.push({ stage: "first-tool-failed", result: firstResult });
            throw Error("R2 lease first actual tool failed or receipt missing");
          }
          for (const card of await readR2PermissionCards()) {
            if (card.kind !== "read" && card.kind !== "control") continue;
            if (card.requestId && cards.some((c) => c.requestId === card.requestId)) continue;
            if (
              !card.requestId ||
              card.forbidden ||
              !card.defaultReject ||
              card.identity?.pid !== before.pid ||
              card.identity?.windowId !== before.targetWindow
            )
              throw Error("R2 lease unexpected permission card");
            if (card.kind === "control" && cards.some((c) => c.kind === "control")) {
              secondControl = card.requestId;
              if (!acquired)
                throw Error("R2 lease second control appeared before successful after-probe");
            }
            cards.push({ kind: card.kind, requestId: card.requestId });
            await answerR2Permission(card.kind, true, card.requestId);
          }
          await allowR2NodePermission();
          if (!grant) {
            grant = await readOptional(resolve(runDir, "grant.json"));
            if (grant) {
              origin = performance.now();
              if (grant.receipt?.action_sent !== true || grant.receipt?.dispatch_status !== "sent")
                throw Error("R2 lease invalid actual grant receipt");
            }
          }
          if (!observed) {
            observed = await readOptional(resolve(runDir, "observation.json"));
            if (observed && origin !== undefined) {
              observationElapsed = performance.now() - origin;
              records.push({
                stage: "observation",
                elapsedMs: observationElapsed,
                facts: observed,
              });
            }
          }
          // 中间读取/拒绝均完成后才探测 busy，证明它们发生在实际租约仍被占用的区间。
          if (
            origin !== undefined &&
            observed &&
            !busyAttempted &&
            performance.now() - origin >= 60_000
          ) {
            busyAttempted = true;
            busy = await probe("busy", origin);
            records.push({ stage: "busy-probe", ...busy });
          }
          if (origin !== undefined && !acquiredAttempted && performance.now() - origin >= 130_000) {
            acquiredAttempted = true;
            if (!busy || !observed)
              throw Error("R2 lease missing mid-trial observation or busy probe");
            acquired = await probe("acquired", origin);
            records.push({ stage: "after-probe", ...acquired });
            await writeFile(resolve(runDir, "probe-acquired.tmp"), JSON.stringify(acquired), {
              flag: "wx",
              mode: 0o600,
            });
            await rename(
              resolve(runDir, "probe-acquired.tmp"),
              resolve(runDir, "probe-acquired.json"),
            );
          }
          return !!latest("toolu_r2_lease_second");
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          records.push({
            stage: "wait-failure",
            message: failure.message,
            busyAttempted,
            acquiredAttempted,
          });
          return true;
        }
      },
      {
        timeout: 220_000,
        interval: 100,
        timeoutMsg: "R2 lease trial did not produce the second actual SDK result",
      },
    );
    if (failure) throw failure;
    expect(latest("toolu_r2_lease_first")?.isError).toBe(false);
    const first = actualReceipt(latest("toolu_r2_lease_first"), "R2_LEASE_FIRST");
    const second = actualReceipt(latest("toolu_r2_lease_second"), "R2_LEASE_SECOND");
    expect(first).toEqual(grant.receipt);
    expect(
      [first, second].every(
        (r) => r.action_sent === true && r.dispatch_status === "sent" && !r.code,
      ),
    ).toBe(true);
    expect(observed?.unsupported?.action_sent).toBe(false);
    expect(observed?.unsupported?.dispatch_status).toBe("not_sent");
    expect(observationElapsed).toBeGreaterThanOrEqual(60_000);
    expect(observationElapsed).toBeLessThan(75_000);
    expect(busy?.elapsedMs).toBeGreaterThanOrEqual(60_000);
    expect(busy?.elapsedMs).toBeLessThan(75_000);
    expect(acquired?.elapsedMs).toBeGreaterThanOrEqual(130_000);
    expect(cards.filter((c) => c.kind === "read")).toHaveLength(2);
    expect(cards.filter((c) => c.kind === "control")).toHaveLength(2);
    expect(secondControl).toBeTruthy();
    await waitForV4TimelineContaining("E2E_CUA_R2_LEASE_DONE");
    let after: Awaited<ReturnType<typeof snapshot>>;
    await browser.waitUntil(
      async () => {
        after = await snapshot();
        return after.target.requests === before.target.requests + 2;
      },
      { timeout: 10_000 },
    );
    const effects = inspectR2Effect({
      before,
      after: after!,
      method: "left_click",
      receipts: [first, second],
      count: 2,
    });
    expect(effects.ok).toBe(true);
    let audit: Awaited<ReturnType<typeof controlAudits>> = [];
    await browser.waitUntil(
      async () => {
        audit = (await controlAudits()).slice(auditStart);
        return audit.filter((r) => r.event === "completed").length >= 2;
      },
      { timeout: 10_000, timeoutMsg: "R2 lease native receipts missing" },
    );
    expect(audit.filter((r) => r.event === "admitted")).toHaveLength(2);
    const completed = audit.filter((r) => r.event === "completed" && r.dispatch_status === "sent");
    expect(completed).toHaveLength(2);
    expect(completed[0].scope).toBe(completed[1].scope);
    expect(completed[0].attempt).not.toBe(completed[1].attempt);
    records.push({
      before,
      after: after!,
      grant,
      observed,
      busy,
      acquired,
      cards,
      first,
      second,
      effects,
      audit,
      passed: true,
    });
  });
});
