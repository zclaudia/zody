import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateWriteTrial, summarizeWriteTrials } from "./lib/cua-r2-write-trial.mjs";

function trial(method = "left_click") {
  const boolean = (value) => ({ present: true, type: "boolean", value });
  const sample = (sequence) => ({
    sequence,
    monotonic: sequence,
    active: true,
    key: true,
    firstResponder: true,
    pointer: [10, 20],
    clipboard: 1,
    space: 7,
    windows: [{ id: 5, pid: 6, layer: 0 }],
    console: boolean(true),
    login: boolean(true),
    rootLocked: boolean(false),
    cgLocked: { present: false, type: "missing", value: null },
    displayExists: true,
    displayOnline: true,
    displayActive: true,
    displayAsleep: false,
    guard: "allowed",
  });
  const nonce = "C39EAB73-302A-4AD4-9DC5-37E851919C03";
  const target = {
    requests: 5,
    presses: 2,
    value: "old",
    ignoreEffects: false,
  };
  const sibling = {
    requests: 1,
    presses: 0,
    value: "sibling",
    ignoreEffects: false,
  };
  const manifest = {
    fixtureKind: "controlled-ax-write-v1",
    pid: 44,
    targetWindow: 51,
    siblingWindow: 52,
    title: "same title",
    targetMarker: "target",
    siblingMarker: "sibling",
    barrierEnabled: true,
    barrierNonce: nonce,
    target,
    sibling,
  };
  const observedKey = {
    sequence: 5,
    monotonic: 2,
    text: "a",
    repeat: false,
    sourcePID: 0,
    sourceState: 1,
    fixtureDropped: false,
  };
  const after = structuredClone(manifest);
  after.target.requests++;
  if (method === "set_value") after.target.value = "new";
  else after.target.presses++;
  return {
    trialId: "trial-1",
    kind: "appkit",
    method,
    monitor: {
      trialId: "trial-1",
      pid: 19,
      start: sample(1),
      samples: [sample(2)],
      end: sample(3),
      focus: [],
      insertedText: "a",
      keys: [structuredClone(observedKey)],
      fenceRequest: { sequence: 12, trialId: "trial-1", kind: "fence" },
      baselineFence: { sequence: 12, trialId: "trial-1", keySequence: 4 },
    },
    barrier: {
      fixtureNonce: nonce,
      previousSequence: 6,
      pending: { nonce, sequence: 7 },
      release: { nonce, sequence: 7 },
    },
    witness: {
      trialId: "trial-1",
      beforeOrder: 1,
      pendingOrder: 2,
      fenceRequestOrder: 3,
      fenceAckOrder: 4,
      keyOrder: 5,
      releaseOrder: 6,
      effectOrder: 7,
      fenceCommandSequence: 12,
      baselineKeySequence: 4,
      keySequence: 5,
      keyObservation: { trialId: "trial-1", key: structuredClone(observedKey) },
    },
    native: {
      received: true,
      isError: false,
      receipt: {
        action_sent: true,
        dispatch_status: "sent",
        state_sync_status: "not_requested",
      },
      audit: [
        {
          event: "admitted",
          attempt: 9,
          scope: "a".repeat(16),
          dispatch_status: "possibly_sent",
        },
        {
          event: "completed",
          attempt: 9,
          scope: "a".repeat(16),
          dispatch_status: "sent",
        },
      ],
    },
    effect: {
      before: manifest,
      after,
      windowsBefore: [
        { id: 51, pid: 44, title: "same title" },
        { id: 52, pid: 44, title: "same title" },
      ],
      windowsAfter: [
        { id: 51, pid: 44, title: "same title" },
        { id: 52, pid: 44, title: "same title" },
      ],
      ...(method === "set_value" ? { expectedValue: "new" } : {}),
    },
  };
}
for (const method of ["left_click", "perform_action", "set_value"]) {
  test(`${method} requires full independent evidence`, () => {
    const score = evaluateWriteTrial(trial(method));
    assert.equal(score.status, "successful");
    assert.equal(score.liveAcceptance, false);
  });
}
test("monitor safety, source and exact text are enforced", () => {
  for (const mutate of [
    (t) => {
      t.monitor.start.rootLocked.value = true;
    },
    (t) => {
      t.monitor.end.pointer = [11, 20];
    },
    (t) => {
      t.monitor.end.clipboard++;
    },
    (t) => {
      t.monitor.end.space++;
    },
    (t) => {
      t.monitor.end.windows.reverse();
      t.monitor.end.windows.push({ id: 9, pid: 6, layer: 0 });
    },
    (t) => {
      t.monitor.focus.push({ sequence: 1 });
    },
    (t) => {
      t.monitor.keys[0].sourcePID = 12;
    },
    (t) => {
      t.monitor.keys[0].fixtureDropped = true;
    },
    (t) => {
      t.monitor.insertedText = "";
    },
    (t) => {
      t.monitor.keys.push({ ...t.monitor.keys[0], sequence: 7, monotonic: 3 });
      t.monitor.insertedText = "aa";
    },
    (t) => {
      t.monitor.samples[0].sequence = t.monitor.start.sequence;
    },
  ]) {
    const t = trial();
    mutate(t);
    assert.notEqual(evaluateWriteTrial(t).status, "successful");
  }
});
test("requires unique current barrier and causally observed new key", () => {
  for (const mutate of [
    (t) => {
      t.barrier.pending.nonce = "wrong";
    },
    (t) => {
      t.barrier.release.sequence--;
    },
    (t) => {
      t.barrier.previousSequence = 7;
    },
    (t) => {
      t.witness.keyOrder = 7;
    },
    (t) => {
      t.witness.baselineKeySequence = 5;
    },
    (t) => {
      t.witness.keySequence = 4;
    },
    (t) => {
      delete t.witness.pendingOrder;
    },
    (t) => {
      delete t.monitor.baselineFence;
    },
    (t) => {
      t.monitor.baselineFence.keySequence = 5;
    },
    (t) => {
      t.witness.fenceCommandSequence++;
    },
    (t) => {
      t.effect.before.barrierEnabled = false;
    },
  ]) {
    const t = trial();
    mutate(t);
    assert.notEqual(evaluateWriteTrial(t).status, "successful");
  }
});
test("effect snapshots must bracket the pending and release chain", () => {
  const lateBefore = trial();
  lateBefore.witness.beforeOrder = lateBefore.witness.pendingOrder;
  assert.notEqual(evaluateWriteTrial(lateBefore).status, "successful");
  const earlyAfter = trial();
  earlyAfter.witness.effectOrder = earlyAfter.witness.releaseOrder;
  assert.notEqual(evaluateWriteTrial(earlyAfter).status, "successful");
});
test("requires raw fence command and matching last-key observation", () => {
  const missing = trial();
  delete missing.monitor.fenceRequest;
  assert.equal(evaluateWriteTrial(missing).status, "not-proven");
  const missingKey = trial();
  delete missingKey.witness.keyObservation;
  assert.equal(evaluateWriteTrial(missingKey).status, "not-proven");
});
test("native sent receipt cannot substitute for an independent target effect or untouched sibling", () => {
  for (const mutate of [
    (t) => {
      t.native.isError = true;
    },
    (t) => {
      delete t.native.received;
    },
    (t) => {
      t.native.receipt.action_sent = false;
    },
    (t) => {
      t.native.receipt.dispatch_status = "possibly_sent";
    },
    (t) => {
      t.native.audit[1].attempt++;
    },
    (t) => {
      t.native.audit[1].scope = "b".repeat(16);
    },
    (t) => {
      t.effect.after.target.presses--;
    },
    (t) => {
      t.effect.after.target.requests--;
    },
    (t) => {
      t.effect.after.sibling.value = "changed";
    },
    (t) => {
      t.effect.after.pid++;
    },
    (t) => {
      t.effect.after.title = "different";
    },
    (t) => {
      t.effect.after.siblingWindow = t.effect.after.targetWindow;
    },
    (t) => {
      t.effect.before.target.ignoreEffects = true;
    },
    (t) => {
      t.effect.windowsAfter[1].title = "other";
    },
    (t) => {
      t.effect.windowsBefore[1].pid++;
    },
    (t) => {
      delete t.effect.windowsAfter;
    },
  ]) {
    const t = trial();
    mutate(t);
    assert.notEqual(evaluateWriteTrial(t).status, "successful");
  }
  const set = trial("set_value");
  set.effect.after.target.value = "old";
  assert.notEqual(evaluateWriteTrial(set).status, "successful");
});
test("unsupported edit or incomplete causality stays unproven, summaries do not claim acceptance", () => {
  const t = trial();
  t.monitor.keys[0].text = "\u007f";
  t.monitor.insertedText = "";
  assert.equal(evaluateWriteTrial(t).status, "not-proven");
  const summary = summarizeWriteTrials([evaluateWriteTrial(trial()), evaluateWriteTrial(t)]);
  assert.equal(summary.successful, 1);
  assert.equal(summary["not-proven"], 1);
  assert.equal(summary.liveAcceptance, false);
  assert.equal(summary.R2Complete, false);
});
