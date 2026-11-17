import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readR1PermissionDialog, clickR1AllowOnce } from "./cua-r1-dialog.js";
import { readOptional, writeCControl } from "./cua-r1-read-monitor.js";
import { r1IdentityMatches, type R1Fixture } from "./cua-r1-receipt.js";
import { sendV4PromptAndWaitAccepted, waitForV4TimelineContaining } from "./v4-conversation.js";
import {
  canPollR1SystemUI,
  waitForR1SystemEligibility,
} from "../../../scripts/lib/cua-r1-system-driver.mjs";
export { r1SystemWaitBudgets } from "../../../scripts/lib/cua-r1-system-driver.mjs";
import {
  captureR1DriverBinding,
  reattachR1Driver,
} from "../../../scripts/lib/cua-r1-driver-reattach.mjs";
import { reloadE2EElectronServiceBridge } from "./e2e-electron-service-lifecycle.js";

export async function prepareR1DriverRestore(pid: number, evidence: string) {
  const inspector = process.env.ZODY_CUA_R1_PROCESS_INSPECTOR;
  const executable = process.env.ZODY_E2E_PACKAGED_APP_PATH;
  if (!inspector?.startsWith("/") || !executable?.startsWith("/"))
    throw new Error("R1 exact native process inspector missing");
  const run = promisify(execFile);
  const inspectProcess = async (targetPid: number) =>
    JSON.parse(
      (
        await run(
          inspector,
          [String(targetPid), executable, "io.github.zclaudia.zody.cua-normal-host-candidate"],
          { timeout: 5000 },
        )
      ).stdout,
    );
  const binding = await captureR1DriverBinding({ browser, pid, inspectProcess });
  await writeFile(
    resolve(evidence, "driver-binding-before.json"),
    JSON.stringify(binding, null, 2),
  );
  let used = false;
  return async () => {
    if (used) throw new Error("R1 driver restore is single-use");
    used = true;
    const receipt = await reattachR1Driver({ browser, binding, inspectProcess });
    await reloadE2EElectronServiceBridge(browser);
    const actualPid = await browser.electron.execute(() => process.pid);
    if (actualPid !== pid) throw new Error("R1 restored bridge selected a different candidate");
    await writeFile(
      resolve(evidence, "driver-rebind.json"),
      JSON.stringify({ ...receipt, bridgePid: actualPid }, null, 2),
    );
  };
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function isReadRefusal(result: Record<string, unknown>) {
  return (
    result.received === true &&
    result.error === true &&
    (result.name === "ComputerUseError" || result.mode === "returned-error") &&
    result.method === "get_app_state" &&
    result.actionSent === false &&
    result.dispatchStatus === "not_sent" &&
    ["screen_locked", "not_authorized", "permission_denied", "element_unavailable"].includes(
      String(result.brokerCode),
    ) &&
    result.targetSeen === false &&
    result.siblingSeen === false
  );
}
export function isSystemFaultRefusal(
  result: Record<string, unknown>,
  guard: string,
  faultObserved: boolean,
) {
  // 中文原因：故障前的权限拒绝不证明系统守卫生效；必须关联已观测故障与当前不可用状态。
  return faultObserved && ["locked", "unknown"].includes(guard) && isReadRefusal(result);
}
type SystemSample = {
  sequence: number;
  event: string;
  guard: string;
  processUID: number;
  consoleUID: number;
  console: { value: boolean };
  rootLocked: { value: boolean };
  sleepSequence: number;
  wakeSequence: number;
};
async function readSleepRecovery(input: {
  fixture: R1Fixture;
  runtime: string;
  evidence: string;
  priorRequests: Set<string>;
}) {
  // 中文原因：人工睡眠不能悬挂有上限的 SDK cell；负例已完成后，新 turn 独立确认恢复读取。
  await waitForV4TimelineContaining("E2E_CUA_R1_SYSTEM_SLEEP_DONE", 60_000);
  const marker = "E2E_CUA_R1_SYSTEM_RECOVERY_SLEEP";
  await sendV4PromptAndWaitAccepted(
    `${marker}: freshly read the same owned target after actual wake and unlock.`,
    marker,
    "R1 recovery input not accepted",
  );
  const confirmed = new Set<string>();
  let nodeClicked = false;
  await browser.waitUntil(
    async () => {
      if (await readOptional(resolve(input.runtime, "recovery-sleep.json"))) return true;
      const dialog = await readR1PermissionDialog();
      if (dialog.kind === "node" && !nodeClicked) {
        await clickR1AllowOnce("node");
        nodeClicked = true;
      }
      if (dialog.kind === "read" && dialog.requestId && !confirmed.has(dialog.requestId)) {
        if (
          input.priorRequests.has(dialog.requestId) ||
          !r1IdentityMatches(dialog.identity, input.fixture.pid, input.fixture.targetWindow) ||
          dialog.allowAlways ||
          dialog.fullAccess
        )
          throw new Error("R1 recovery requires a fresh exact-target single-use confirmation");
        await clickR1AllowOnce("read", dialog.requestId);
        confirmed.add(dialog.requestId);
      }
      return false;
    },
    { timeout: 40_000, interval: 25 },
  );
  if (confirmed.size !== 1) throw new Error("R1 recovery did not independently confirm once");
  await writeFile(
    resolve(input.evidence, "recovery-read-permission.json"),
    JSON.stringify(
      { priorRequestIds: [...input.priorRequests], requestIds: [...confirmed] },
      null,
      2,
    ),
  );
  const result = await readOptional(resolve(input.runtime, "recovery-sleep.json"));
  await waitForV4TimelineContaining(`${marker}_DONE`, 60_000);
  return result;
}
export async function runSystemPhase(input: {
  phase: "lock" | "sleep" | "switch";
  fixture: R1Fixture;
  runtime: string;
  system: string;
  evidence: string;
  startSequence: number;
  operatorWaitSeconds: number;
  restoreDriver: () => Promise<void>;
}) {
  const { phase, fixture, runtime, system, evidence } = input;
  const start = { sequence: input.startSequence };
  const rows: unknown[] = [];
  const confirmed = new Set<string>();
  let nodeClicked = false;
  let faultBoundary: number | null = null;
  let faultObserved = false,
    blocked = 0,
    baseline = true,
    recovered = false;
  for (let index = 0; index < 100; index++) {
    const key = `${phase}-${index}`;
    const deadline = Date.now() + 40_000;
    let result: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      result = await readOptional(resolve(runtime, `result-${key}.json`));
      if (result) break;
      const currentSystem = JSON.parse(
        await readFile(resolve(system, "latest-system.json"), "utf8"),
      ) as SystemSample;
      // 中文原因：故障请求一旦锁存，即使最后一个系统快照仍为 allowed，也不能向正在睡眠的 ChromeDriver 发 UI 命令。
      if (!canPollR1SystemUI(currentSystem, faultBoundary)) {
        await pause(25);
        continue;
      }
      const dialog = await readR1PermissionDialog();
      if (dialog.kind === "node" && !nodeClicked) {
        await clickR1AllowOnce("node");
        nodeClicked = true;
      }
      if (dialog.kind === "read" && dialog.requestId && !confirmed.has(dialog.requestId)) {
        if (
          !r1IdentityMatches(dialog.identity, fixture.pid, fixture.targetWindow) ||
          dialog.allowAlways ||
          dialog.fullAccess
        )
          throw new Error("R1 system target permission mismatch");
        await clickR1AllowOnce("read", dialog.requestId);
        confirmed.add(dialog.requestId);
      }
      await pause(10);
    }
    if (!result) throw new Error("R1 system probe did not return");
    const text = await readFile(resolve(system, "system-events.ndjson"), "utf8");
    const samples = text
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line) as SystemSample)
      .filter((sample) => sample.sequence > (faultBoundary ?? start.sequence));
    const latest = JSON.parse(
      await readFile(resolve(system, "latest-system.json"), "utf8"),
    ) as SystemSample;
    const positive =
      result.error === false &&
      result.full === true &&
      result.targetSeen === true &&
      result.siblingSeen === false;
    const refusal = isReadRefusal(result);
    const slept = faultBoundary !== null && latest.sleepSequence > faultBoundary;
    const woke = slept && latest.wakeSequence > latest.sleepSequence;
    const inactive = samples.some(
      (sample) =>
        sample.console.value === false ||
        sample.consoleUID !== sample.processUID ||
        sample.event === "NSWorkspaceSessionDidResignActiveNotification",
    );
    faultObserved ||=
      phase === "lock"
        ? samples.some((sample) => sample.rootLocked.value === true)
        : phase === "sleep"
          ? slept
          : inactive;
    const systemRefusal = refusal && isSystemFaultRefusal(result, latest.guard, faultObserved);
    if (systemRefusal) blocked++;
    rows.push({ key, result, latestSystem: latest, faultObserved, refusal, systemRefusal });
    await writeFile(resolve(evidence, `${key}.json`), JSON.stringify(rows.at(-1), null, 2));
    if (
      baseline &&
      faultObserved &&
      positive &&
      latest.guard === "allowed" &&
      blocked > 0 &&
      (phase !== "sleep" || woke)
    )
      recovered = true;
    if (phase === "sleep" && index === 0) {
      faultBoundary = latest.sequence;
      faultObserved = false;
      const child = spawn("/usr/bin/pmset", ["sleepnow"], { stdio: "ignore" });
      await writeFile(
        resolve(evidence, "sleep-command-started.json"),
        JSON.stringify({
          source: "controller-fault-injector",
          command: "/usr/bin/pmset",
          args: ["sleepnow"],
          pid: child.pid,
          userStartConfirmed: true,
          faultBoundary,
        }),
      );
      child.once("exit", (code, signal) => {
        void writeFile(
          resolve(evidence, "sleep-command-exit.json"),
          JSON.stringify({ code, signal }),
        );
      });
      child.once("error", () => {
        void writeFile(
          resolve(evidence, "sleep-command-exit.json"),
          JSON.stringify({ spawnFailed: true }),
        );
      });
      // 中文原因：先见到本轮真实睡眠与不可用事实，才放行下一次 SDK 探测；避免它在睡眠前挂在读取确认卡上。
      const faultDeadline = Date.now() + 40_000;
      let unavailable = false;
      while (Date.now() < faultDeadline) {
        const sample = JSON.parse(
          await readFile(resolve(system, "latest-system.json"), "utf8"),
        ) as SystemSample;
        if (sample.sleepSequence > faultBoundary && ["locked", "unknown"].includes(sample.guard)) {
          unavailable = true;
          break;
        }
        await pause(25);
      }
      if (!unavailable)
        throw new Error("Actual unavailable sleep interval was not observed; no probe replay");
    }
    if (phase === "sleep" && faultObserved && !positive) {
      const eligible = await waitForR1SystemEligibility({
        faultBoundary,
        operatorWaitSeconds: input.operatorWaitSeconds,
        readSample: async () =>
          JSON.parse(await readFile(resolve(system, "latest-system.json"), "utf8")) as SystemSample,
      });
      if (!eligible)
        throw new Error("Wake/unlock eligibility not established; no read confirmation replay");
      if (!systemRefusal) throw new Error("Unclassified fault reply; no recovery pass claimed");
      await input.restoreDriver();
      const recoveryResult = await readSleepRecovery({
        fixture,
        runtime,
        evidence,
        priorRequests: confirmed,
      });
      const recoverySystem = JSON.parse(
        await readFile(resolve(system, "latest-system.json"), "utf8"),
      ) as SystemSample;
      const recoveryPositive =
        recoveryResult?.error === false &&
        recoveryResult?.full === true &&
        recoveryResult?.targetSeen === true &&
        recoveryResult?.siblingSeen === false;
      const recoveryRow = {
        key: "sleep-recovery",
        result: recoveryResult,
        latestSystem: recoverySystem,
        faultObserved,
        refusal: false,
        systemRefusal: false,
      };
      rows.push(recoveryRow);
      await writeFile(
        resolve(evidence, "sleep-recovery.json"),
        JSON.stringify(recoveryRow, null, 2),
      );
      if (!recoveryPositive || !canPollR1SystemUI(recoverySystem, faultBoundary))
        throw new Error("Fresh full target recovery not established");
      recovered = true;
    }
    if (phase === "sleep" && faultObserved && positive && blocked === 0)
      throw new Error(
        "SDK fault reply remains unclassified; recovery retained but no pass claimed",
      );
    if (recovered) await writeCControl(runtime, `complete-${phase}.json`, { complete: true });
    await writeCControl(runtime, `ack-${key}.json`, { continue: !recovered });
    if (recovered) break;
  }
  const summary = {
    phase,
    baseline,
    faultObserved,
    blocked,
    recovered,
    passed: baseline && faultObserved && recovered,
    sleepLimit:
      phase === "sleep"
        ? "CPU suspended interval has no executable sampling; actual sleep/wake notifications and fresh read recovery are retained"
        : null,
  };
  await writeFile(
    resolve(evidence, `phase-summary-${phase}.json`),
    JSON.stringify(summary, null, 2),
  );
  if (!summary.passed) throw new Error(`R1 system phase ${phase} not established`);
  return summary;
}
