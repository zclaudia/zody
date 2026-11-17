import { describe, expect, it } from "vitest";
import { parseCuaNativeAuditLine } from "../src/zody-agent/cuaNativeAuditLog.js";

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
  '[cua-native] observation-rejected {"phase":"ax_windows_status","code":"element_unavailable","ax":"cannot_complete"}',
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

  it("keeps verified peer output in schema order", () => {
    const raw = `[cua-native] cell-peer-verified ${JSON.stringify({ entitlementsEmpty: true, cdhash: NODE_CDHASH, identifier: NODE_IDENTIFIER, pid: 1 })}`;
    expect(parseCuaNativeAuditLine(raw)).toBe(
      `[cua-native] cell-peer-verified ${JSON.stringify({ pid: 1, identifier: NODE_IDENTIFIER, cdhash: NODE_CDHASH, entitlementsEmpty: true })}`,
    );
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

describe("native observation rejection audit", () => {
  it("accepts the exact native JSON event and reconstructs field order", () => {
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] observation-rejected {"phase":"node_ax_window","code":"element_unavailable","ax":"success"}',
      ),
    ).toBe(
      '[cua-native] observation-rejected {"phase":"node_ax_window","code":"element_unavailable","ax":"success"}',
    );
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] observation-rejected {"ax":"unknown","code":"unknown","phase":"unknown"}',
      ),
    ).toBe('[cua-native] observation-rejected {"phase":"unknown","code":"unknown","ax":"unknown"}');
  });
  it.each([
    '{"phase":"private title","code":"element_unavailable","ax":"success"}',
    '{"phase":"read","code":"private error","ax":"success"}',
    '{"phase":"read","code":"element_unavailable","ax":"private AX description"}',
    '{"phase":"read","code":"element_unavailable","ax":"success","secret":"private"}',
    '{"phase":"read","code":"element_unavailable"}',
    '{"phase":"read","code":1,"ax":"success"}',
    "not-json",
  ])("rejects unbounded or malformed payload: %s", (payload) => {
    expect(parseCuaNativeAuditLine(`[cua-native] observation-rejected ${payload}`)).toBeUndefined();
  });
});

it.each([
  "ax_app_create",
  "ax_windows_status",
  "ax_windows_missing",
  "ax_windows_type",
  "ax_unique",
  "eligible",
  "node_pid",
  "node_direct_window",
  "node_ax_window",
  "node_role",
  "launch_date",
  "cg_windows",
  "cg_unique",
  "bounds",
  "resolve_before",
  "read",
  "resolve_after",
  "final_resolve",
  "read_resolve_before",
  "read_resolve_after",
  "metadata_cg_windows",
  "unknown",
])("accepts native observation phase %s", (phase) => {
  const line = `[cua-native] observation-rejected ${JSON.stringify({ phase, code: "element_unavailable", ax: "success" })}`;
  expect(parseCuaNativeAuditLine(line)).toBe(line);
});
it.each([
  "element_unavailable",
  "invalid_request",
  "broker_unavailable",
  "permission_denied",
  "not_authorized",
  "screen_locked",
  "stale_state",
  "structured_state_unavailable",
  "timeout",
  "unknown",
])("accepts native observation code %s", (code) => {
  const line = `[cua-native] observation-rejected ${JSON.stringify({ phase: "read", code, ax: "success" })}`;
  expect(parseCuaNativeAuditLine(line)).toBe(line);
});
it.each([
  "success",
  "failure",
  "illegal_argument",
  "invalid_element",
  "cannot_complete",
  "attribute_unsupported",
  "no_value",
  "not_implemented",
  "unknown",
])("accepts native AX status %s", (ax) => {
  const line = `[cua-native] observation-rejected ${JSON.stringify({ phase: "read", code: "element_unavailable", ax })}`;
  expect(parseCuaNativeAuditLine(line)).toBe(line);
});

it("接受原生零窗口 ID 的固定审计阶段", () => {
  const line =
    '[cua-native] observation-rejected {"phase":"node_direct_window_zero","code":"element_unavailable","ax":"success"}';
  expect(parseCuaNativeAuditLine(line)).toBe(line);
});

describe("native observation window conflict audit", () => {
  it("accepts and canonically reconstructs the fixed conflict facts", () => {
    const expected =
      '[cua-native] observation-window-conflict {"atRoot":false,"role":"text","direct":"same_process","axWindow":"target","axWindowIsTargetReference":true}';
    expect(parseCuaNativeAuditLine(expected)).toBe(expected);
    expect(
      parseCuaNativeAuditLine(
        '[cua-native] observation-window-conflict {"axWindowIsTargetReference":true,"direct":"same_process","axWindow":"target","role":"text","atRoot":false}',
      ),
    ).toBe(expected);
  });
  it.each([
    '{"atRoot":false,"role":"private title","direct":"target","axWindow":"target","axWindowIsTargetReference":true}',
    '{"atRoot":false,"role":"text","direct":"123","axWindow":"target","axWindowIsTargetReference":true}',
    '{"atRoot":false,"role":"text","direct":"target","axWindow":"123","axWindowIsTargetReference":true}',
    '{"atRoot":false,"role":"text","direct":"target","axWindow":"target","axWindowIsTargetReference":true,"windowId":123}',
    '{"atRoot":0,"role":"text","direct":"target","axWindow":"target","axWindowIsTargetReference":true}',
    '{"atRoot":false,"role":"text","direct":"target","axWindow":"target"}',
  ])("rejects non-contract fields and values: %s", (payload) => {
    expect(
      parseCuaNativeAuditLine(`[cua-native] observation-window-conflict ${payload}`),
    ).toBeUndefined();
  });
});

it.each(["window", "button", "text", "group", "other", "unknown"])(
  "accepts bounded conflict role %s",
  (role) => {
    const line = `[cua-native] observation-window-conflict ${JSON.stringify({ atRoot: true, role, direct: "unknown", axWindow: "unknown", axWindowIsTargetReference: false })}`;
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  },
);
it.each(["target", "same_process", "other_process", "missing", "unknown"])(
  "accepts bounded conflict direct %s",
  (direct) => {
    const line = `[cua-native] observation-window-conflict ${JSON.stringify({ atRoot: false, role: "unknown", direct, axWindow: "unknown", axWindowIsTargetReference: false })}`;
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  },
);
it.each(["target", "direct", "other", "missing", "invalid", "unknown"])(
  "accepts bounded conflict AX window %s",
  (axWindow) => {
    const line = `[cua-native] observation-window-conflict ${JSON.stringify({ atRoot: false, role: "unknown", direct: "unknown", axWindow, axWindowIsTargetReference: false })}`;
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  },
);

describe("opaque AppKit system view omission audit", () => {
  it("accepts only the fixed no-content omission record", () => {
    const line =
      '[cua-native] observation-system-view-omitted {"reason":"appkit_theme_widget_remote_view"}';
    expect(parseCuaNativeAuditLine(line)).toBe(line);
  });
  it.each([
    { reason: "other" },
    { reason: "appkit_theme_widget_remote_view", title: "REMOTE_SECRET" },
    { reason: "appkit_theme_widget_remote_view", windowId: 99 },
    { reason: "appkit_theme_widget_remote_view", index: 0 },
  ])("rejects arbitrary reason, content, identity or handle: %s", (payload) => {
    expect(
      parseCuaNativeAuditLine(
        `[cua-native] observation-system-view-omitted ${JSON.stringify(payload)}`,
      ),
    ).toBeUndefined();
  });
});

describe("native control dispatch audit", () => {
  it.each([
    ["rejected", "not_sent"],
    ["admitted", "possibly_sent"],
    ["completed", "sent"],
    ["completed", "possibly_sent"],
  ])("accepts and rebuilds bounded %s/%s facts", (event, dispatch_status) => {
    const input = `[cua-control] ${JSON.stringify({ dispatch_status, scope: "0123456789abcdef", attempt: 5, event })}`;
    const expected = `[cua-control] ${JSON.stringify({ event, attempt: 5, scope: "0123456789abcdef", dispatch_status })}`;
    expect(parseCuaNativeAuditLine(input)).toBe(expected);
  });
  it.each([
    { event: "rejected", attempt: 1, scope: "0123456789abcdef", dispatch_status: "sent" },
    { event: "admitted", attempt: 1, scope: "0123456789abcdef", dispatch_status: "not_sent" },
    { event: "completed", attempt: 1, scope: "0123456789abcdef", dispatch_status: "not_sent" },
    { event: "completed", attempt: 0, scope: "0123456789abcdef", dispatch_status: "sent" },
    {
      event: "completed",
      attempt: Number.MAX_SAFE_INTEGER + 1,
      scope: "0123456789abcdef",
      dispatch_status: "sent",
    },
    { event: "completed", attempt: 1, scope: "invalid", dispatch_status: "sent" },
    {
      event: "completed",
      attempt: 1,
      scope: "0123456789abcdef",
      dispatch_status: "sent",
      title: "private",
    },
  ])("rejects inconsistent or unbounded facts: %s", (payload) => {
    expect(parseCuaNativeAuditLine(`[cua-control] ${JSON.stringify(payload)}`)).toBeUndefined();
  });
});

it("records a borrowed screenshot lease without claiming the machine lock was released", () => {
  const line = `[cua-native] capture-delivered ${JSON.stringify({ sha256: PNG_SHA256, width: 1440, height: 900, bytes: 108925, resourcesReleased: true, machineLeaseReleased: false, machineLeaseBorrowReturned: true })}`;
  expect(parseCuaNativeAuditLine(line)).toBe(line);
  expect(
    parseCuaNativeAuditLine(
      line.replace('"machineLeaseReleased":false', '"machineLeaseReleased":true'),
    ),
  ).toBeUndefined();
  expect(
    parseCuaNativeAuditLine(line.replace(',"machineLeaseBorrowReturned":true', "")),
  ).toBeUndefined();
  expect(
    parseCuaNativeAuditLine(
      line.replace('"machineLeaseBorrowReturned":true', '"machineLeaseBorrowReturned":false'),
    ),
  ).toBeUndefined();
});
