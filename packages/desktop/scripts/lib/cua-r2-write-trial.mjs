const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const text = (value) => typeof value === "string" && value.length > 0;
const boolean = (field, value) =>
  field?.present === true && field.type === "boolean" && field.value === value;
const same = (a, b) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};
const point = (value) => Array.isArray(value) && value.length === 2 && value.every(finite);
const windows = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (row) => integer(row?.id, 1) && integer(row.pid, 1) && Number.isSafeInteger(row.layer),
  );
function sampleValid(sample) {
  return (
    sample &&
    integer(sample.sequence, 1) &&
    finite(sample.monotonic) &&
    sample.active === true &&
    sample.key === true &&
    sample.firstResponder === true &&
    point(sample.pointer) &&
    integer(sample.clipboard) &&
    integer(sample.space, 1) &&
    windows(sample.windows) &&
    boolean(sample.console, true) &&
    boolean(sample.login, true) &&
    boolean(sample.rootLocked, false) &&
    (boolean(sample.cgLocked, false) ||
      (sample.cgLocked?.present === false &&
        sample.cgLocked.type === "missing" &&
        sample.cgLocked.value === null)) &&
    sample.displayExists === true &&
    sample.displayOnline === true &&
    sample.displayActive === true &&
    sample.displayAsleep === false &&
    sample.guard === "allowed"
  );
}
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort());
const nonceValid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const barrierRecord = (record) =>
  exactKeys(record, ["nonce", "sequence"]) &&
  nonceValid(record.nonce) &&
  integer(record.sequence, 1);
const auditRecord = (row, event, status) =>
  exactKeys(row, ["event", "attempt", "scope", "dispatch_status"]) &&
  row.event === event &&
  row.dispatch_status === status &&
  integer(row.attempt, 1) &&
  typeof row.scope === "string" &&
  /^[a-f0-9]{16}$/.test(row.scope);
const model = (value) =>
  exactKeys(value, ["requests", "presses", "value", "ignoreEffects"]) &&
  integer(value.requests) &&
  integer(value.presses) &&
  typeof value.value === "string" &&
  value.ignoreEffects === false;
function metadataPair(rows, pid, first, second, title) {
  if (!Array.isArray(rows) || rows.length !== 2) return false;
  const targets = rows.filter((row) => row?.id === first);
  const siblings = rows.filter((row) => row?.id === second);
  return (
    targets.length === 1 &&
    siblings.length === 1 &&
    [targets[0], siblings[0]].every(
      (row) => exactKeys(row, ["id", "pid", "title"]) && row.pid === pid && row.title === title,
    )
  );
}
/** 只评价已采集的证据；纯评分不能证明真实性、完成校准或替代人工验收。 */
export function evaluateWriteTrial(input) {
  const fail = (status, reason) => ({
    trialId: typeof input?.trialId === "string" ? input.trialId : null,
    kind: typeof input?.kind === "string" ? input.kind : null,
    status,
    reason,
    liveAcceptance: false,
  });
  if (
    !text(input?.trialId) ||
    !text(input?.kind) ||
    !["left_click", "perform_action", "set_value"].includes(input?.method)
  )
    return fail("failed", "trial-invalid");
  const monitor = input.monitor;
  if (
    !monitor ||
    monitor.trialId !== input.trialId ||
    !integer(monitor.pid, 1) ||
    !Array.isArray(monitor.samples) ||
    !Array.isArray(monitor.keys) ||
    !Array.isArray(monitor.focus)
  )
    return fail("failed", "monitor-missing");
  const samples = [monitor.start, ...monitor.samples, monitor.end];
  if (samples.length < 3 || !samples.every(sampleValid))
    return fail("failed", "monitor-invalid-or-system-ineligible");
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1],
      current = samples[i];
    if (current.sequence <= previous.sequence || current.monotonic <= previous.monotonic)
      return fail("failed", "sample-order");
    for (const signal of ["pointer", "clipboard", "space", "windows"])
      if (!same(current[signal], samples[0][signal])) return fail("failed", `${signal}-changed`);
  }
  if (monitor.focus.length) return fail("failed", "focus-event");
  const keys = monitor.keys;
  if (
    keys.some(
      (key, index) =>
        !integer(key.sequence, 1) ||
        !finite(key.monotonic) ||
        typeof key.text !== "string" ||
        typeof key.repeat !== "boolean" ||
        key.fixtureDropped !== false ||
        key.sourcePID !== 0 ||
        !integer(key.sourceState) ||
        key.monotonic < samples[0].monotonic ||
        key.monotonic > samples.at(-1).monotonic ||
        (index > 0 &&
          (key.sequence !== keys[index - 1].sequence + 1 ||
            key.monotonic <= keys[index - 1].monotonic)),
    )
  )
    return fail("failed", "non-manual-or-missing-input");
  // 中文原因：真实硬件重复仍是输入；未建模的编辑键不能作为完成证据。
  if (keys.some((key) => !/^[a-z0-9]$/.test(key.text)))
    return fail("not-proven", "input-edit-not-covered");
  if (monitor.insertedText !== keys.map((key) => key.text).join(""))
    return fail("failed", "input-loss-or-reorder");
  const barrier = input.barrier;
  if (
    !barrier ||
    !nonceValid(barrier.fixtureNonce) ||
    !integer(barrier.previousSequence) ||
    !barrierRecord(barrier.pending) ||
    !barrierRecord(barrier.release)
  )
    return fail("not-proven", "barrier-evidence-missing");
  if (
    barrier.pending.nonce !== barrier.fixtureNonce ||
    barrier.pending.nonce !== barrier.release.nonce ||
    barrier.pending.sequence !== barrier.release.sequence ||
    barrier.pending.sequence !== barrier.previousSequence + 1
  )
    return fail("failed", "barrier-mismatch-or-stale");
  const witness = input.witness,
    fence = monitor.baselineFence,
    fenceRequest = monitor.fenceRequest,
    keyObservation = witness?.keyObservation;
  if (
    !witness ||
    witness.trialId !== input.trialId ||
    !fence ||
    !exactKeys(fenceRequest, ["sequence", "trialId", "kind"]) ||
    fenceRequest.kind !== "fence" ||
    fenceRequest.trialId !== input.trialId ||
    !exactKeys(keyObservation, ["trialId", "key"]) ||
    keyObservation.trialId !== input.trialId ||
    fence.trialId !== input.trialId ||
    !integer(fence.sequence, 1) ||
    !integer(fence.keySequence) ||
    !integer(witness.fenceCommandSequence, 1) ||
    !integer(witness.baselineKeySequence) ||
    !integer(witness.keySequence, 1)
  )
    return fail("not-proven", "monitor-fence-or-witness-missing");
  const order = [
    witness.beforeOrder,
    witness.pendingOrder,
    witness.fenceRequestOrder,
    witness.fenceAckOrder,
    witness.keyOrder,
    witness.releaseOrder,
    witness.effectOrder,
  ];
  // 中文原因：只有 pending 后由监测进程主线程确认的 key fence，才能排除旧按键的异步落盘。
  if (
    !order.every((n) => integer(n, 1)) ||
    order.some((n, i) => i > 0 && n <= order[i - 1]) ||
    fence.sequence !== witness.fenceCommandSequence ||
    fenceRequest.sequence !== fence.sequence ||
    fence.keySequence !== witness.baselineKeySequence ||
    witness.keySequence <= fence.keySequence ||
    !keys.some((key) => key.sequence === witness.keySequence && same(key, keyObservation.key)) ||
    (keys.length && fence.keySequence < keys[0].sequence - 1)
  )
    return fail("not-proven", "no-causal-input-overlap");
  const native = input.native,
    receipt = native?.receipt,
    audit = native?.audit;
  if (
    native?.received !== true ||
    native?.isError !== false ||
    !receipt ||
    !Array.isArray(audit) ||
    audit.length !== 2
  )
    return fail("not-proven", "native-evidence-missing");
  if (
    receipt.action_sent !== true ||
    receipt.dispatch_status !== "sent" ||
    receipt.code !== undefined ||
    !["not_requested", "synced"].includes(receipt.state_sync_status) ||
    !auditRecord(audit[0], "admitted", "possibly_sent") ||
    !auditRecord(audit[1], "completed", "sent") ||
    audit[0].attempt !== audit[1].attempt ||
    audit[0].scope !== audit[1].scope
  )
    return fail("failed", "native-receipt-or-audit-mismatch");
  const effect = input.effect,
    before = effect?.before,
    after = effect?.after;
  if (
    !before ||
    !after ||
    !Array.isArray(effect.windowsBefore) ||
    !Array.isArray(effect.windowsAfter)
  )
    return fail("not-proven", "independent-effect-evidence-missing");
  const identity = [
    "fixtureKind",
    "pid",
    "targetWindow",
    "siblingWindow",
    "title",
    "targetMarker",
    "siblingMarker",
    "barrierEnabled",
    "barrierNonce",
  ];
  if (
    before.fixtureKind !== "controlled-ax-write-v1" ||
    !integer(before.pid, 1) ||
    !integer(before.targetWindow, 1) ||
    !integer(before.siblingWindow, 1) ||
    before.targetWindow === before.siblingWindow ||
    !text(before.title) ||
    !text(before.targetMarker) ||
    !text(before.siblingMarker) ||
    before.targetMarker === before.siblingMarker ||
    before.barrierEnabled !== true ||
    before.barrierNonce !== barrier.fixtureNonce ||
    identity.some((key) => !same(before[key], after[key])) ||
    !metadataPair(
      effect.windowsBefore,
      before.pid,
      before.targetWindow,
      before.siblingWindow,
      before.title,
    ) ||
    !metadataPair(
      effect.windowsAfter,
      before.pid,
      before.targetWindow,
      before.siblingWindow,
      before.title,
    ) ||
    !model(before.target) ||
    !model(after.target) ||
    !model(before.sibling) ||
    !model(after.sibling) ||
    !same(before.sibling, after.sibling) ||
    after.target.requests !== before.target.requests + 1
  )
    return fail("failed", "fixture-identity-or-sibling-mismatch");
  if (input.method === "set_value") {
    if (
      typeof effect.expectedValue !== "string" ||
      effect.expectedValue === before.target.value ||
      after.target.value !== effect.expectedValue ||
      after.target.presses !== before.target.presses
    )
      return fail("failed", "target-effect-mismatch");
  } else if (
    after.target.presses !== before.target.presses + 1 ||
    after.target.value !== before.target.value
  ) {
    return fail("failed", "target-effect-mismatch");
  }
  return fail("successful", "complete-write-evidence");
}
export function summarizeWriteTrials(rows) {
  const counts = Object.fromEntries(
    ["successful", "safe-refusal", "not-proven", "failed"].map((status) => [
      status,
      rows.filter((row) => row.status === status).length,
    ]),
  );
  return {
    total: rows.length,
    ...counts,
    allAttemptsAccountedFor: Object.values(counts).reduce((a, b) => a + b, 0) === rows.length,
    measurement: "controller-evidence-evaluation",
    calibration: "requires-independent-live-review",
    liveAcceptance: false,
    R2Complete: false,
  };
}
