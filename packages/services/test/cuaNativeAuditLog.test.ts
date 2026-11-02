import { describe, expect, it } from "vitest";
import { parseCuaNativeAuditLine } from "../src/zcode-agent/cuaNativeAuditLog.js";

const NODE_IDENTIFIER = "io.github.zclaudia.zody.cua-helper.node";
const NODE_CDHASH = "3c57a9bb9f4e8b748ac80d60bc78cdde14767218";
const PNG_SHA256 = "e1bca9e1d32237e21bb07ad1e8655268fbab04557d87d330c14112ed062d523e";

const confirmationReasons = [
  "user-approved",
  "user-canceled",
  "owner-invalidated",
  "authority-eof",
  "confirmation-stale",
  "shutdown",
  "relay-liveness-error",
  "relay-eof",
  "signal",
  "supervisor-destroyed",
  "app-confirm-failed",
] as const;

const captureReasons = [
  "connection-failed",
  "entry-clean-exit",
  "entry-fatal",
  "entry-stopped",
  "session-stopping",
  "confirmation-unavailable",
  "confirmation-denied",
  "user-canceled",
  "confirmation-invalidated",
  "confirmation-canceled",
  "peer-auth-failed",
  "peer-pid-mismatch",
  "node-loaded-code-mismatch",
  "authority-transport-failed",
  "bootstrap-failed",
  "binding-invalid",
  "window-target-invalid",
  "machine-lease-unavailable",
  "capture-file-name-unavailable",
  "capture-file-verify-failed",
  "capture-canceled",
  "capture-result-not-accepted",
  "capture-result-transport-failed",
  "machine-lease-release-unconfirmed",
  "final-owner-check-failed",
  "post-confirm-check-failed",
  "authority-buffer-not-empty",
  "authority-fd-mode-failed",
  "machine-lease-not-held",
  "capture-context-incomplete",
  "tcc-not-authorized",
  "visual-start-denied",
  "visual-take-png-failed",
  "visual-png-invalid",
  "visual-wait-failed",
  "visual-resources-not-released",
  "visual-destroy-pending",
  "visual-staticlib-missing",
  "capture-facts-missing",
  "authority-revoke-failed",
  "authority-revoke-not-confirmed",
  "capture-create-failed",
  "capture-write-failed",
  "capture-fsync-failed",
  "capture-failed",
  "visual-failed",
  "tcc-failed",
  "capture-context-failed",
  "peer-rejected",
  "control-failed",
  "transport-closed",
  "authority-failed",
  "unexpected-control-frame",
] as const;

const acceptedMarkers = [
  '[cua-native] confirmation-presented {"generation":1}',
  '[cua-native] confirmation-resolved {"generation":1,"allowed":true,"reason":"user-approved"}',
  '[cua-native] cell-spawned {"pid":83436,"suspended":true}',
  `[cua-native] cell-loaded-code {"pid":83436,"verified":true,"identifier":"${NODE_IDENTIFIER}","cdhash":"${NODE_CDHASH}","entitlementsEmpty":true}`,
  '[cua-native] cell-resumed {"pid":83436}',
  '[cua-native] cell-source-sent {"pid":83436,"bytes":26843545}',
  `[cua-native] cell-peer-verified {"pid":83436,"identifier":"${NODE_IDENTIFIER}","cdhash":"${NODE_CDHASH}","entitlementsEmpty":true}`,
  '[cua-native] cell-reaped {"pid":83436,"confirmed":true,"exitCode":0,"signal":null}',
  "[cua-native] machine-lease-acquired",
  '[cua-native] machine-lease-released {"confirmed":true}',
  `[cua-native] capture-delivered {"sha256":"${PNG_SHA256}","width":1440,"height":900,"bytes":108925,"resourcesReleased":true,"machineLeaseReleased":true}`,
  '[cua-native] capture-rejected {"reason":"connection-failed"}',
  '[cua-native] visual-completion-held {"captureErrorPresent":false,"hasImage":true,"requestId":7}',
  '[cua-native] visual-submit-return {"requestId":7,"targetMatches":true}',
  '[cua-native] visual-stop-gate-release {"completionConsumed":false,"gateResult":"stopped","heldCompletionDiscarded":true,"requestId":7}',
  '[cua-native] visual-stop-gate-timeout {"gateResult":"deadline-timeout","heldCompletionDiscarded":true,"requestId":7,"timeoutMs":30000}',
  '[cua-native] visual-stop-gate-error {"gateResult":"missing-operation","heldCompletionDiscarded":true,"requestId":7}',
] as const;

describe("parseCuaNativeAuditLine", () => {
  it.each(acceptedMarkers)("accepts and preserves the exact native line: %s", (line) => {
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  });

  it.each(confirmationReasons)("accepts the fixed confirmation reason %s", (reason) => {
    const allowed = reason === "user-approved";
    const line = `[cua-native] confirmation-resolved {"generation":2,"allowed":${allowed},"reason":"${reason}"}`;
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  });

  it("rejects app-confirm-failed with allowed:true because the consistency check must fail closed", () => {
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] confirmation-resolved {"generation":2,"allowed":true,"reason":"app-confirm-failed"}',
      ),
    ).toBeUndefined();
  });

  it("still rejects unknown confirmation reasons", () => {
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] confirmation-resolved {"generation":2,"allowed":false,"reason":"cli-dynamic-detail"}',
      ),
    ).toBeUndefined();
  });

  it.each(captureReasons)("accepts the fixed capture reason %s", (reason) => {
    const line = `[cua-native] capture-rejected {"reason":"${reason}"}`;
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  });

  it("reconstructs canonical field order instead of forwarding raw JSON", () => {
    expect(
      parseCuaNativeAuditLine('[cua-native] cell-spawned {"suspended":true,"pid":83436}'),
    ).toBe('[cua-native] cell-spawned {"pid":83436,"suspended":true}');
  });

  it("rejects unknown markers, malformed JSON, payloads on payload-free markers, and extra fields", () => {
    expect(parseCuaNativeAuditLine('[cua-native] unknown {"pid":1}')).toBeUndefined();
    expect(parseCuaNativeAuditLine('[cua-native] constructor {"pid":1}')).toBeUndefined();
    expect(parseCuaNativeAuditLine("[cua-native] cell-resumed {not-json}")).toBeUndefined();
    expect(parseCuaNativeAuditLine("[cua-native] machine-lease-acquired {}")).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] cell-spawned {"pid":1,"suspended":true,"secret":"raw-secret"}',
      ),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] visual-completion-held {"captureErrorPresent":false,"hasImage":true,"requestId":1,"secret":"raw-secret"}',
      ),
    ).toBeUndefined();
  });

  it("rejects invalid types, enum values, hashes, control characters, and oversize lines", () => {
    expect(parseCuaNativeAuditLine('[cua-native] cell-resumed {"pid":"83436"}')).toBeUndefined();
    expect(
      parseCuaNativeAuditLine('[cua-native] cell-source-sent {"pid":1,"bytes":-1}'),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine('[cua-native] cell-spawned {"pid":1,"suspended":1}'),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine('[cua-native] capture-rejected {"reason":"dynamic detail"}'),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] confirmation-resolved {"generation":1,"allowed":true,"reason":"user-approved","extra":true}',
      ),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        `[cua-native] cell-peer-verified {"pid":1,"identifier":"${NODE_IDENTIFIER}","cdhash":"abc","entitlementsEmpty":true}`,
      ),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        `[cua-native] capture-delivered {"sha256":"${"A".repeat(64)}","width":1,"height":1,"bytes":1,"resourcesReleased":true,"machineLeaseReleased":true}`,
      ),
    ).toBeUndefined();
    expect(parseCuaNativeAuditLine('[cua-native] cell-resumed {"pid":1}\u0007')).toBeUndefined();
    expect(parseCuaNativeAuditLine(`${acceptedMarkers[3]}${"x".repeat(5000)}`)).toBeUndefined();
  });

  it("requires successful cell verification to use the pinned identifier, hash, and empty entitlements", () => {
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] cell-loaded-code {"pid":1,"verified":true,"identifier":"","cdhash":"","entitlementsEmpty":false}',
      ),
    ).toBeUndefined();
    expect(
      parseCuaNativeAuditLine(
        `[cua-native] cell-loaded-code {"pid":1,"verified":true,"identifier":"${NODE_IDENTIFIER}","cdhash":"${NODE_CDHASH}","entitlementsEmpty":false}`,
      ),
    ).toBeUndefined();
  });
});
