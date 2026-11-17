const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const boolean = (field, value) =>
  field?.present === true && field.type === "boolean" && field.value === value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
function sameRead(a, b) {
  return (
    a?.event === "allowed" &&
    b?.event === "delivered" &&
    integer(a.pid, 1) &&
    a.pid === b.pid &&
    integer(a.observationId, 1) &&
    a.observationId === b.observationId &&
    /^[a-f0-9]{64}$/.test(a.scopeDigest) &&
    a.scopeDigest === b.scopeDigest &&
    integer(a.sequence, 1) &&
    integer(b.sequence, 1) &&
    a.sequence < b.sequence
  );
}
/** 仅对控制器实际采集的证据评分；调用此纯函数或传入 calibrated 不能建立真机验收。 */
export function evaluateReadTrial(input) {
  const fail = (status, reason) => ({
    trialId: input?.trialId ?? null,
    kind: input?.kind ?? null,
    status,
    reason,
    liveAcceptance: false,
  });
  const monitor = input?.monitor;
  if (
    !monitor ||
    monitor.trialId !== input.trialId ||
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
        key.sourcePID !== 0 ||
        !integer(key.sourceState) ||
        (index > 0 &&
          (key.sequence <= keys[index - 1].sequence || key.monotonic <= keys[index - 1].monotonic)),
    )
  )
    return fail("failed", "non-manual-test-input");
  // 中文原因：系统对真实硬件按键的重复仍是真实前台输入；退格等未建模编辑不等于合成输入。
  if (keys.some((key) => !/^[a-z0-9]$/.test(key.text)))
    return fail("not-proven", "input-edit-not-covered");
  if (monitor.insertedText !== keys.map((key) => key.text).join(""))
    return fail("failed", "input-loss-or-reorder");
  if (!input.result?.received || input.result.isError === true)
    return fail("not-proven", "read-not-successful");
  if (input.result.targetSeen !== true || input.result.siblingSeen !== false)
    return fail("failed", "body-or-window-mismatch");
  if (!sameRead(input.read?.allowed, input.read?.delivered))
    return fail("failed", "read-association-or-order");
  const witness = input.witness;
  // 中文原因：不能拿两个进程的局部时间或“有过按键”证明交错；必须由真实事件建立因果链。
  if (
    !witness ||
    witness.trialId !== input.trialId ||
    witness.allowedObservedBeforeWitnessArm !== true ||
    witness.deliveryAbsentAfterKeyObserved !== true ||
    !keys.some((key) => key.sequence === witness.keySequence)
  )
    return fail("not-proven", "no-causal-input-overlap");
  return fail("successful", "complete-read-evidence");
}
export function summarizeReadTrials(rows) {
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
    R1Complete: false,
    R2Unblocked: false,
  };
}
