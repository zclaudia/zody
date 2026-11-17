import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { clearAppData } from "../helpers/desktop-app.js";
import { seedCuaR1Provider, CUA_R1_MODEL, CUA_R1_PROVIDER } from "../helpers/cua-r1-provider.js";
import type { R1Fixture } from "../helpers/cua-r1-receipt.js";
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
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import { readOptional, writeCControl } from "../helpers/cua-r1-read-monitor.js";
import { readR1PermissionDialog, clickR1AllowOnce } from "../helpers/cua-r1-dialog.js";
import {
  runSystemPhase,
  r1SystemWaitBudgets,
  prepareR1DriverRestore,
} from "../helpers/cua-r1-system-state.js";
const exec = promisify(execFile);
const NAME = "conversation-session-cua-r1-system-state";
const runtime = resolveE2ERuntimePath("cua-r1-system");
let server: UpstreamReplayServer | undefined;
let fixture: R1Fixture;
let monitor = "",
  evidence = "",
  kind = "";
const phases: unknown[] = [];
let restoreDriver: () => Promise<void>;
describe("CUA-AX-R1-05: actual system faults and read-only guard recovery", () => {
  before(async function () {
    this.timeout(120_000);
    if (!process.env.ZODY_CUA_R1_SYSTEM_RUN || !process.env.ZODY_CUA_R1_MONITOR_APP) this.skip();
    monitor = process.env.ZODY_CUA_R1_SYSTEM_RUN!;
    evidence = process.env.ZODY_CUA_R1_EVIDENCE_DIR!;
    kind = process.env.ZODY_CUA_R1_READ_KIND!;
    const app = process.env.ZODY_CUA_R1_MONITOR_APP!;
    const manifest = process.env.ZODY_CUA_R1_FIXTURE_MANIFEST!;
    if (
      ![monitor, evidence, app, manifest].every(isAbsolute) ||
      !["system"].includes(kind) ||
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
    // 中文原因：睡眠轮候选曾先进入正常退出链；只记录退出调用栈和电源通知，不拦截退出或放宽守卫。
    const addon = process.env.ZODY_CUA_R1_QUIT_ORIGIN_ADDON;
    if (addon && !isAbsolute(addon))
      throw new Error("Quit origin diagnostic requires an absolute path");
    const diagnostic = await browser.electron.execute(
      async (electron, path, addonPath, signalPath) => {
        const fs = process.getBuiltinModule("node:fs/promises");
        const native = addonPath
          ? (process.getBuiltinModule("node:module").createRequire(addonPath)(addonPath) as {
              readQuitOrigin: () => string;
              installSignalObserver: (path: string) => string;
            })
          : undefined;
        const signalProbe =
          signalPath && native ? JSON.parse(native.installSignalObserver(signalPath)) : null;
        const nativeProbe = native ? JSON.parse(native.readQuitOrigin()) : null;
        await fs.appendFile(
          path,
          JSON.stringify({
            event: "registered",
            pid: process.pid,
            at: Date.now(),
            nativeProbe,
            signalProbe,
          }) + "\n",
        );
        let jsQuitCalls = 0;
        const record = (event: string) => {
          void fs
            .appendFile(
              path,
              JSON.stringify({
                event,
                pid: process.pid,
                at: Date.now(),
                jsQuitCalls,
                nativeOrigin:
                  event === "before-quit" && native ? JSON.parse(native.readQuitOrigin()) : null,
                stack: new Error().stack,
              }) + "\n",
            )
            .catch(() => {});
        };
        const quit = electron.app.quit;
        electron.app.quit = function () {
          jsQuitCalls++;
          record("js-app-quit");
          return quit.apply(this, arguments as unknown as []);
        };
        electron.app.prependListener("before-quit", () => record("before-quit"));
        electron.powerMonitor.on("suspend", () => record("suspend"));
        electron.powerMonitor.on("resume", () => record("resume"));
        electron.powerMonitor.on("lock-screen", () => record("lock-screen"));
        electron.powerMonitor.on("unlock-screen", () => record("unlock-screen"));
        electron.powerMonitor.on("shutdown", () => record("shutdown"));
        for (const window of electron.BrowserWindow.getAllWindows()) {
          window.on("close", () => record("window-close"));
          window.on("closed", () => record("window-closed"));
          window.webContents.on("render-process-gone", () => record("render-process-gone"));
        }
        return { registered: true, pid: process.pid, nativeProbe, signalProbe };
      },
      resolve(evidence, "app-power-events.ndjson"),
      addon,
      process.env.ZODY_CUA_R1_SIGNAL_OBSERVER === "1"
        ? resolve(evidence, "native-signals.bin")
        : undefined,
    );
    // 中文原因：bridge 不保证把 Runtime.exceptionDetails 抛出；必须核对实际注册结果和落盘收据。
    await writeCControl(
      evidence,
      "diagnostic-registration.json",
      diagnostic ?? { registered: false },
    );
    expect(diagnostic?.registered).toBe(true);
    const registered = JSON.parse(
      (await readFile(resolve(evidence, "app-power-events.ndjson"), "utf8")).split("\n")[0]!,
    );
    expect(registered.pid).toBe(diagnostic.pid);
    if (addon) expect(typeof diagnostic.nativeProbe?.isQuitApplication).toBe("boolean");
    if (process.env.ZODY_CUA_R1_SIGNAL_OBSERVER === "1")
      expect(diagnostic.signalProbe?.forwardExisting).toBe(true);
    restoreDriver = await prepareR1DriverRestore(diagnostic.pid, evidence);
  });
  after(async () => {
    if (evidence)
      await writeFile(
        resolve(evidence, "system-summary.json"),
        JSON.stringify({ phases, R2Unblocked: false }, null, 2),
      );
    await server?.stop();
  });
  it("rejects locked and inactive sessions and recovers after actual sleep/wake", async function () {
    const operatorWaitSeconds = Number(process.env.ZODY_CUA_R1_OPERATOR_WAIT_SECONDS ?? 300);
    this.timeout(r1SystemWaitBudgets(operatorWaitSeconds).testMs);
    if (process.env.ZODY_CUA_R1_SYSTEM_DIAGNOSTIC_ONLY === "1") {
      if (process.env.ZODY_CUA_R1_REBIND_DIAGNOSTIC_ONLY === "1") {
        await restoreDriver();
        await writeCControl(evidence, "driver-rebind-diagnostic.json", {
          acceptance: false,
          noSleep: true,
          noSdkBody: true,
          R2Unblocked: false,
        });
      }
      await writeCControl(evidence, "diagnostic-only.json", {
        noSystemFault: true,
        acceptance: false,
        R1Complete: false,
        R2Unblocked: false,
      });
      return;
    }
    const selected = (process.env.ZODY_CUA_R1_SYSTEM_PHASES ?? "lock,sleep,switch").split(
      ",",
    ) as Array<"lock" | "sleep" | "switch">;
    if (
      !selected.length ||
      selected.some((p) => !["lock", "sleep", "switch"].includes(p)) ||
      new Set(selected).size !== selected.length
    )
      throw new Error("Invalid explicit system phase selection");
    for (const phase of selected) {
      const baselineMarker = `E2E_CUA_R1_SYSTEM_BASELINE_${phase.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${baselineMarker}: verify the owned target before the operator action.`,
        baselineMarker,
        "R1 system baseline not accepted",
      );
      const approved = new Set<string>();
      let nodeClicked = false;
      await browser.waitUntil(
        async () => {
          const result = await readOptional(resolve(runtime, `baseline-${phase}.json`));
          if (result) return true;
          const d = await readR1PermissionDialog();
          if (d.kind === "node" && !nodeClicked) {
            await clickR1AllowOnce("node");
            nodeClicked = true;
          }
          if (d.kind === "read" && d.requestId && !approved.has(d.requestId)) {
            await clickR1AllowOnce("read", d.requestId);
            approved.add(d.requestId);
          }
          return false;
        },
        { timeout: 60_000, interval: 50 },
      );
      const baseline = await readOptional(resolve(runtime, `baseline-${phase}.json`));
      if (baseline?.error || !baseline?.full || !baseline?.targetSeen || baseline?.siblingSeen)
        throw new Error("R1 system baseline failed");
      await waitForV4TimelineContaining(`${baselineMarker}_DONE`, 60_000);
      const start = JSON.parse(await readFile(resolve(monitor, "latest-system.json"), "utf8")) as {
        sequence: number;
      };
      await writeCControl(evidence, `phase-ready-${phase}.json`, {
        phase,
        baselineVerified: true,
        toolCompletedBeforeHumanWait: true,
      });
      const prompt = process.env.ZODY_CUA_R1_OPERATOR_PROMPT;
      if (!prompt || !isAbsolute(prompt))
        throw new Error("R1 exact native operator prompt missing");
      const answerPath = resolve(evidence, `user-alert-${phase}.json`);
      try {
        await exec(
          "/usr/bin/open",
          ["-n", "-W", prompt, "--args", phase, answerPath, String(operatorWaitSeconds)],
          {
            timeout: operatorWaitSeconds * 1000 + 5_000,
          },
        );
      } catch {
        // 中文原因：LaunchServices 退出状态不能覆盖真实按钮答复；缺少当前轮答复仍由下面的读取严格失败。
        await writeCControl(evidence, `operator-launch-error-${phase}.json`, {
          launchFailed: true,
          answerStillRequired: true,
        });
      }
      const ready = JSON.parse(await readFile(answerPath, "utf8")) as {
        ready: boolean;
        source: string;
      };
      if (ready.ready !== true || ready.source !== "native-user-alert")
        throw new Error("R1 operator did not start");
      await writeCControl(evidence, `operator-start-${phase}.json`, ready);
      // 中文原因：让独立夹具保持前台，隔离系统操作与候选应用菜单；不更改后台读取的窗口身份或状态守卫。
      await exec("/usr/bin/open", ["-n", process.env.ZODY_CUA_R1_MONITOR_APP!, "--args", monitor]);
      await browser.waitUntil(
        async () => Boolean(await readOptional(resolve(monitor, "monitor-ready.json"))),
        { timeout: 10_000 },
      );
      const marker = `E2E_CUA_R1_SYSTEM_${phase.toUpperCase()}`;
      await sendV4PromptAndWaitAccepted(
        `${marker}: probe the owned target during the authorized system transition.`,
        marker,
        "R1 fault probe not accepted",
      );
      phases.push(
        await runSystemPhase({
          phase,
          fixture,
          runtime,
          system: monitor,
          evidence,
          startSequence: start.sequence,
          operatorWaitSeconds,
          restoreDriver,
        }),
      );
      await waitForV4TimelineContaining(`${marker}_DONE`, 120_000);
    }
    expect(phases).toHaveLength(selected.length);
    const origin = JSON.parse(
      await readFile(resolve(evidence, "diagnostic-registration.json"), "utf8"),
    ) as { pid: number };
    const currentPid = await browser.electron.execute(() => process.pid);
    expect(currentPid).toBe(origin.pid);
    await writeCControl(evidence, "same-candidate-survived.json", {
      beforePid: origin.pid,
      afterPid: currentPid,
      sameProcess: true,
      R2Unblocked: false,
    });
  });
});
