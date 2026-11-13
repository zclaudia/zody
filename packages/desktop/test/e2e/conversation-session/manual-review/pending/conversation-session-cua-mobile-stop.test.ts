import { getV4PaneSnapshot, waitForV4Pane } from "../../../helpers/v4-conversation.js";
import { waitCall, waitRead, result, assertFull } from "../../../helpers/cua-r1-lifecycle.js";
import { resolveGatewayE2EConfig } from "../../../helpers/mobile-remote-gateway.js";
import { openMobileCuaPage, tapMobileCuaStop } from "../../../helpers/mobile-cua-stop.js";
import { configureMobileGateway } from "../../../helpers/mobile-cua-gateway.js";
import { readCuaV4SessionPhase } from "../../../helpers/cua-v4-session-phase.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  readUpstreamToolResultFromRequest,
  type UpstreamToolResultSnapshot,
} from "../../../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../../../helpers/network-capture-proxy.js";
import { listToolCallBlocks } from "../../../helpers/conversation-session-tool.js";
import {
  CUA_R1_MODEL,
  CUA_R1_PROVIDER,
  seedCuaR1Provider,
} from "../../../helpers/cua-r1-provider.js";
import {
  projectR1NetworkStats,
  identifyR1FixtureProfile,
  r1NoStoppedContinuation,
  r1LifecycleOrder,
  type R1Fixture,
} from "../../../helpers/cua-r1-receipt.js";
import { readR1PermissionDialog, clickR1AllowOnce } from "../../../helpers/cua-r1-dialog.js";
import { inspectR1FixtureLaunch, refreshR1Fixture } from "../../../helpers/cua-r1-lifecycle.js";
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

const NAME = "conversation-session-cua-mobile-stop";
const FIXTURES = resolve(process.cwd(), "test/e2e/fixtures/upstream");
const RUNTIME = resolveE2ERuntimePath("cua-r1");

let server: UpstreamReplayServer;
let fixture: R1Fixture;
let fixtureLaunch: number | undefined;
let fixtureProfile: ReturnType<typeof identifyR1FixtureProfile>;
let captured: E2ENetworkCaptureArtifact | undefined;
let evidenceDir = "";
const lifecycleReceipts: Record<string, Record<string, unknown>> = {
  stop: { caseId: "CUA-AX-R1-03d", executed: false, passed: false },
};

function latestResult(id: string): UpstreamToolResultSnapshot | null {
  for (const record of [...(captured?.records ?? [])].reverse()) {
    const result = readUpstreamToolResultFromRequest(record.requestJson, id);
    if (result) return result;
  }
  return null;
}

describe("CUA AX R1 signed candidate observation", () => {
  before(async function () {
    this.timeout(120_000);
    const binary = process.env.ZODY_E2E_PACKAGED_APP_PATH?.trim();
    const fixturePath = process.env.ZODY_CUA_R1_FIXTURE_MANIFEST?.trim();
    evidenceDir = process.env.ZODY_CUA_R1_EVIDENCE_DIR?.trim() ?? "";
    if (
      process.platform !== "darwin" ||
      !binary ||
      !isAbsolute(binary) ||
      !fixturePath ||
      !isAbsolute(fixturePath) ||
      !evidenceDir ||
      !isAbsolute(evidenceDir)
    ) {
      throw new Error(
        "R1 requires Darwin, an independent packaged candidate executable, an absolute ZODY_CUA_R1_FIXTURE_MANIFEST and ZODY_CUA_R1_EVIDENCE_DIR; no acceptance was run",
      );
    }
    if (binary.startsWith("/Applications/"))
      throw new Error("R1 must use an independent candidate, not an installed app");
    const f = JSON.parse(await readFile(fixturePath, "utf8")) as R1Fixture;
    if (
      !Number.isSafeInteger(f.pid) ||
      f.pid <= 0 ||
      !Number.isSafeInteger(f.targetWindow) ||
      f.targetWindow <= 0 ||
      !Number.isSafeInteger(f.siblingWindow) ||
      f.siblingWindow <= 0 ||
      f.targetWindow === f.siblingWindow ||
      f.targetMarker !== "E2E_R1_TARGET_BODY" ||
      f.siblingMarker !== "E2E_R1_SIBLING_BODY"
    )
      throw new Error("Invalid R1 fixture manifest");
    fixtureProfile = identifyR1FixtureProfile(f.fixtureKind);
    process.kill(f.pid, 0);
    fixture = f;
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(resolve(RUNTIME, "manifest.json"), JSON.stringify(f), {
      mode: 0o600,
    });
    await mkdir(evidenceDir, { recursive: true });
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidenceDir, "replay.json"),
      // 仅保留内存快照；原始 provider 请求可能包含无关 app 或正文，绝不落盘。
      artifactWriter: async (_path, artifact) => {
        captured = artifact as E2ENetworkCaptureArtifact;
      },
      fixtureVariables: createE2EReplayFixtureVariables(),
      fixturePaths: [
        resolve(FIXTURES, "common.json"),
        resolve(FIXTURES, "conversation-session", `${NAME}.json`),
      ],
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: () => seedCuaR1Provider(server.baseUrl),
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectR1Model();
  });
  after(async () => {
    await server?.stop();
    if (evidenceDir && fixture) {
      await writeFile(
        resolve(evidenceDir, "r1-receipts.json"),
        JSON.stringify(
          {
            fixtureProfile,
            lifecycleReceipts,
            network: projectR1NetworkStats(captured, CUA_R1_MODEL),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
    await clearAppData();
  });

  it("CUA-AX-R1-03d mobile: touch Stop and fresh turn", async function () {
    this.timeout(300_000);
    if (fixtureProfile.kind !== "explicit-ax-content-v1")
      throw new Error("explicit fixture required");
    const config = await resolveGatewayE2EConfig();
    if (!config) throw new Error("Gateway configuration required for mobile 03d");
    const receipt = lifecycleReceipts.stop!;
    receipt.executed = true;
    const stage = (value: string) => {
      receipt.stage = value;
      process.stdout.write(`[mobile-cua-stage] ${value}\n`);
    };
    stage("gateway-configuration");
    const backendId = await configureMobileGateway(config);
    stage("gateway-online");
    const candidateRelease = JSON.parse(
      await readFile(
        resolve(
          dirname(process.env.ZODY_E2E_PACKAGED_APP_PATH!),
          "../Resources/mobile-web/release.json",
        ),
        "utf8",
      ),
    ) as { releaseId?: string };
    const gatewayUrl = new URL(config.gatewayUrl);
    gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : gatewayUrl.protocol;
    const releaseResponse = await fetch(
      new URL(`/api/proxy/${encodeURIComponent(backendId)}/mobile-ui/release`, gatewayUrl),
      { headers: { authorization: `Bearer ${config.deviceCredential}` } },
    );
    if (!releaseResponse.ok)
      throw new Error("Candidate mobile release unavailable through gateway");
    const remoteRelease = (await releaseResponse.json()) as {
      releaseId?: string;
    };
    if (!candidateRelease.releaseId || candidateRelease.releaseId !== remoteRelease.releaseId)
      throw new Error("Candidate mobile release ID mismatch");
    stage("candidate-release-matched");
    const mobile = await openMobileCuaPage({
      backendId,
      config,
      onStage: stage,
    });
    Object.assign(receipt, {
      backendMatched: true,
      releaseIdMatched: true,
      bridgePresent: true,
      testPageProxy: "loopback-http-to-gateway",
      realGatewayAssets: true,
      pageOriginClass: "localhost-secure-context",
      proxyStats: mobile.proxyStats,
    });
    try {
      fixtureLaunch = await inspectR1FixtureLaunch(fixture);
      fixture = await refreshR1Fixture(
        fixture,
        process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!,
        resolve(RUNTIME, "manifest.json"),
        fixtureLaunch,
      );
      await startNewV4Draft();
      await selectR1Model();
      await sendV4PromptAndWaitAccepted(
        "E2E_CUA_R1_STOP: run the controlled observation fixture.",
        "E2E_CUA_R1_STOP",
        "R1 mobile submission not accepted",
      );
      const session = (await getV4PaneSnapshot()).sessionId;
      if (!session || session === "draft") throw new Error("R1 session unavailable");
      const calls = new Set<string>();
      const reads = new Set<string>();
      const first = await waitCall(calls);
      const request = await waitRead(fixture, reads);
      receipt.pendingAt = performance.now();
      const task = mobile.page.getByTestId(`task-item-${session}`);
      await task.waitFor({ state: "visible" });
      await task.tap();
      const mobilePane = mobile.page.locator(
        '[data-mobile-page="chat"] [data-testid^="v4-session-pane-"]',
      );
      await mobilePane.waitFor({ state: "visible" });
      if ((await mobilePane.getAttribute("data-session-id")) !== session)
        throw new Error("Mobile opened a different session");
      receipt.currentSessionMatched = true;
      Object.assign(receipt, await tapMobileCuaStop(mobile.page, request));
      receipt.tapAt = performance.now();
      await mobile.page.waitForFunction(
        (id) =>
          !Array.from(document.querySelectorAll('[data-cua-confirm-kind="read"]')).some(
            (card) => card.getAttribute("data-permission-request-id") === id,
          ),
        request,
        { timeout: 60_000 },
      );
      receipt.cardClearedAt = performance.now();
      let terminal = "";
      let clean = false;
      await browser.waitUntil(
        async () => {
          const card = await readR1PermissionDialog();
          const block = (await listToolCallBlocks()).find((x) => x.toolCallId === first);
          terminal = block?.status ?? "";
          clean = ![
            fixture.targetMarker,
            fixture.siblingMarker,
            "AX window state",
            "AX window diff",
          ].some((x) => (block?.text ?? "").includes(x));
          return (card.kind !== "read" || card.requestId !== request) && terminal === "stopped";
        },
        {
          timeout: 60_000,
          timeoutMsg: "Mobile Stop did not clear card and stop exact call",
        },
      );
      await waitForV4Pane((s) => !s.canStop, "Mobile Stop remained running", 60_000);
      let sessionPhase: string | null = null;
      await browser.waitUntil(
        async () => {
          sessionPhase = await readCuaV4SessionPhase(session);
          return sessionPhase === "completedInterrupted";
        },
        {
          timeout: 60_000,
          timeoutMsg: "Mobile Stop runtime did not leave running",
        },
      );
      receipt.sessionPhase = sessionPhase;
      receipt.terminationObservedAt = performance.now();
      const old = latestResult(first)?.content ?? "";
      clean &&= ![
        fixture.targetMarker,
        fixture.siblingMarker,
        "AX window state",
        "AX window diff",
      ].some((x) => old.includes(x));
      if (!clean || !r1NoStoppedContinuation(captured, first))
        throw new Error("Stopped call leaked or continued");
      Object.assign(receipt, {
        cardCleared: true,
        terminal,
        oldOutputClean: clean,
        noContinuation: true,
      });
      await sendV4PromptAndWaitAccepted(
        "E2E_CUA_R1_RESUME: run the controlled observation fixture.",
        "E2E_CUA_R1_RESUME",
        "R1 resume not accepted",
      );
      if ((await getV4PaneSnapshot()).sessionId !== session)
        throw new Error("Resume changed session");
      const next = await waitCall(calls);
      const nextRequest = await waitRead(fixture, reads);
      await mobile.page.waitForFunction(
        (id) =>
          Array.from(document.querySelectorAll('[data-cua-confirm-kind="read"]')).some(
            (card) =>
              card.getAttribute("data-permission-request-id") === id &&
              Boolean(
                card.querySelector(
                  '[data-permission-option-kind="rejectOnce"][aria-selected="true"]',
                ),
              ),
          ),
        nextRequest,
        { timeout: 60_000 },
      );
      receipt.mobileNewReadDefaultDeny = true;
      await clickR1AllowOnce("read", nextRequest);
      assertFull(
        await result(
          {
            fixture,
            manifestPath: process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!,
            runtimeManifest: resolve(RUNTIME, "manifest.json"),
            latestResult,
            receipt,
          },
          next,
        ),
        fixture,
      );
      receipt.newFullAt = performance.now();
      if (
        !r1LifecycleOrder([
          receipt.pendingAt,
          receipt.tapAt,
          receipt.cardClearedAt,
          receipt.terminationObservedAt,
          receipt.newFullAt,
        ] as number[])
      )
        throw new Error("Mobile Stop observation ordering invalid");
      await waitForV4TimelineContaining("E2E_CUA_R1_RESUME_DONE", 60_000);
      const oldBlock = (await listToolCallBlocks()).find((x) => x.toolCallId === first);
      const finalOldOutput = `${oldBlock?.text ?? ""}\n${latestResult(first)?.content ?? ""}`;
      const finalOldClean = ![
        fixture.targetMarker,
        fixture.siblingMarker,
        "AX window state",
        "AX window diff",
      ].some((x) => finalOldOutput.includes(x));
      if (oldBlock?.status !== "stopped" || !finalOldClean)
        throw new Error("Stopped call changed or leaked after resume");
      Object.assign(receipt, {
        distinctReadRequests: reads.size === 2,
        sameSession: true,
        newFull: true,
        finalObserved: true,
        finalOldClean: true,
        passed: true,
      });
    } finally {
      await mobile.close();
    }
  });
});

async function selectR1Model() {
  await selectRegistryProviderModelById(CUA_R1_MODEL, {
    providerId: CUA_R1_PROVIDER,
    providerName: "CUA R1 fixture",
    includePlainModelFallback: false,
  });
}
