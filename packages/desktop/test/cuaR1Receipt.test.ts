import { parseCuaV4SessionPhase } from "./e2e/helpers/cua-v4-session-phase.js";
import { describe, expect, it } from "vitest";
import {
  identifyR1FixtureProfile,
  inspectR1LifecycleFailure,
  r1LifecycleOrder,
  r1NoStoppedContinuation,
  r1IdentityMatches,
  parseR1IdentityRows,
  validateR1FreshFixture,
  snapshotR1Fixture,
  safeReceipt,
  inspectStateToolResult,
  projectR1NetworkStats,
} from "./e2e/helpers/cua-r1-receipt.js";

describe("R1 state receipt", () => {
  it("保留五次状态的安全布尔事实而不保留正文", () => {
    const expectedModes = ["full", "diff", "full", "full", "diff"];
    const content =
      expectedModes
        .map(
          (mode, index) =>
            `R1_DIAG:${JSON.stringify({ case: "state", index: index + 1, full: mode === "full", diff: mode === "diff", ok: true, targetSeen: mode === "full", siblingLeak: false, privateText: "DO_NOT_PERSIST" })}`,
        )
        .join("\n") + "\nE2E_R1_STATE_OK";
    const receipt = safeReceipt(
      { content, isError: false, toolCallId: "fixture" },
      { pid: 1, targetWindow: 2, siblingWindow: 3, targetMarker: "T", siblingMarker: "S" },
    );
    expect(receipt.marker).toBe("E2E_R1_STATE_OK");
    expect(receipt.diagnostics?.map((d) => [d.index, d.full, d.diff, d.ok])).toEqual(
      expectedModes.map((mode, index) => [index + 1, mode === "full", mode === "diff", true]),
    );
    expect(JSON.stringify(receipt)).not.toContain("DO_NOT_PERSIST");
  });
});

it("只根据实际 tool_result 判断每一阶段是否交付正确树，静默阶段不泄露正文", () => {
  const fixture = {
    pid: 1,
    targetWindow: 2,
    siblingWindow: 3,
    targetMarker: "TARGET_BODY",
    siblingMarker: "SIBLING_BODY",
  };
  const text = (content: string) => ({ content, isError: false, toolCallId: "call" });
  expect(
    inspectStateToolResult(text("AX window state\nTARGET_BODY\nE2E_R1_STATE_1_OK"), fixture, 1).ok,
  ).toBe(true);
  expect(inspectStateToolResult(text("AX window diff\nE2E_R1_STATE_2_OK"), fixture, 2).ok).toBe(
    true,
  );
  expect(
    inspectStateToolResult(
      text(
        'R1_DIAG:{"case":"state","index":3,"ok":true,"full":true,"targetSeen":true,"siblingLeak":false}\nE2E_R1_STATE_3_OK',
      ),
      fixture,
      3,
    ).ok,
  ).toBe(true);
  expect(
    inspectStateToolResult(text("R1_DIAG:{}\nTARGET_BODY\nE2E_R1_STATE_3_OK"), fixture, 3).ok,
  ).toBe(false);
  expect(
    inspectStateToolResult(
      text("AX window state\nTARGET_BODY\nSIBLING_BODY\nE2E_R1_STATE_4_OK"),
      fixture,
      4,
    ).ok,
  ).toBe(false);
});

it("失败观察保留安全错误码与状态诊断，不保留任意正文", () => {
  const fixture = {
    pid: 1,
    targetWindow: 2,
    siblingWindow: 3,
    targetMarker: "TARGET",
    siblingMarker: "SIBLING",
  };
  const content =
    'permission_denied R1_DIAG:{"case":"state","index":1,"result":{"type":"object","code":"permission_denied"},"full":false,"diff":false,"ok":false,"privateText":"DO_NOT_PERSIST"}';
  const receipt = inspectStateToolResult(
    { content, isError: true, toolCallId: "call" },
    fixture,
    1,
  );
  expect(receipt.codes).toEqual(["permission_denied"]);
  expect(receipt.diagnostics?.[0]?.result?.code).toBe("permission_denied");
  expect(JSON.stringify(receipt)).not.toContain("DO_NOT_PERSIST");
  expect(receipt.ok).toBe(false);
});

it("网络统计区分不可用与零请求，只保留安全计数", () => {
  expect(projectR1NetworkStats(undefined, "fixture-model")).toEqual({
    captureAvailable: false,
    requestCount: 0,
    expectedFixtureModelCount: 0,
    pendingCount: 0,
    completeCount: 0,
    errorCount: 0,
    http2xxCount: 0,
    http4xx5xxCount: 0,
  });
  expect(projectR1NetworkStats({ records: [] } as never, "fixture-model").captureAvailable).toBe(
    true,
  );
  const capture = {
    records: [
      {
        status: "pending",
        requestJson: { model: "fixture-model", secret: "SECRET_BODY" },
        url: "SECRET_URL",
        requestHeaders: { authorization: "SECRET_HEADER" },
      },
      { status: "complete", statusCode: 200, requestJson: { model: "fixture-model" } },
      { status: "error", statusCode: 503, requestJson: { model: "other" }, error: "SECRET_ERROR" },
    ],
  } as never;
  const stats = projectR1NetworkStats(capture, "fixture-model");
  expect(stats).toEqual({
    captureAvailable: true,
    requestCount: 3,
    expectedFixtureModelCount: 2,
    pendingCount: 1,
    completeCount: 1,
    errorCount: 1,
    http2xxCount: 1,
    http4xx5xxCount: 1,
  });
  expect(JSON.stringify(stats)).not.toMatch(/SECRET|fixture-model|other/);
});

it("夹具组合只接受已知标识且不泄露未知值", () => {
  expect(identifyR1FixtureProfile(undefined)).toEqual({
    kind: "default-appkit",
    caseId: "CUA-AX-R1-03a",
  });
  expect(identifyR1FixtureProfile("explicit-ax-content-v1")).toEqual({
    kind: "explicit-ax-content-v1",
    caseId: "CUA-AX-R1-03b",
  });
  expect(() => identifyR1FixtureProfile("SECRET_UNKNOWN_KIND")).toThrow(
    "Unsupported R1 fixture profile",
  );
  try {
    identifyR1FixtureProfile("SECRET_UNKNOWN_KIND");
  } catch (error) {
    expect(String(error)).not.toContain("SECRET_UNKNOWN_KIND");
  }
  expect(() => identifyR1FixtureProfile(null)).toThrow();
});

it("生命周期仅接受真实错误投影和正常 cell 完成的精确证据", () => {
  const fixture = {
    pid: 1,
    targetWindow: 2,
    siblingWindow: 3,
    targetMarker: "TARGET_BODY",
    siblingMarker: "SIBLING_BODY",
  };
  const native = (code = "element_unavailable") =>
    JSON.stringify({
      code,
      message: "Computer use observation failed",
      action_sent: false,
      dispatch_status: "not_sent",
    });
  const diag = (stage = 2, code = "element_unavailable", outcome = "returned") =>
    "R1_LIFECYCLE:" +
    JSON.stringify({
      kind: "window_rejected",
      stage,
      resultType: "object",
      code,
      ok: true,
      outcome,
    });
  const text = (n = native(), d = diag(), done = "R1_LIFECYCLE_DONE:2") =>
    ["MCP tool returned an error:", n, d, done].join("\n");
  const result = (content: string, isError = true) => ({ content, isError, toolCallId: "x" });
  expect(inspectR1LifecycleFailure(result(text()), fixture, 2).ok).toBe(true);
  expect(inspectR1LifecycleFailure(result(text()), fixture, 2)).toMatchObject({
    outerIsError: true,
    lineCount: 4,
    wrapperMatched: true,
    orderMatched: true,
    nativeErrorMatched: true,
    diagMatched: true,
    completionSeen: true,
    tree: false,
    targetLeak: false,
    siblingLeak: false,
  });
  expect(inspectR1LifecycleFailure(result(text("")), fixture, 2)).toMatchObject({
    nativeErrorMatched: false,
    diagMatched: false,
    completionSeen: true,
  });
  expect(inspectR1LifecycleFailure(result(text(), false), fixture, 2).ok).toBe(false);
  expect(
    inspectR1LifecycleFailure(
      result([native(), diag(), "R1_LIFECYCLE_DONE:2"].join("\n")),
      fixture,
      2,
    ).ok,
  ).toBe(false);
  expect(
    inspectR1LifecycleFailure(
      result(["MCP tool returned an error:", diag(), native(), "R1_LIFECYCLE_DONE:2"].join("\n")),
      fixture,
      2,
    ).ok,
  ).toBe(false);
  expect(
    inspectR1LifecycleFailure(result(text() + "\nMCP tool returned an error:"), fixture, 2).ok,
  ).toBe(false);
  expect(
    inspectR1LifecycleFailure(result(text("Error stack element_unavailable")), fixture, 2).ok,
  ).toBe(false);
  expect(inspectR1LifecycleFailure(result(text("")), fixture, 2).ok).toBe(false);
  expect(inspectR1LifecycleFailure(result(text(native(), diag(), "")), fixture, 2).ok).toBe(false);
  expect(inspectR1LifecycleFailure(result(text(native(), diag(3))), fixture, 2).ok).toBe(false);
  expect(
    inspectR1LifecycleFailure(result(text(native("stale_state"), diag())), fixture, 2).ok,
  ).toBe(false);
  expect(
    inspectR1LifecycleFailure(
      result(text(native(), diag(2, "element_unavailable", "threw"))),
      fixture,
      2,
    ).ok,
  ).toBe(false);
  expect(inspectR1LifecycleFailure(result(text() + "\nSECRET"), fixture, 2).ok).toBe(false);
  expect(inspectR1LifecycleFailure(result(text() + "\nTARGET_BODY"), fixture, 2).ok).toBe(false);
  expect(
    JSON.stringify(inspectR1LifecycleFailure(result(text() + "\nSECRET"), fixture, 2)),
  ).not.toContain("SECRET");
});

it("生命周期顺序只接受有限且递增的事实", () => {
  expect(r1LifecycleOrder([1, 2, 3])).toBe(true);
  expect(r1LifecycleOrder([1, 1, 2])).toBe(false);
  expect(r1LifecycleOrder([1, Number.NaN, 3])).toBe(false);
  expect(r1LifecycleOrder([])).toBe(false);
});

it("Stop 后续请求按精确工具结果 ID 和禁止 fixture 判断", () => {
  const capture = (id: string) =>
    ({
      records: [
        {
          requestJson: {
            messages: [{ content: [{ type: "tool_result", tool_use_id: id, content: "" }] }],
          },
        },
      ],
    }) as never;
  expect(r1NoStoppedContinuation(undefined, "call")).toBe(false);
  expect(r1NoStoppedContinuation(capture("call-other"), "call")).toBe(true);
  expect(r1NoStoppedContinuation(capture("call"), "call")).toBe(false);
  expect(
    r1NoStoppedContinuation(
      { records: [{ replay: { fixtureId: "cua-r1-stop-final" } }] } as never,
      "call",
    ),
  ).toBe(false);
});

it("读取卡身份来自独立字段，不受拼接选项序号影响", () => {
  const rows = [
    ["PID", "35263"],
    ["Window ID", "114982"],
  ] as const;
  const identity = parseR1IdentityRows(rows);
  expect(r1IdentityMatches(identity, 35263, 114982)).toBe(true);
  expect("PID35263Window ID1149821.Allow this read").toContain("1149821");
  expect(
    r1IdentityMatches(
      parseR1IdentityRows([
        ["PID", "123"],
        ["窗口 ID", "345"],
      ]),
      12,
      34,
    ),
  ).toBe(false);
  expect(
    parseR1IdentityRows([
      ["PID", "12"],
      ["PID", "12"],
      ["Window ID", "34"],
    ]),
  ).toBeNull();
  expect(parseR1IdentityRows([["PID", "12"]])).toBeNull();
  expect(
    parseR1IdentityRows([
      ["PID", "12x"],
      ["Window ID", "34"],
    ]),
  ).toBeNull();
  expect(
    parseR1IdentityRows([
      ["PID", "0"],
      ["Window ID", "34"],
    ]),
  ).toBeNull();
  expect(
    parseR1IdentityRows([
      ["PID", "9007199254740992"],
      ["Window ID", "34"],
    ]),
  ).toBeNull();
});

it("重建后仅接纳同一进程及兄弟窗口且通过预检的新 manifest", () => {
  const original = {
    fixtureKind: "explicit-ax-content-v1",
    pid: 12,
    targetWindow: 34,
    siblingWindow: 56,
    targetMarker: "E2E_R1_TARGET_BODY",
    siblingMarker: "E2E_R1_SIBLING_BODY",
  };
  const fresh = { ...original, targetWindow: 78 };
  const probe = {
    pid: 12,
    hidden: false,
    launchDatePresent: true,
    windowIDs: [
      { windowID: 78, boundsValid: true, layer: 0, onscreen: true },
      { windowID: 56, boundsValid: true, layer: 0, onscreen: true },
    ],
  };
  expect(validateR1FreshFixture(original, fresh, probe, 123, 123)).toEqual(fresh);
  expect(validateR1FreshFixture(original, { ...fresh, pid: 13 }, probe, 123, 123)).toBeNull();
  expect(
    validateR1FreshFixture(original, { ...fresh, siblingWindow: 57 }, probe, 123, 123),
  ).toBeNull();
  expect(
    validateR1FreshFixture(original, { ...fresh, fixtureKind: "other" }, probe, 123, 123),
  ).toBeNull();
  expect(
    validateR1FreshFixture(original, { ...fresh, targetMarker: "OTHER" }, probe, 123, 123),
  ).toBeNull();
  expect(validateR1FreshFixture(original, fresh, { ...probe, hidden: true }, 123, 123)).toBeNull();
  expect(validateR1FreshFixture(original, fresh, probe, 123, 124)).toBeNull();
});

it("收据使用每个 case 的独立夹具快照", () => {
  const fixture = {
    pid: 1,
    targetWindow: 2,
    siblingWindow: 3,
    targetMarker: "T",
    siblingMarker: "S",
  };
  const snapshot = snapshotR1Fixture(fixture);
  fixture.targetWindow = 4;
  const result = {
    content: 'R1_DIAG:{"case":"metadata","fixtureWindows":[{"pid":1,"window_id":2}]}',
    isError: false,
    toolCallId: "x",
  };
  expect(safeReceipt(result, snapshot).diagnostics?.[0]?.fixtureWindows[0]?.window_id).toBe(2);
  expect(safeReceipt(result, fixture).diagnostics?.[0]?.fixtureWindows).toEqual([]);
});

it("validates the exact pane session and protocol phase", () => {
  expect(parseCuaV4SessionPhase({ sessionId: "s1", phase: "completedInterrupted" }, "s1")).toBe(
    "completedInterrupted",
  );
  expect(
    parseCuaV4SessionPhase({ sessionId: "s2", phase: "completedInterrupted" }, "s1"),
  ).toBeNull();
  expect(parseCuaV4SessionPhase({ sessionId: "s1", phase: null }, "s1")).toBeNull();
  expect(parseCuaV4SessionPhase({ sessionId: "s1", phase: "idle" }, "s1")).toBeNull();
  expect(parseCuaV4SessionPhase(null, "s1")).toBeNull();
});
