import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { readR1PermissionDialog, clickR1AllowOnce } from "../helpers/cua-r1-dialog.js";
import { clearAppData } from "../helpers/desktop-app.js";
import { seedCuaR1Provider, CUA_R1_MODEL, CUA_R1_PROVIDER } from "../helpers/cua-r1-provider.js";
import type { R1Fixture } from "../helpers/cua-r1-receipt.js";
import {
  observeCTrial,
  readCEvents,
  readOptional,
  writeCControl,
  evaluateReadTrial,
  summarizeReadTrials,
  type ReadTrialScore,
} from "../helpers/cua-r1-read-monitor.js";
import {
  createE2EReplayFixtureVariables,
  resolveE2ERuntimePath,
} from "../helpers/e2e-runtime-paths.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "../helpers/upstream-replay-server.js";
import { selectRegistryProviderModelById } from "../helpers/upstream-provider.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
} from "../helpers/v4-conversation.js";

const exec = promisify(execFile);
const NAME = "conversation-session-cua-r1-noninterference";
const runtime = resolveE2ERuntimePath("cua-r1-c");
let server: UpstreamReplayServer | undefined;
let fixture: R1Fixture;
let monitor = "",
  evidence = "",
  kind = "";
const scores: ReadTrialScore[] = [];
describe("CUA-AX-R1-04: real manual input with production read-only observations", () => {
  before(async function () {
    this.timeout(120_000);
    if (!process.env.ZODY_CUA_R1_MONITOR_RUN || !process.env.ZODY_CUA_R1_MONITOR_APP) this.skip();
    monitor = process.env.ZODY_CUA_R1_MONITOR_RUN!;
    evidence = process.env.ZODY_CUA_R1_EVIDENCE_DIR!;
    kind = process.env.ZODY_CUA_R1_READ_KIND!;
    const app = process.env.ZODY_CUA_R1_MONITOR_APP!;
    const manifest = process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!;
    if (
      ![monitor, evidence, app, manifest].every(isAbsolute) ||
      !["appkit", "electron"].includes(kind) ||
      !process.env.ZODY_E2E_PACKAGED_APP_PATH
    )
      throw new Error("R1 exact test boundaries missing");
    await clearAppData();
    fixture = JSON.parse(await readFile(manifest, "utf8")) as R1Fixture;
    if (
      !Number.isSafeInteger(fixture.pid) ||
      fixture.pid <= 0 ||
      !Number.isSafeInteger(fixture.targetWindow) ||
      fixture.targetWindow <= 0 ||
      fixture.targetWindow === fixture.siblingWindow ||
      fixture.targetMarker !== "E2E_R1_TARGET_BODY" ||
      fixture.siblingMarker !== "E2E_R1_SIBLING_BODY"
    )
      throw new Error("R1 C target manifest invalid");
    process.kill(fixture.pid, 0);
    await mkdir(runtime, { recursive: true });
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(runtime, "manifest.json"), JSON.stringify(fixture));
    server = await startUpstreamReplayServer({
      host: "127.0.0.1",
      artifactPath: resolve(evidence, "replay.json"),
      artifactWriter: async () => {},
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
    await selectRegistryProviderModelById(CUA_R1_MODEL, {
      providerId: CUA_R1_PROVIDER,
      providerName: "CUA R1 fixture",
      includePlainModelFallback: false,
    });
  });
  after(async function () {
    if (evidence)
      await writeFile(
        resolve(evidence, "read-trial-summary.json"),
        JSON.stringify(
          { kind, scores, ...summarizeReadTrials(scores), humanInputRequired: true },
          null,
          2,
        ),
      );
    if (evidence) {
      const intents = (await readdir(runtime).catch(() => [])).filter((name) =>
        /^intent-\d+\.json$/.test(name),
      );
      await writeFile(
        resolve(evidence, "read-events.json"),
        JSON.stringify(
          {
            intents: intents.length,
            completedRecords: scores.length,
            incomplete: intents.length - scores.length,
            events: await readCEvents(),
          },
          null,
          2,
        ),
      );
    }
    await server?.stop();
  });
  it("retains all attempts and requires 20 successful intersecting reads", async function () {
    this.timeout(600_000);
    await sendV4PromptAndWaitAccepted(
      "E2E_CUA_R1_C: run the controlled read-only concurrency acceptance.",
      "E2E_CUA_R1_C",
      "R1 C prompt not accepted",
    );
    await exec("/usr/bin/open", ["-n", process.env.ZODY_CUA_R1_MONITOR_APP!, "--args", monitor]);
    await browser.waitUntil(
      async () => {
        const ready = await readOptional(resolve(monitor, "operator-ready.json"));
        if (ready?.ready !== true) await browser.execute(() => true);
        return ready?.ready === true;
      },
      {
        timeout: 300_000,
        interval: 500,
        timeoutMsg: "R1 operator has not confirmed the explicit input prompt",
      },
    );
    const previousKey = (await readOptional(resolve(monitor, "last-key.json")))?.key?.sequence ?? 0;
    await browser.waitUntil(
      async () => {
        const ready =
          ((await readOptional(resolve(monitor, "last-key.json")))?.key?.sequence ?? 0) >
          previousKey;
        if (!ready) await browser.execute(() => true);
        return ready;
      },
      {
        timeout: 300_000,
        interval: 1000,
        timeoutMsg: "R1 requires actual manual typing in the input monitor",
      },
    );
    const reads = new Set<string>();
    for (let index = 0; index < 200; index++) {
      const record = await observeCTrial({ fixture, kind, index, runtime, monitor, reads });
      const score = evaluateReadTrial(record);
      scores.push(score);
      await writeFile(
        resolve(evidence, `${record.trialId}.json`),
        JSON.stringify({ ...record, score }, null, 2),
      );
      const successful = scores.filter((row) => row.status === "successful").length;
      const stopped = score.status === "failed" || successful >= 20;
      if (stopped) await writeCControl(runtime, "complete.json", { complete: true });
      await writeCControl(runtime, `ack-${index}.json`, { continue: !stopped });
      if (stopped) break;
    }
    await browser.waitUntil(
      async () => {
        const dialog = await readR1PermissionDialog();
        if (dialog.kind === "node") await clickR1AllowOnce("node");
        if (dialog.kind === "read")
          throw new Error("R1 unexpected read after completed read batch");
        return browser.execute(
          () =>
            document
              .querySelector('[data-testid="v4-session-pane-workspace-main"]')
              ?.textContent?.includes("E2E_CUA_R1_C_DONE") === true,
        );
      },
      { timeout: 120_000, interval: 100 },
    );
    await writeCControl(monitor, "command.json", { sequence: 1000, kind: "finish" });
    const summary = summarizeReadTrials(scores);
    expect(summary.failed).toBe(0);
    expect(summary.successful).toBeGreaterThanOrEqual(20);
  });
});
