import { describe, expect, it } from "vitest";
import { runNativePeerDiagnosticSuite } from "../scripts/lib/cua-peer-diagnostic-run.mjs";

const SCENARIO_IDS = [
  "default-blocked",
  "real-peer-adhoc-rejected",
  "wrong-pid",
  "wrong-uid",
  "synthetic-policy-positive",
  "synthetic-wrong-bundle",
  "synthetic-wrong-leaf",
  "synthetic-wrong-dr",
  "synthetic-requirement-failed",
  "synthetic-adhoc",
  "synthetic-missing-cert",
  "profile-world-writable",
  "profile-schema-boolean",
  "profile-schema-fractional",
  "existing-socket-retained",
  "replaced-socket-retained",
  "partial-frame-timeout",
  "positive-signed-helper-blocked",
];

describe("macOS CUA R10 native peer diagnostic", () => {
  it("captures a real AF_UNIX audit token and rejects the ad-hoc peer via Security.framework", async () => {
    const report = await runNativePeerDiagnosticSuite({ writeReports: true });
    const nativeHost = process.platform === "darwin" && process.arch === "arm64";

    if (!nativeHost) {
      expect(report.status).toBe("blocked");
      expect(report.reason).toMatch(/darwin|arm64|macosx27\.0|SDK|toolchain/i);
      return;
    }

    expect(report.status).toBe("pass");
    expect(report.diagnosticOnly).toBe(true);
    expect(report.grant).toBe(false);
    expect(report.nativeCapabilityProven).toBe(false);
    expect(report.runtimeConsumable).toBe(false);
    expect(report.productHook).toBe(false);
    expect(report.evidence).toMatchObject({
      trueUnixPeerCapture: true,
      realSecurityRejection: true,
      syntheticPolicyPositive: true,
      positiveSignedHelper: "blocked",
    });

    expect(report.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual(
      expect.arrayContaining(SCENARIO_IDS),
    );

    const real = report.scenarios.find(
      (scenario: { id: string }) => scenario.id === "real-peer-adhoc-rejected",
    );
    expect(real.response.peer.auditTokenCaptured).toBe(true);
    expect(real.response.peer.usesPidFallback).toBe(false);
    expect(real.response.peer.pidObserved).toBe(real.expected.pid);
    expect(real.response.peer.euidObserved).toBe(real.expected.uid);
    expect(typeof real.response.peer.asidObserved).toBe("number");
    expect(typeof real.response.peer.pidVersionObserved).toBe("number");
    expect(real.response.peer.asidMatched).toBe("not-pinned");
    expect(real.response.peer.pidVersionMatched).toBe("not-pinned");
    expect(real.response.peer.loginSessionInferred).toBe(false);
    expect(real.response.peer.parentRelationshipInferred).toBe(false);
    expect(real.response.security.guestAttribute).toBe("kSecGuestAttributeAudit");
    expect(real.response.security.usesPidFallback).toBe(false);
    expect(real.response.security.guestCreated).toBe(true);
    expect(real.response.security.adhoc).toBe(true);
    expect(real.response.security.certificateCount).toBe(0);
    expect(real.response.decision.accepted).toBe(false);
    expect(["ad-hoc-signature", "missing-certificate"]).toContain(real.response.decision.reason);
    expect(real.response.staticArtifact.matched).toBe(true);
    expect(real.response.helperAuthorization).toBe("blocked");

    const positive = report.scenarios.find(
      (scenario: { id: string }) => scenario.id === "synthetic-policy-positive",
    );
    expect(positive.response.status).toBe("synthetic-policy-pass");
    expect(positive.response.syntheticFacts).toBe(true);
    expect(positive.response.nativeSecurityExecuted).toBe(false);
    expect(positive.response.decision.accepted).toBe(true);
    expect(positive.response.grant).toBe(false);
    expect(positive.response.nativeCapabilityProven).toBe(false);
    expect(positive.response.helperAuthorization).toBe("blocked");
    expect(positive.response.runtimeConsumable).toBe(false);

    for (const id of SCENARIO_IDS.filter(
      (entry) => entry.startsWith("synthetic-") && entry !== "synthetic-policy-positive",
    )) {
      const scenario = report.scenarios.find((entry: { id: string }) => entry.id === id);
      expect(scenario.response.decision.accepted).toBe(false);
      expect(scenario.response.status).toBe("reject");
    }

    expect(report.calibration).toBeTruthy();
    expect(report.calibration.mechanism).toBe(
      "node-signature-lower-layer-control-not-local-self-signed-helper",
    );
    expect(report.calibration.attestsLoadedJs).toBe(false);
    expect(report.calibration.status).toBe("pass");
    const calibrationIds = report.calibration.scenarios.map(
      (scenario: { id: string }) => scenario.id,
    );
    expect(calibrationIds).toEqual([
      "node-signature-lower-layer-positive",
      "node-signature-wrong-pin-negative",
    ]);
    const positiveControl = report.calibration.scenarios[0].response;
    expect(positiveControl.calibrationOnly).toBe(true);
    expect(positiveControl.nodeSignatureMechanismControl).toBe(true);
    expect(positiveControl.localSelfSignedHelperAcceptance).toBe(false);
    expect(positiveControl.attestsLoadedJs).toBe(false);
    expect(positiveControl.decision.accepted).toBe(false);
    expect(positiveControl.lowerLayerSecurityControl.guestCreated).toBe(true);
    expect(positiveControl.lowerLayerSecurityControl.codeValid).toBe(true);
    expect(positiveControl.lowerLayerSecurityControl.leafRequirementMatched).toBe(true);
    expect(positiveControl.strictLocalSelfSignedDr.storedStrictlyMatched).toBe(false);
    const negativeControl = report.calibration.scenarios[1].response;
    expect(negativeControl.decision.accepted).toBe(false);
    expect(negativeControl.decision.reason).toBe("leaf-sha256-mismatch");
  }, 300_000);
});
