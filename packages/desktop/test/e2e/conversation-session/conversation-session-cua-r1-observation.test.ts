import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  readUpstreamToolResultFromRequest,
  type UpstreamToolResultSnapshot,
} from "../helpers/conversation-session-network.js";
import type { E2ENetworkCaptureArtifact } from "../helpers/network-capture-proxy.js";
import {
  listToolCallBlocks,
  waitForToolCallBlockByToolName,
} from "../helpers/conversation-session-tool.js";
import { CUA_R1_MODEL, CUA_R1_PROVIDER, seedCuaR1Provider } from "../helpers/cua-r1-provider.js";
import {
  safeReceipt,
  projectR1NetworkStats,
  identifyR1FixtureProfile,
  r1NoStoppedContinuation,
  snapshotR1Fixture,
  type R1Fixture,
} from "../helpers/cua-r1-receipt.js";
import { readR1PermissionDialog, clickR1AllowOnce } from "../helpers/cua-r1-dialog.js";
import {
  runR1Rebuild,
  inspectR1FixtureLaunch,
  refreshR1Fixture,
} from "../helpers/cua-r1-lifecycle.js";
import { createR1DeliveryBarrier } from "../helpers/cua-r1-delivery-barrier.js";
import { runR1Stop } from "../helpers/cua-r1-stop.js";
import { runR1StateCells } from "../helpers/cua-r1-state-case.js";
import { inspectStateToolResult } from "../helpers/cua-r1-receipt.js";
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
  denyV4PermissionWithFeedback,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const NAME = "conversation-session-cua-r1-observation";
const FIXTURES = resolve(process.cwd(), "test/e2e/fixtures/upstream");
const RUNTIME = resolveE2ERuntimePath("cua-r1");
const TOOL = "mcp__node_repl__js";

let server: UpstreamReplayServer;
let fixture: R1Fixture;
let fixtureLaunch: number | undefined;
const caseFixtures: Partial<Record<"metadata" | "deny" | "allow" | "state", R1Fixture>> = {};
let fixtureProfile: ReturnType<typeof identifyR1FixtureProfile>;
let captured: E2ENetworkCaptureArtifact | undefined;
let evidenceDir = "";
const lifecycleReceipts: Record<string, Record<string, unknown>> = {
  rebuild: { caseId: "CUA-AX-R1-03c", executed: false, passed: false },
  stop: { caseId: "CUA-AX-R1-03d", executed: false, passed: false },
  delivery: { caseId: "CUA-AX-R1-B", executed: false, passed: false },
};
const stateToolIds: string[] = [];
const caseToolIds: Partial<Record<"metadata" | "deny" | "allow" | "state", string>> = {};
const cases = Object.fromEntries(
  (["metadata", "deny", "allow", "state"] as const).map((kind) => [
    kind,
    {
      executed: false,
      passed: false,
      submissionAccepted: false,
      readApprovalSeen: false,
      readConfirmations: 0,
      decisionClicked: null as "allow" | "deny" | null,
    },
  ]),
) as Record<
  "metadata" | "deny" | "allow" | "state",
  {
    executed: boolean;
    passed: boolean;
    submissionAccepted: boolean;
    readApprovalSeen: boolean;
    readConfirmations: number;
    decisionClicked: "allow" | "deny" | null;
  }
>;

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
      const receipts = Object.fromEntries(
        (["metadata", "deny", "allow", "state"] as const).map((kind) => [
          kind,
          {
            ...cases[kind],
            result:
              kind === "state"
                ? stateToolIds.map((id, index) =>
                    inspectStateToolResult(latestResult(id), caseFixtures[kind]!, index + 1),
                  )
                : caseToolIds[kind]
                  ? safeReceipt(latestResult(caseToolIds[kind]!), caseFixtures[kind]!)
                  : { received: false },
          },
        ]),
      );
      await writeFile(
        resolve(evidenceDir, "r1-receipts.json"),
        JSON.stringify(
          {
            fixtureProfile,
            receipts,
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

  for (const kind of ["metadata", "deny", "allow"] as const) {
    it(`CUA-AX-R1 ${kind}: live SDK and ${kind === "metadata" ? "metadata" : "user-once read"}`, async function () {
      this.timeout(180_000);
      cases[kind].executed = true;
      caseFixtures[kind] = snapshotR1Fixture(fixture);
      if (kind !== "metadata") {
        await startNewV4Draft();
        // 中文原因：单独回放 deny/allow 时首次选择仍属旧草稿，创建新草稿后须明确选择隔离 provider。
        await selectR1Model();
      }
      const marker = `E2E_CUA_R1_${kind.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${marker}: run the controlled observation fixture.`,
        marker,
        `R1 ${kind} submission was not accepted`,
      );
      cases[kind].submissionAccepted = true;
      const block = await waitForToolCallBlockByToolName(TOOL, 60_000);
      const toolCallId = block.toolCallId;
      if (!toolCallId) throw new Error("node_repl call lacks a live tool call ID");
      caseToolIds[kind] = toolCallId;
      // 前一张工具权限可自动放行；只在当前卡片明确显示工具名时单次点击。
      // 读取确认可紧接工具确认出现，绝不能把后者误当成前者再次点击。
      let admissionError: unknown;
      await browser.waitUntil(
        async () => {
          try {
            const dialog = await readR1PermissionDialog();
            if (dialog.kind === "node") {
              await clickR1AllowOnce("node");
              return true;
            }
            if (dialog.kind === "read") return true;
            return (await listToolCallBlocks()).some(
              (candidate) =>
                candidate.toolCallId === toolCallId &&
                (candidate.status === "completed" || candidate.status === "failed"),
            );
          } catch (error) {
            admissionError = error;
            return true;
          }
        },
        {
          timeout: 60_000,
          timeoutMsg: "Node REPL admission or read request did not arrive",
        },
      );
      if (admissionError) throw admissionError;
      if (kind !== "metadata") {
        const seenRequestIds = new Set<string>();
        const confirmationCount = 1;
        for (let confirmation = 0; confirmation < confirmationCount; confirmation += 1) {
          let readError: Error | undefined;
          let dialog = await readR1PermissionDialog();
          await browser.waitUntil(
            async () => {
              dialog = await readR1PermissionDialog();
              if (
                dialog.kind === "read" &&
                dialog.requestId &&
                !seenRequestIds.has(dialog.requestId)
              )
                return true;
              const result = latestResult(toolCallId);
              if (result) {
                readError = new Error(
                  `Read approval was not reached: ${JSON.stringify(safeReceipt(result, fixture))}`,
                );
                return true;
              }
              const block = (await listToolCallBlocks()).find(
                (item) => item.toolCallId === toolCallId,
              );
              if (block?.status === "completed" || block?.status === "failed") {
                readError = new Error(
                  `Read approval was not reached: tool ${block.status}; provider result not yet received`,
                );
                return true;
              }
              return false;
            },
            {
              timeout: 60_000,
              timeoutMsg: "Distinct cua_ax_read_confirm request did not arrive",
            },
          );
          if (readError) throw readError;
          if (!dialog.requestId) throw new Error("Read request identity missing");
          seenRequestIds.add(dialog.requestId);
          cases[kind].readApprovalSeen = true;
          expect(dialog.text).toMatch(/Read window content|读取窗口/);
          expect(dialog.text).toContain(String(fixture.pid));
          expect(dialog.text).toContain(String(fixture.targetWindow));
          expect(dialog.allowAlways).toBe(false);
          expect(dialog.fullAccess).toBe(false);
          if (kind === "deny") {
            expect(await denyV4PermissionWithFeedback("")).toBe(true);
            cases[kind].decisionClicked = "deny";
          } else {
            await clickR1AllowOnce("read", dialog.requestId);
            cases[kind].decisionClicked = "allow";
          }
          cases[kind].readConfirmations += 1;
        }
        if (seenRequestIds.size !== confirmationCount)
          throw new Error("Read confirmation IDs not distinct");
      }
      await waitForV4TimelineContaining(`E2E_CUA_R1_${kind.toUpperCase()}_DONE`, 90_000);
      let result = latestResult(toolCallId);
      await browser.waitUntil(
        async () => {
          result = latestResult(toolCallId);
          return Boolean(result);
        },
        {
          timeout: 30_000,
          timeoutMsg: "Actual node_repl tool result was not delivered to the model",
        },
      );
      const expectedMarker = `E2E_R1_${kind === "metadata" ? "METADATA" : kind === "deny" ? "DENIED" : "ALLOWED"}_OK`;
      if (!result?.content.includes(expectedMarker) || (kind !== "deny" && result.isError)) {
        throw new Error(`R1 ${kind} failed: ${JSON.stringify(safeReceipt(result, fixture))}`);
      }
      const receipt = safeReceipt(result, fixture);
      expect(receipt.received).toBe(true);
      if (kind === "allow")
        expect(
          receipt.diagnostics?.some((d) => d.case === "allow" && d.targetSeen && !d.siblingLeak),
        ).toBe(true);
      else expect(receipt.diagnostics?.every((d) => !d.targetLeak && !d.siblingLeak)).toBe(true);
      cases[kind].passed = true;
    });
  }
  it("CUA-AX-R1-03a/03b: five provider-visible state observations in one turn", async function () {
    this.timeout(300_000);
    cases.state.executed = true;
    caseFixtures.state = snapshotR1Fixture(fixture);
    await startNewV4Draft();
    await selectR1Model();
    await sendV4PromptAndWaitAccepted(
      "E2E_CUA_R1_STATE: run five controlled observations.",
      "E2E_CUA_R1_STATE",
      "R1 state submission was not accepted",
    );
    cases.state.submissionAccepted = true;
    await runR1StateCells({
      fixture,
      latestResult,
      onCall: (id) => stateToolIds.push(id),
      onReadSeen: () => {
        cases.state.readApprovalSeen = true;
      },
      onReadAllowed: () => {
        cases.state.decisionClicked = "allow";
        cases.state.readConfirmations += 1;
      },
    });
    await waitForV4TimelineContaining("E2E_CUA_R1_STATE_DONE", 60_000);
    expect(cases.state.readConfirmations).toBe(5);
    cases.state.passed = true;
  });
  for (const kind of ["rebuild", "stop"] as const) {
    it(`CUA-AX-R1-03${kind === "rebuild" ? "c" : "d"}: ${kind} lifecycle`, async function () {
      this.timeout(300_000);
      if (fixtureProfile.kind !== "explicit-ax-content-v1") this.skip();
      const receipt = lifecycleReceipts[kind]!;
      receipt.executed = true;
      fixtureLaunch ??= await inspectR1FixtureLaunch(fixture);
      if (kind === "stop") {
        fixture = await refreshR1Fixture(
          fixture,
          process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!,
          resolve(RUNTIME, "manifest.json"),
          fixtureLaunch,
        );
        receipt.fixtureRefreshed = true;
      }
      await startNewV4Draft();
      await selectR1Model();
      const marker = `E2E_CUA_R1_${kind.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${marker}: run the controlled observation fixture.`,
        marker,
        `R1 ${kind} submission not accepted`,
      );
      receipt.submissionAccepted = true;
      const context = {
        fixture,
        manifestPath: process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!,
        runtimeManifest: resolve(RUNTIME, "manifest.json"),
        latestResult,
        receipt,
      };
      if (kind === "rebuild") {
        fixture = await runR1Rebuild(context);
        await writeFile(resolve(RUNTIME, "manifest.json"), JSON.stringify(fixture), {
          mode: 0o600,
        });
      } else await runR1Stop(context, (id) => r1NoStoppedContinuation(captured, id));
      receipt.passed = true;
    });
  }
  it("CUA-AX-R1-B: allowed read Stop before delivery", async function () {
    this.timeout(300_000);
    if (fixtureProfile.kind !== "controlled-read-delivery-v1") this.skip();
    const receipt = lifecycleReceipts.delivery!;
    receipt.executed = true;
    await startNewV4Draft();
    await selectR1Model();
    await sendV4PromptAndWaitAccepted(
      "E2E_CUA_R1_STOP: run the controlled observation fixture.",
      "E2E_CUA_R1_STOP",
      "R1 delivery submission not accepted",
    );
    const context = {
      fixture,
      manifestPath: process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!,
      runtimeManifest: resolve(RUNTIME, "manifest.json"),
      latestResult,
      receipt,
    };
    const barrier = createR1DeliveryBarrier(context, evidenceDir);
    await runR1Stop(context, (id) => r1NoStoppedContinuation(captured, id), barrier);
    await barrier.verify();
    receipt.passed = true;
  });
});

async function selectR1Model() {
  await selectRegistryProviderModelById(CUA_R1_MODEL, {
    providerId: CUA_R1_PROVIDER,
    providerName: "CUA R1 fixture",
    includePlainModelFallback: false,
  });
}
