import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  OUTPUT_ROOT,
  PeerDiagnosticBlockedError,
  PeerDiagnosticFailureError,
  TEST_REPORT_KIND,
  diagnosticSafetyFields,
  ensureOwnedDirectory,
  nowIso,
  writeJsonAtomic,
} from "./cua-peer-diagnostic-core.mjs";
import { buildNativePeerDiagnostic } from "./cua-peer-diagnostic-build.mjs";
import { assertScenarios } from "./cua-peer-diagnostic-assertions.mjs";
import { loadPinnedProfile, syntheticProfileForBinary } from "./cua-peer-diagnostic-profile.mjs";
import { runCalibrationControl } from "./cua-peer-diagnostic-calibration.mjs";
import {
  fixtureJson,
  makeWorkdir,
  runDefaultBlocked,
  runExistingSocketScenario,
  runPartialFrameScenario,
  runPeerScenario,
  runPolicyScenario,
  runReplacementScenario,
  writeFixtureObject,
} from "./cua-peer-diagnostic-scenarios.mjs";

async function blockedReport(outputRoot, writeReports, reason, details) {
  const report = {
    schemaVersion: 1,
    kind: TEST_REPORT_KIND,
    generatedAt: nowIso(),
    ...diagnosticSafetyFields(),
    status: "blocked",
    reason,
    details: details ?? null,
    scenarios: [],
    evidence: {
      trueUnixPeerCapture: false,
      realSecurityRejection: false,
      syntheticPolicyPositive: false,
      positiveSignedHelper: "blocked",
      nodeSignatureControl: "blocked",
    },
  };
  if (writeReports) {
    await ensureOwnedDirectory(join(outputRoot, "reports"));
    await writeJsonAtomic(join(outputRoot, "reports", "test-report.json"), report, 0o600);
  }
  return report;
}

async function calibrationResult(binary) {
  try {
    return await runCalibrationControl({ binary });
  } catch (error) {
    return {
      status: "blocked",
      reason: "calibration-exception",
      mechanism: "node-signature-lower-layer-control-not-local-self-signed-helper",
      attestsLoadedJs: false,
      scenarios: [],
      details: {
        message: error?.message ?? String(error),
        stack: String(error?.stack ?? "").slice(0, 4_000),
        ...(error instanceof PeerDiagnosticFailureError ? error.details : {}),
      },
    };
  }
}

export async function runNativePeerDiagnosticSuite({
  outputRoot = OUTPUT_ROOT,
  writeReports = true,
} = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return blockedReport(outputRoot, writeReports, "native peer diagnostic requires darwin arm64");
  }

  let build;
  try {
    build = await buildNativePeerDiagnostic({ outputRoot });
  } catch (error) {
    const report = await blockedReport(
      outputRoot,
      writeReports,
      error.message,
      error instanceof PeerDiagnosticBlockedError
        ? { code: error.code, ...error.details }
        : error.details,
    );
    if (error instanceof PeerDiagnosticBlockedError) {
      return report;
    }
    throw error;
  }

  const runRoot = await makeWorkdir("zody-cua-peer-r10-run-");
  try {
    const syntheticProfile = syntheticProfileForBinary(build.sha256);
    const profilePath = await writeFixtureObject(
      runRoot,
      "profile.synthetic.json",
      syntheticProfile,
    );
    const loaded = await loadPinnedProfile(profilePath);
    if (!loaded.ok) {
      throw new PeerDiagnosticFailureError("synthetic test profile failed strict validation", {
        code: loaded.code,
        errors: loaded.errors,
        policyErrors: loaded.policyErrors,
      });
    }

    const facts = {};
    for (const name of [
      "synthetic-positive",
      "wrong-bundle",
      "wrong-leaf",
      "wrong-dr",
      "requirement-failed",
      "adhoc",
      "missing-cert",
    ]) {
      facts[name] = await writeFixtureObject(
        runRoot,
        `facts.${name}.json`,
        await fixtureJson(`facts.${name}.json`),
      );
    }

    const scenarios = [];
    const baseline = await runPeerScenario({
      binary: build.artifactPath,
      profilePath,
      id: "real-peer-adhoc-rejected",
    });
    scenarios.push(baseline);
    const wrongPid = await runPeerScenario({
      binary: build.artifactPath,
      profilePath,
      id: "wrong-pid",
      pidOffset: 1,
    });
    const wrongUid = await runPeerScenario({
      binary: build.artifactPath,
      profilePath,
      id: "wrong-uid",
      uidOffset: 1,
    });
    scenarios.push(wrongPid, wrongUid);
    scenarios.push(await runDefaultBlocked({ binary: build.artifactPath }));
    for (const [id, factsName] of [
      ["synthetic-policy-positive", "synthetic-positive"],
      ["synthetic-wrong-bundle", "wrong-bundle"],
      ["synthetic-wrong-leaf", "wrong-leaf"],
      ["synthetic-wrong-dr", "wrong-dr"],
      ["synthetic-requirement-failed", "requirement-failed"],
      ["synthetic-adhoc", "adhoc"],
      ["synthetic-missing-cert", "missing-cert"],
    ]) {
      scenarios.push(
        await runPolicyScenario({
          binary: build.artifactPath,
          profilePath,
          factsPath: facts[factsName],
          id,
        }),
      );
    }

    const worldWritablePath = await writeFixtureObject(
      runRoot,
      "profile.world-writable.json",
      syntheticProfile,
    );
    await chmod(worldWritablePath, 0o666);
    const guardProfiles = [
      ["profile-world-writable", worldWritablePath],
      [
        "profile-schema-boolean",
        await writeFixtureObject(runRoot, "profile.schema-boolean.json", {
          ...syntheticProfile,
          schemaVersion: true,
        }),
      ],
      [
        "profile-schema-fractional",
        await writeFixtureObject(runRoot, "profile.schema-fractional.json", {
          ...syntheticProfile,
          schemaVersion: 1.5,
        }),
      ],
    ];
    for (const [id, guardPath] of guardProfiles) {
      scenarios.push(
        await runPolicyScenario({
          binary: build.artifactPath,
          profilePath: guardPath,
          factsPath: facts["synthetic-positive"],
          id,
        }),
      );
    }

    const existingSocket = await runExistingSocketScenario({
      binary: build.artifactPath,
      profilePath,
    });
    const replacement = await runReplacementScenario({ binary: build.artifactPath, profilePath });
    const partial = await runPartialFrameScenario({ binary: build.artifactPath, profilePath });
    scenarios.push(existingSocket, replacement, partial);

    const invalidProfile = await loadPinnedProfile(
      join(
        import.meta.dirname,
        "../../test/fixtures/macosCuaPeerDiagnostic/profile.invalid-dr.json",
      ),
    );
    scenarios.push({
      id: "invalid-profile",
      kind: "js-preflight",
      status: invalidProfile.ok ? "fail" : "pass",
      response: {
        status: invalidProfile.ok ? "unexpected-pass" : "blocked",
        code: invalidProfile.code,
        policyErrors: invalidProfile.policyErrors,
        ...diagnosticSafetyFields(),
      },
    });
    scenarios.push({
      id: "positive-signed-helper-blocked",
      kind: "blocked-not-tested",
      status: "pass",
      response: {
        status: "blocked",
        reason:
          "no certificate-backed local-self-signed Helper fixture is provided; no signing or keychain action was performed",
        tested: false,
        ...diagnosticSafetyFields(),
      },
    });

    const calibration = await calibrationResult(build.artifactPath);
    const verdict = assertScenarios(scenarios);
    const failing = verdict.failing;
    const report = {
      schemaVersion: 1,
      kind: TEST_REPORT_KIND,
      generatedAt: nowIso(),
      ...diagnosticSafetyFields(),
      status: failing.length === 0 ? "pass" : "fail",
      build: {
        command: build.commands.compile,
        artifactPath: build.artifactPath,
        artifactSha256: build.sha256,
        sdk: build.manifest.build.sdk,
        compiler: build.manifest.build.compiler,
        target: build.manifest.build.target,
        sources: build.manifest.sources,
        linkerAdhocProbeOnly: true,
        signedForAcceptance: false,
      },
      profile: {
        sha256: loaded.profileSha256,
        syntheticShapeOnly: true,
        executableSha256PinnedToBuiltProbe: true,
      },
      scenarios,
      calibration,
      calibrationScenarios: calibration.scenarios ?? [],
      evidence: {
        ...verdict.evidence,
        nodeSignatureControl: calibration.status,
        nodeLoadedJsAttested: false,
      },
      checkedScope: [
        "own AF_UNIX listener and own test client",
        "getsockopt(LOCAL_PEERTOKEN) full audit token, including asid and pidversion",
        "SecCodeCopyGuestWithAttributes(kSecGuestAttributeAudit), no PID fallback",
        "SecCodeCheckValidity plus explicit narrow requirement success",
        "leaf DER SHA-256, signing identifier and strict designated requirement",
        "actual static executable SHA-256, entitlements, architecture and minimum macOS",
        "owned inode/device socket cleanup and bounded partial-frame deadline",
        "Node signature mechanism as a calibration-only lower-layer control",
      ],
      notPerformed: [
        "positive local-self-signed Helper",
        "TCC authorization",
        "machine lease",
        "native input or screenshots",
        "product runtime consumption of diagnostic JSON",
        "bundle ShortVersion/Version/executableName cross-checks",
        "full 12-field static doctor",
        "Node loaded-JavaScript attestation",
      ],
      failingScenarios: failing,
      reportPath: join(outputRoot, "reports", "test-report.json"),
    };
    if (writeReports) {
      await ensureOwnedDirectory(join(outputRoot, "reports"));
      await writeJsonAtomic(join(outputRoot, "reports", "test-report.json"), report, 0o600);
    }
    if (failing.length > 0) {
      throw new PeerDiagnosticFailureError("native peer diagnostic scenarios failed", {
        failing,
        report,
      });
    }
    return report;
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}
