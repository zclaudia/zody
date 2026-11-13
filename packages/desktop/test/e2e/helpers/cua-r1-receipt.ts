import {
  readUpstreamToolResultFromRequest,
  type UpstreamToolResultSnapshot,
} from "./conversation-session-network.js";

export interface R1Fixture {
  fixtureKind?: unknown;
  pid: number;
  targetWindow: number;
  siblingWindow: number;
  targetMarker: string;
  siblingMarker: string;
}

export function identifyR1FixtureProfile(value: unknown) {
  if (value === undefined) return { kind: "default-appkit", caseId: "CUA-AX-R1-03a" } as const;
  if (value === "explicit-ax-content-v1")
    return { kind: "explicit-ax-content-v1", caseId: "CUA-AX-R1-03b" } as const;
  throw new Error("Unsupported R1 fixture profile");
}

export function safeReceipt(result: UpstreamToolResultSnapshot | null, fixture: R1Fixture) {
  if (!result) return { received: false };
  const codes = [
    ...new Set(
      result.content.match(
        /\b(?:permission_denied|not_authorized|screen_locked|broker_unavailable|element_unavailable|structured_state_unavailable|action_unavailable|timeout|invalid_request|stale_state|internal)\b/gi,
      ) ?? [],
    ),
  ].map((v) => v.toLowerCase());
  const diagnostics = [...result.content.matchAll(/R1_DIAG:(\{[^\n]*?\})(?=\s|$)/g)].flatMap(
    (match) => {
      try {
        const d = JSON.parse(match[1] ?? "") as Record<string, unknown>;
        const cases = ["metadata", "deny", "allow_metadata", "allow", "state"];
        if (typeof d.case !== "string" || !cases.includes(d.case)) return [];
        const shape = (v: unknown) => {
          if (!v || typeof v !== "object") return null;
          const value = v as Record<string, unknown>;
          const types = ["array", "null", "string", "object", "undefined", "boolean", "number"];
          const code =
            typeof value.code === "string" && codes.includes(value.code) ? value.code : null;
          return {
            type:
              typeof value.type === "string" && types.includes(value.type) ? value.type : "unknown",
            code,
          };
        };
        const windows = Array.isArray(d.fixtureWindows)
          ? d.fixtureWindows
              .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object"))
              .filter(
                (v) =>
                  v.pid === fixture.pid &&
                  (v.window_id === fixture.targetWindow || v.window_id === fixture.siblingWindow),
              )
              .map((v) => ({
                pid: fixture.pid,
                window_id: v.window_id,
                text_preview_is_null: v.text_preview_is_null === true,
                onscreen: v.onscreen === true,
                main_type: v.main_type === "boolean" ? "boolean" : "unknown",
                focused_type: v.focused_type === "boolean" ? "boolean" : "unknown",
                subrole_present: v.subrole_present === true,
              }))
          : [];
        const apps =
          Array.isArray(d.fixtureApps) &&
          d.fixtureApps.some((v) => v && typeof v === "object" && v.pid === fixture.pid)
            ? [{ pid: fixture.pid }]
            : [];
        return [
          {
            case: d.case,
            index:
              typeof d.index === "number" &&
              Number.isInteger(d.index) &&
              d.index >= 1 &&
              d.index <= 5
                ? d.index
                : null,
            full: d.full === true,
            diff: d.diff === true,
            ok: d.ok === true,
            apps: shape(d.apps),
            windows: shape(d.windows),
            result: shape(d.result),
            fixtureApps: apps,
            fixtureWindows: windows,
            targetLeak: d.targetLeak === true,
            siblingLeak: d.siblingLeak === true,
            targetSeen: d.targetSeen === true,
          },
        ];
      } catch {
        return [];
      }
    },
  );
  return {
    received: true,
    isError: result.isError,
    codes,
    diagnostics,
    marker: /E2E_R1_(?:METADATA|DENIED|ALLOWED|STATE)_OK/.exec(result.content)?.[0] ?? null,
  };
}

/** 只从 provider 实际收到的单次 tool_result 提取受限事实，不持久化树。 */
export function inspectStateToolResult(
  result: UpstreamToolResultSnapshot | null,
  fixture: R1Fixture,
  stage: number,
) {
  const text = result?.content ?? "";
  const full = text.includes("AX window state");
  const diff = text.includes("AX window diff");
  const targetSeen = text.includes(fixture.targetMarker);
  const siblingLeak = text.includes(fixture.siblingMarker);
  const silent = stage === 3;
  const expectedFull = stage === 1 || stage === 4;
  const marker = text.includes(`E2E_R1_STATE_${stage}_OK`);
  const safe = safeReceipt(result, fixture);
  const diag = safe.diagnostics?.find((d) => d.case === "state" && d.index === stage);
  const treeOk = silent ? !full && !diff && !targetSeen : expectedFull ? full && targetSeen : diff;
  return {
    received: Boolean(result),
    isError: result?.isError === true,
    stage,
    codes: safe.codes ?? [],
    diagnostics: safe.diagnostics?.filter((d) => d.case === "state" && d.index === stage) ?? [],
    full,
    diff,
    targetSeen,
    siblingLeak,
    marker,
    ok: Boolean(
      result &&
      !result.isError &&
      marker &&
      treeOk &&
      !siblingLeak &&
      (silent ? diag?.ok && diag.full && diag.targetSeen && !diag.siblingLeak : true),
    ),
  };
}

/** 回放只留固定计数，不持久化请求、响应或供应商配置。 */
export function projectR1NetworkStats(
  capture: import("./network-capture-proxy.js").E2ENetworkCaptureArtifact | undefined,
  expectedModel: string,
) {
  const records = capture?.records ?? [];
  return {
    captureAvailable: capture !== undefined,
    requestCount: records.length,
    expectedFixtureModelCount: records.filter((record) =>
      Boolean(
        record.requestJson &&
        typeof record.requestJson === "object" &&
        (record.requestJson as { model?: unknown }).model === expectedModel,
      ),
    ).length,
    pendingCount: records.filter((record) => record.status === "pending").length,
    completeCount: records.filter((record) => record.status === "complete").length,
    errorCount: records.filter((record) => record.status === "error").length,
    http2xxCount: records.filter(
      (record) =>
        typeof record.statusCode === "number" &&
        record.statusCode >= 200 &&
        record.statusCode < 300,
    ).length,
    http4xx5xxCount: records.filter(
      (record) =>
        typeof record.statusCode === "number" &&
        record.statusCode >= 400 &&
        record.statusCode < 600,
    ).length,
  };
}

/** 只投影固定错误和正文泄露事实，不保存 SDK 返回内容。 */
export function inspectR1LifecycleFailure(
  result: UpstreamToolResultSnapshot | null,
  fixture: R1Fixture,
  stage: 2 | 3,
) {
  const text = result?.content ?? "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nativeLines = lines.filter((line) => line.startsWith("{"));
  const diagLines = lines.filter((line) => line.startsWith("R1_LIFECYCLE:"));
  const doneLines = lines.filter((line) => line === `R1_LIFECYCLE_DONE:${stage}`);
  let code: "element_unavailable" | "stale_state" | null = null;
  let nativeErrorMatched = false,
    diagMatched = false;
  try {
    if (nativeLines.length === 1) {
      const n = JSON.parse(nativeLines[0]!) as Record<string, unknown>;
      if (
        Object.keys(n).sort().join(",") === "action_sent,code,dispatch_status,message" &&
        (n.code === "element_unavailable" || n.code === "stale_state") &&
        n.message === "Computer use observation failed" &&
        n.action_sent === false &&
        n.dispatch_status === "not_sent"
      ) {
        code = n.code;
        nativeErrorMatched = true;
      }
    }
    if (diagLines.length === 1) {
      const d = JSON.parse(diagLines[0]!.slice("R1_LIFECYCLE:".length)) as Record<string, unknown>;
      diagMatched =
        Object.keys(d).sort().join(",") === "code,kind,ok,outcome,resultType,stage" &&
        d.kind === "window_rejected" &&
        d.stage === stage &&
        d.resultType === "object" &&
        d.outcome === "returned" &&
        d.ok === true &&
        code !== null &&
        d.code === code;
    }
  } catch {
    /* 只接受固定结构，禁止自由文本。 */
  }
  const completionSeen = doneLines.length === 1;
  const lineCount = lines.length;
  // 通用 MCP formatter 会加此固定首行；漏算会拒绝真实错误，任意忽略额外行又会漏检正文。
  const wrapperMatched =
    lines.filter((line) => line === "MCP tool returned an error:").length === 1;
  const orderMatched =
    lineCount === 4 &&
    lines[0] === "MCP tool returned an error:" &&
    lines[1] === nativeLines[0] &&
    lines[2] === diagLines[0] &&
    lines[3] === `R1_LIFECYCLE_DONE:${stage}`;
  const outerIsError = result?.isError === true;
  const targetLeak = text.includes(fixture.targetMarker),
    siblingLeak = text.includes(fixture.siblingMarker);
  const tree = text.includes("AX window state") || text.includes("AX window diff");
  return {
    received: Boolean(result),
    outerIsError,
    lineCount,
    wrapperMatched,
    orderMatched,
    nativeErrorMatched,
    diagMatched,
    completionSeen,
    code,
    targetLeak,
    siblingLeak,
    tree,
    ok: Boolean(
      result &&
      outerIsError &&
      nativeErrorMatched &&
      diagMatched &&
      completionSeen &&
      wrapperMatched &&
      orderMatched &&
      !targetLeak &&
      !siblingLeak &&
      !tree,
    ),
  };
}

export function r1LifecycleOrder(times: readonly number[]) {
  return (
    times.length > 0 &&
    times.every((value, i) => Number.isFinite(value) && (i === 0 || value > times[i - 1]!))
  );
}

/** 只在停止至恢复前投影精确关联，缺 capture 不计成功。 */
export function r1NoStoppedContinuation(
  capture: import("./network-capture-proxy.js").E2ENetworkCaptureArtifact | undefined,
  id: string,
) {
  return Boolean(
    capture &&
    !capture.records.some(
      (record) =>
        Boolean(readUpstreamToolResultFromRequest(record.requestJson, id)) ||
        record.replay?.fixtureId === "cua-r1-stop-final",
    ),
  );
}

export function parseR1IdentityRows(rows: readonly (readonly [string, string])[]) {
  const pids = rows.filter(([label]) => label === "PID");
  const windows = rows.filter(([label]) => label === "Window ID" || label === "窗口 ID");
  if (pids.length !== 1 || windows.length !== 1) return null;
  const parse = (value: string) => {
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  };
  const pid = parse(pids[0]![1]),
    windowId = parse(windows[0]![1]);
  return pid !== null && windowId !== null ? { pid, windowId } : null;
}

export function r1IdentityMatches(
  identity: { pid: number; windowId: number } | null,
  pid: number,
  windowId: number,
) {
  return Boolean(identity && identity.pid === pid && identity.windowId === windowId);
}

export function snapshotR1Fixture(fixture: R1Fixture): R1Fixture {
  return { ...fixture };
}

export function validateR1FreshFixture(
  original: R1Fixture,
  candidate: unknown,
  rawProbe: unknown,
  originalLaunch: number,
  currentLaunch: number,
): R1Fixture | null {
  if (!candidate || typeof candidate !== "object" || !rawProbe || typeof rawProbe !== "object")
    return null;
  const f = candidate as R1Fixture;
  const probe = rawProbe as {
    pid?: unknown;
    hidden?: unknown;
    launchDatePresent?: unknown;
    windowIDs?: unknown;
  };
  if (
    f.fixtureKind !== "explicit-ax-content-v1" ||
    f.pid !== original.pid ||
    f.siblingWindow !== original.siblingWindow ||
    f.targetMarker !== original.targetMarker ||
    f.siblingMarker !== original.siblingMarker ||
    !Number.isSafeInteger(f.targetWindow) ||
    f.targetWindow <= 0 ||
    f.targetWindow === f.siblingWindow ||
    !Number.isFinite(originalLaunch) ||
    originalLaunch <= 0 ||
    originalLaunch !== currentLaunch ||
    probe.pid !== f.pid ||
    probe.hidden !== false ||
    probe.launchDatePresent !== true ||
    !Array.isArray(probe.windowIDs) ||
    probe.windowIDs.length !== 2
  )
    return null;
  const windows = probe.windowIDs;
  const ids = [f.targetWindow, f.siblingWindow];
  if (
    !ids.every((id) =>
      windows.some((raw: unknown) => {
        if (!raw || typeof raw !== "object") return false;
        const w = raw as Record<string, unknown>;
        return w.windowID === id && w.boundsValid === true && w.onscreen === true && w.layer === 0;
      }),
    )
  )
    return null;
  return snapshotR1Fixture(f);
}
