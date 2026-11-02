function allChecksPass(checks) {
  return checks.every((entry) => entry.ok);
}

function check(checks, name, ok, details) {
  checks.push(details === undefined ? { name, ok } : { name, ok, details });
}

function safetyMatches(response) {
  return (
    response?.diagnosticOnly === true &&
    response?.grant === false &&
    response?.nativeCapabilityProven === false &&
    response?.runtimeConsumable === false &&
    response?.productHook === false
  );
}

function mark(scenario, checks) {
  scenario.checks = checks;
  scenario.status = allChecksPass(checks) ? "pass" : "fail";
}

export function assertScenarios(scenarios) {
  const find = (id) => scenarios.find((entry) => entry.id === id);
  const real = find("real-peer-adhoc-rejected");
  const wrongPid = find("wrong-pid");
  const wrongUid = find("wrong-uid");
  const blocked = find("default-blocked");
  const positive = find("synthetic-policy-positive");
  const existingSocket = find("existing-socket-retained");
  const replacement = find("replaced-socket-retained");
  const partial = find("partial-frame-timeout");

  const realChecks = [];
  check(realChecks, "real server exit 0", real.exitCode === 0);
  check(realChecks, "client exit 0", real.clientExitCode === 0 && real.clientTimedOut === false);
  check(realChecks, "audit token captured", real.response.peer?.auditTokenCaptured === true);
  check(
    realChecks,
    "no PID fallback",
    real.response.peer?.usesPidFallback === false &&
      real.response.security?.usesPidFallback === false,
  );
  check(
    realChecks,
    "observed PID equals spawned client PID",
    real.response.peer?.pidObserved === real.actual.pid,
    { observed: real.response.peer?.pidObserved, actual: real.actual.pid },
  );
  check(
    realChecks,
    "observed euid equals actual euid",
    real.response.peer?.euidObserved === real.actual.uid,
  );
  check(realChecks, "asid observed", typeof real.response.peer?.asidObserved === "number");
  check(realChecks, "pidversion observed positive", real.response.peer?.pidVersionObserved > 0);
  check(realChecks, "asid not-pinned", real.response.peer?.asidMatched === "not-pinned");
  check(
    realChecks,
    "pidversion not-pinned",
    real.response.peer?.pidVersionMatched === "not-pinned",
  );
  check(
    realChecks,
    "no login-session inference",
    real.response.peer?.loginSessionInferred === false,
  );
  check(
    realChecks,
    "no parent-relationship inference",
    real.response.peer?.parentRelationshipInferred === false,
  );
  check(
    realChecks,
    "Security guest from full audit token",
    real.response.security?.guestAttribute === "kSecGuestAttributeAudit" &&
      real.response.security?.guestCreated === true,
  );
  check(realChecks, "ad-hoc signature observed", real.response.security?.adhoc === true);
  check(realChecks, "no leaf certificate", real.response.security?.certificateCount === 0);
  check(
    realChecks,
    "Security rejects identity",
    real.response.decision?.accepted === false &&
      ["ad-hoc-signature", "missing-certificate"].includes(real.response.decision?.reason),
  );
  check(
    realChecks,
    "static artifact pin matched",
    real.response.staticArtifact?.matched === true &&
      real.response.staticArtifact?.allPerformed === true,
  );
  check(
    realChecks,
    "helper authorization remains blocked",
    real.response.helperAuthorization === "blocked",
  );
  check(
    realChecks,
    "profile scope is not a full doctor",
    String(real.response.profileValidationScope).includes("not performed"),
  );
  check(realChecks, "no diagnostic capability", safetyMatches(real.response));
  mark(real, realChecks);

  const wrongPidChecks = [];
  check(
    wrongPidChecks,
    "PID mismatch rejected",
    wrongPid.response?.peer?.pidMatched === false &&
      wrongPid.response?.decision?.reason === "peer-pid-mismatch",
  );
  check(wrongPidChecks, "wrong PID keeps capability off", safetyMatches(wrongPid.response));
  mark(wrongPid, wrongPidChecks);

  const wrongUidChecks = [];
  check(
    wrongUidChecks,
    "UID mismatch rejected",
    wrongUid.response?.peer?.euidMatched === false &&
      wrongUid.response?.decision?.reason === "peer-uid-mismatch",
  );
  check(wrongUidChecks, "wrong UID keeps capability off", safetyMatches(wrongUid.response));
  mark(wrongUid, wrongUidChecks);

  const blockedChecks = [];
  check(
    blockedChecks,
    "default profile blocked",
    blocked.exitCode === 2 &&
      blocked.response?.status === "blocked" &&
      blocked.response?.reason === "profile-missing",
  );
  mark(blocked, blockedChecks);

  const positiveChecks = [];
  check(
    positiveChecks,
    "synthetic positive is policy-only",
    positive.response?.status === "synthetic-policy-pass" &&
      positive.response?.syntheticFacts === true &&
      positive.response?.nativeSecurityExecuted === false &&
      positive.response?.peerFrameReachable === false,
  );
  check(
    positiveChecks,
    "synthetic positive accepted by policy",
    positive.response?.decision?.accepted === true,
  );
  check(
    positiveChecks,
    "synthetic positive never grants",
    safetyMatches(positive.response) && positive.response?.helperAuthorization === "blocked",
  );
  mark(positive, positiveChecks);

  const expectedReasons = {
    "synthetic-wrong-bundle": "identifier-mismatch",
    "synthetic-wrong-leaf": "leaf-sha256-mismatch",
    "synthetic-wrong-dr": "designated-requirement-mismatch",
    "synthetic-requirement-failed": "code-requirement-not-matched",
    "synthetic-adhoc": "ad-hoc-signature",
    "synthetic-missing-cert": "missing-certificate",
  };
  for (const [id, reason] of Object.entries(expectedReasons)) {
    const scenario = find(id);
    const checks = [];
    check(
      checks,
      `${id} rejected`,
      scenario.response?.status === "reject" &&
        scenario.response?.decision?.accepted === false &&
        scenario.response?.decision?.reason === reason,
      { expected: reason, actual: scenario.response?.decision?.reason },
    );
    check(checks, `${id} keeps capability off`, safetyMatches(scenario.response));
    mark(scenario, checks);
  }

  const existingChecks = [];
  check(
    existingChecks,
    "existing socket retained",
    existingSocket.exitCode === 1 &&
      existingSocket.retained === true &&
      String(existingSocket.response?.reason).includes("socket path already exists"),
  );
  mark(existingSocket, existingChecks);

  const replacementChecks = [];
  check(
    replacementChecks,
    "replacement socket retained",
    replacement.exitCode === 0 &&
      replacement.retained === true &&
      replacement.clientCleanedReplacement === true,
  );
  mark(replacement, replacementChecks);

  const partialChecks = [];
  check(
    partialChecks,
    "partial frame deadline fails closed",
    partial.exitCode === 1 &&
      partial.response?.status === "error" &&
      String(partial.response?.reason).includes("deadline exceeded"),
  );
  mark(partial, partialChecks);

  const profileGuardExpectations = {
    "profile-world-writable": "writable",
    "profile-schema-boolean": "schemaVersion",
    "profile-schema-fractional": "schemaVersion",
  };
  for (const [id, expectedError] of Object.entries(profileGuardExpectations)) {
    const scenario = find(id);
    const checks = [];
    const errors = scenario.response?.errors ?? [];
    check(
      checks,
      `${id} rejected by the native profile loader`,
      scenario.exitCode === 2 &&
        scenario.response?.status === "blocked" &&
        scenario.response?.reason === "pure-policy-input-invalid" &&
        errors.some((entry) => String(entry).includes(expectedError)),
      { expectedError, errors },
    );
    check(checks, `${id} keeps capability off`, safetyMatches(scenario.response));
    mark(scenario, checks);
  }

  const failing = scenarios
    .filter((scenario) => scenario.status !== "pass")
    .map((scenario) => scenario.id);
  return {
    failing,
    evidence: {
      trueUnixPeerCapture: real.status === "pass",
      realSecurityRejection: real.status === "pass",
      syntheticPolicyPositive: positive.status === "pass",
      positiveSignedHelper: "blocked",
      staticArtifactChecks:
        real.response.staticArtifact?.allPerformed === true ? "performed" : "not-performed",
      socketRetention: existingSocket.status === "pass" && replacement.status === "pass",
      partialFrameDeadline: partial.status === "pass",
      asidPinned: false,
      pidVersionPinned: false,
      loginSessionInferred: false,
      parentRelationshipInferred: false,
    },
  };
}
