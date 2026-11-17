import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cuaR1SystemChromeOptions,
  canPollR1SystemUI,
  r1SystemWaitBudgets,
  waitForR1SystemEligibility,
} from "./lib/cua-r1-system-driver.mjs";
const context = {
  platform: "darwin",
  specs: ["/repo/test/conversation-session-cua-r1-system-state.test.ts"],
  systemRun: "/controlled/system-run",
};
test("only explicitly configured macOS R1 system validation detaches driver lifetime", () => {
  const original = { args: ["--fixture"], windowTypes: ["page"], detach: false };
  const configured = cuaR1SystemChromeOptions(original, context);
  assert.equal(configured.detach, true);
  assert.equal(original.detach, false);
  assert.deepEqual(configured.args, original.args);
  for (const change of [
    { platform: "win32" },
    { systemRun: undefined },
    { systemRun: "relative" },
    { specs: ["other.test.ts"] },
    { specs: [] },
    { specs: [...context.specs, "/repo/test/other.test.ts"] },
  ])
    assert.equal(cuaR1SystemChromeOptions(original, { ...context, ...change }).detach, false);
});
test("manual recovery survives a long suspended interval but still waits for current unlock", async () => {
  let clock = 0;
  let reads = 0;
  const samples = [
    { guard: "unknown", sleepSequence: 11, wakeSequence: 0 },
    { guard: "locked", sleepSequence: 11, wakeSequence: 12 },
    { guard: "allowed", sleepSequence: 11, wakeSequence: 12 },
  ];
  const eligible = await waitForR1SystemEligibility({
    operatorWaitSeconds: 1800,
    faultBoundary: 10,
    now: () => clock,
    readSample: async () => samples[reads++],
    wait: async () => {
      clock += reads === 1 ? 420_000 : 5_000;
    },
  });
  assert.equal(eligible, true);
  assert.equal(reads, 3);
  assert.equal(clock, 425_000);
});
test("manual recovery expires without treating stale or unavailable facts as eligibility", async () => {
  for (const sample of [
    { guard: "allowed", sleepSequence: 1, wakeSequence: 2 },
    { guard: "unknown", sleepSequence: 11, wakeSequence: 12 },
  ]) {
    let clock = 0;
    assert.equal(
      await waitForR1SystemEligibility({
        operatorWaitSeconds: 60,
        faultBoundary: 10,
        now: () => clock,
        readSample: async () => sample,
        wait: async () => {
          clock += 10_000;
        },
      }),
      false,
    );
    assert.equal(clock, 60_000);
  }
  assert.deepEqual(r1SystemWaitBudgets(1800), {
    operatorMs: 1_800_000,
    recoveryMs: 1_800_000,
    testMs: 3_900_000,
    monitorSeconds: 4020,
  });
  for (const value of [0, 59, 1801, NaN, 60.5]) assert.throws(() => r1SystemWaitBudgets(value));
});
test("unavailable or missing system facts never permit browser UI polling", () => {
  for (const sample of [
    null,
    {},
    { guard: "locked", sleepSequence: 2, wakeSequence: 3 },
    { guard: "unknown", sleepSequence: 2, wakeSequence: 3 },
    { guard: "allowed" },
    { guard: "allowed", sleepSequence: 0, wakeSequence: 0, event: "complete" },
  ])
    assert.equal(canPollR1SystemUI(sample, null), false);
});
test("request latch blocks UI until this fault has actually slept and woken in order", () => {
  const sample = { guard: "allowed", sleepSequence: 0, wakeSequence: 0, event: "sample" };
  assert.equal(canPollR1SystemUI(sample, null), true);
  assert.equal(canPollR1SystemUI(sample, 10), false);
  assert.equal(canPollR1SystemUI({ ...sample, sleepSequence: 8, wakeSequence: 9 }, 10), false);
  assert.equal(canPollR1SystemUI({ ...sample, sleepSequence: 12, wakeSequence: 11 }, 10), false);
  assert.equal(canPollR1SystemUI({ ...sample, sleepSequence: 11, wakeSequence: 12 }, 10), true);
});
