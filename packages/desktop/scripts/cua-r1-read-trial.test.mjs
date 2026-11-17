import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evaluateReadTrial, summarizeReadTrials } from "./lib/cua-r1-read-trial.mjs";

function trial() {
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
  return {
    trialId: "appkit-1",
    kind: "appkit",
    monitor: {
      trialId: "appkit-1",
      start: sample(1),
      samples: [sample(2)],
      end: sample(3),
      focus: [],
      insertedText: "a",
      keys: [{ sequence: 1, monotonic: 2, text: "a", repeat: false, sourcePID: 0, sourceState: 1 }],
    },
    read: {
      allowed: {
        pid: 9,
        observationId: 1,
        sequence: 1,
        scopeDigest: "a".repeat(64),
        event: "allowed",
      },
      delivered: {
        pid: 9,
        observationId: 1,
        sequence: 3,
        scopeDigest: "a".repeat(64),
        event: "delivered",
      },
    },
    witness: {
      trialId: "appkit-1",
      keySequence: 1,
      allowedObservedBeforeWitnessArm: true,
      deliveryAbsentAfterKeyObserved: true,
    },
    result: { received: true, targetSeen: true, siblingSeen: false, isError: false },
  };
}
test("complete controller evidence can score one read but cannot claim live acceptance", () => {
  const result = evaluateReadTrial(trial());
  assert.equal(result.status, "successful");
  assert.equal(result.liveAcceptance, false);
});
test("physical OS key repeat is real input; an unsupported edit is unknown, not synthetic", () => {
  const repeated = trial();
  repeated.monitor.keys[0].text = "1";
  repeated.monitor.keys[0].repeat = true;
  repeated.monitor.insertedText = "1";
  assert.equal(evaluateReadTrial(repeated).status, "successful");
  const edited = trial();
  edited.monitor.keys[0].text = "\u007f";
  edited.monitor.insertedText = "";
  assert.equal(evaluateReadTrial(edited).status, "not-proven");
});
test("both locked samples never count as success even if a caller supplies allowed", () => {
  const input = trial();
  for (const sample of [input.monitor.start, ...input.monitor.samples, input.monitor.end])
    sample.rootLocked.value = true;
  assert.equal(evaluateReadTrial(input).status, "failed");
});
for (const field of [
  "pointer",
  "clipboard",
  "space",
  "windows",
  "console",
  "login",
  "rootLocked",
  "cgLocked",
  "guard",
]) {
  test(`missing ${field} cannot pass`, () => {
    const input = trial();
    delete input.monitor.samples[0][field];
    assert.equal(evaluateReadTrial(input).status, "failed");
  });
}
test("brief focus, pointer, clipboard, Space, layer or popup changes are retained failures", () => {
  for (const change of [
    (s) => (s.active = false),
    (s) => (s.key = false),
    (s) => (s.firstResponder = false),
    (s) => (s.pointer = [11, 20]),
    (s) => (s.clipboard = 2),
    (s) => (s.space = 8),
    (s) => s.windows.reverse().push({ id: 7, pid: 8, layer: 1 }),
  ]) {
    const input = trial();
    change(input.monitor.samples[0]);
    assert.equal(evaluateReadTrial(input).status, "failed");
  }
  const input = trial();
  input.monitor.focus.push({ kind: "resign-key" });
  assert.equal(evaluateReadTrial(input).status, "failed");
});
test("dropped or synthetic input and unrelated key witnesses are not positive evidence", () => {
  for (const change of [
    (t) => (t.monitor.insertedText = ""),
    (t) => (t.monitor.keys[0].sourcePID = 55),
    (t) => (t.witness.trialId = "other"),
    (t) => (t.witness.keySequence = 99),
    (t) => (t.witness.deliveryAbsentAfterKeyObserved = false),
    (t) => (t.witness.allowedObservedBeforeWitnessArm = false),
  ]) {
    const input = trial();
    change(input);
    assert.notEqual(evaluateReadTrial(input).status, "successful");
  }
});
test("body mismatch, sibling body, refused reads and late scope cannot pass", () => {
  for (const change of [
    (t) => (t.result.targetSeen = false),
    (t) => (t.result.siblingSeen = true),
    (t) => (t.result.isError = true),
    (t) => (t.read.delivered.scopeDigest = "b".repeat(64)),
    (t) => (t.read.delivered.observationId = 2),
    (t) => (t.read.delivered.sequence = 0),
  ]) {
    const input = trial();
    change(input);
    assert.notEqual(evaluateReadTrial(input).status, "successful");
  }
});
test("missing result and an error flag alone are unknown, never verified safe refusals", () => {
  const missing = trial();
  delete missing.result;
  const error = trial();
  error.result.isError = true;
  assert.equal(evaluateReadTrial(missing).status, "not-proven");
  assert.equal(evaluateReadTrial(error).status, "not-proven");
});
test("all attempts remain in totals; injected JSON cannot mark calibration or R1 complete", () => {
  const success = evaluateReadTrial(trial());
  const input = trial();
  input.witness.deliveryAbsentAfterKeyObserved = false;
  const unknown = evaluateReadTrial(input);
  const rows = [...Array.from({ length: 20 }, () => success), unknown];
  const summary = summarizeReadTrials(rows, { calibrated: true, measured: true });
  assert.equal(summary.total, 21);
  assert.equal(summary.successful, 20);
  assert.equal(summary.liveAcceptance, false);
  assert.equal(summary.calibration, "requires-independent-live-review");
  assert.equal(summary.R1Complete, false);
});
