import {
  isObject,
  readCuaNativeConfirmRequestPayload,
  readCuaSubmissionRef,
  sameCuaSubmissionRef,
} from "./cua-native-authority-contract.js";
import type { CuaNativeAuthorityProtocolContext } from "./cua-native-authority-protocol.js";
import { UNKNOWN_CUA_SUBMISSION_PROJECTION, withTimeout } from "./cua-native-authority-facts.js";

const MAX_RESULT_BYTES = 12 * 1024;
const MAX_METADATA_RESULT_BYTES = 64 * 1024;
type Frame = { requestId: string; method: string; payload: Record<string, unknown> };
const ASSOCIATION_KEYS = ["ref", "traceId", "producerIncarnation", "runId", "turnId"];

function matches(
  ctx: CuaNativeAuthorityProtocolContext,
  payload: Record<string, unknown>,
): boolean {
  return (
    sameCuaSubmissionRef(readCuaSubmissionRef(payload.ref), ctx.scope.ref) &&
    payload.traceId === ctx.scope.traceId &&
    payload.producerIncarnation === ctx.producerIncarnation &&
    payload.runId === ctx.scope.runId &&
    payload.turnId === ctx.scope.turnId
  );
}
function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
async function live(ctx: CuaNativeAuthorityProtocolContext): Promise<boolean> {
  const p = await withTimeout(
    ctx.scope.producerPort.resolve({ ref: ctx.scope.ref }),
    ctx.requestTimeoutMs,
    UNKNOWN_CUA_SUBMISSION_PROJECTION,
  );
  return (
    !ctx.state.invalidated &&
    !ctx.state.closed &&
    p.status === "candidate" &&
    sameCuaSubmissionRef(p.ref, ctx.scope.ref)
  );
}
export async function handleObservationFrame(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: Frame,
): Promise<void> {
  const reject = (reason: string) => {
    ctx.reject(frame.requestId, frame.method, reason);
    ctx.observation?.onRejected?.(reason);
  };
  if (!ctx.state.bootstrapped || !ctx.observation || !matches(ctx, frame.payload))
    return reject("observation-invalid");
  if (frame.method === "confirmRead") {
    const payload = readCuaNativeConfirmRequestPayload(frame.payload);
    const args = ctx.observation.request.arguments;
    const ref = isObject(args.app_ref) ? args.app_ref : {};
    if (
      !payload ||
      !onlyKeys(frame.payload, [...ASSOCIATION_KEYS, "generation", "target"]) ||
      ctx.observation.request.method !== "get_app_state" ||
      !ctx.confirmReadRequest ||
      (ref.pid !== undefined && ref.pid !== payload.target.pid) ||
      (ref.window_id !== undefined && ref.window_id !== payload.target.windowId) ||
      // 一个观察请求只有一次读取确认；不能换 generation 绕过用户刚作出的拒绝。
      ctx.state.confirmSeenGenerations.size > 0 ||
      ctx.state.readTarget
    )
      return reject("confirmation-invalid");
    ctx.state.confirmSeenGenerations.add(payload.generation);
    if (!(await live(ctx))) return reject("scope_invalidated");
    let outcome;
    try {
      outcome = await ctx.confirmReadRequest(payload);
    } catch {
      return reject("confirmation-failed");
    }
    if (!(await live(ctx))) return;
    if ("ok" in outcome) return reject(outcome.reason);
    if (outcome.allowed === true)
      ctx.state.readTarget = { pid: payload.target.pid, windowId: payload.target.windowId };
    ctx.write({
      requestId: frame.requestId,
      method: frame.method,
      result: { ok: true, allowed: outcome.allowed === true },
    });
    return;
  }
  if (
    ctx.state.observationResultStarted ||
    !onlyKeys(frame.payload, [...ASSOCIATION_KEYS, "result"])
  )
    return reject("observation-invalid");
  ctx.state.observationResultStarted = true;
  const raw = frame.payload.result;
  if (
    !isObject(raw) ||
    Buffer.byteLength(JSON.stringify(raw), "utf8") >
      (raw.isError !== true &&
      (ctx.observation.request.method === "list_apps" ||
        ctx.observation.request.method === "list_windows")
        ? MAX_METADATA_RESULT_BYTES
        : MAX_RESULT_BYTES) ||
    (raw.isError !== undefined && typeof raw.isError !== "boolean") ||
    !Array.isArray(raw.content) ||
    !raw.content.every(isObject) ||
    Object.keys(raw).some((k) => !["content", "isError", "structuredContent", "_meta"].includes(k))
  )
    return reject("observation-invalid");
  let result: Record<string, unknown> & { content: Array<Record<string, unknown>> } = raw as Record<
    string,
    unknown
  > & { content: Array<Record<string, unknown>> };
  // 失败仅允许错误文本，防止借错误信封绕过正文授权。
  if (
    result.isError === true &&
    (result.structuredContent !== undefined ||
      result._meta !== undefined ||
      !result.content.every(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          Object.keys(block).every((k) => k === "type" || k === "text"),
      ))
  )
    return reject("observation-invalid");
  if (result.isError === true) {
    // 错误的自由文本也可能偷带正文；只透传已知 code，重建固定消息。
    if (result.content.length !== 1) return reject("observation-invalid");
    let error: unknown;
    try {
      error = JSON.parse(String(result.content[0]?.text));
    } catch {
      return reject("observation-invalid");
    }
    const codes = new Set([
      "permission_denied",
      "stale_state",
      "structured_state_unavailable",
      "action_unavailable",
      "timeout",
      "broker_unavailable",
      "screen_locked",
      "not_authorized",
      "invalid_request",
      "element_unavailable",
      "internal",
      "STALE_STATE",
      "SCREEN_LOCKED",
      "STRUCTURED_STATE_UNAVAILABLE",
    ]);
    if (!isObject(error) || typeof error.code !== "string" || !codes.has(error.code))
      return reject("observation-invalid");
    result = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: error.code,
            message: "Computer use observation failed",
            action_sent: false,
            dispatch_status: "not_sent",
          }),
        },
      ],
    };
  }
  if (result.isError !== true && ctx.observation.request.method !== "get_app_state") {
    // 枚举只允许固定元数据字段，禁止通过附加内容块或预览偷带正文。
    if (
      result.structuredContent !== undefined ||
      result._meta !== undefined ||
      result.content.length !== 1
    )
      return reject("observation-invalid");
    const block = result.content[0];
    if (
      !block ||
      block.type !== "text" ||
      typeof block.text !== "string" ||
      !onlyKeys(block, ["type", "text"])
    )
      return reject("observation-invalid");
    let rows: unknown;
    try {
      rows = JSON.parse(block.text);
    } catch {
      return reject("observation-invalid");
    }
    if (
      !Array.isArray(rows) ||
      !rows.every((row) => {
        if (!isObject(row) || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0) return false;
        if (ctx.observation?.request.method === "list_windows") {
          const bounds = row.bounds;
          return (
            Object.keys(row).every((key) =>
              [
                "pid",
                "window_id",
                "title",
                "text_preview",
                "bounds",
                "main",
                "focused",
                "onscreen",
                "subrole",
              ].includes(key),
            ) &&
            Number.isSafeInteger(row.window_id) &&
            Number(row.window_id) > 0 &&
            (typeof row.title === "string" || row.title === null) &&
            row.text_preview === null &&
            isObject(bounds) &&
            onlyKeys(bounds, ["x", "y", "width", "height"]) &&
            Object.values(bounds).every((v) => typeof v === "number" && Number.isFinite(v)) &&
            [row.main, row.focused].every((v) => v === null || typeof v === "boolean") &&
            typeof row.onscreen === "boolean" &&
            (row.subrole === undefined || typeof row.subrole === "string")
          );
        }
        return (
          Object.keys(row).every((key) => ["pid", "name", "bundle_id", "active"].includes(key)) &&
          (typeof row.name === "string" || row.name === null) &&
          (typeof row.bundle_id === "string" || row.bundle_id === null) &&
          typeof row.active === "boolean"
        );
      })
    )
      return reject("observation-invalid");
  }
  if (result.isError !== true && ctx.observation.request.method === "get_app_state") {
    const state = result.structuredContent;
    if (
      !isObject(state) ||
      typeof state.state_id !== "string" ||
      !state.state_id ||
      typeof state.text !== "string" ||
      typeof state.truncated !== "boolean" ||
      !["full", "diff"].includes(String(state.snapshot_mode)) ||
      (state.snapshot_mode === "diff" &&
        (typeof state.base_state_id !== "string" || !state.base_state_id)) ||
      !Array.isArray(state.elements) ||
      state.elements.length > 64 ||
      result.content.length !== 1 ||
      result.content[0]?.type !== "text" ||
      result.content[0]?.text !== state.text ||
      !state.elements.every(
        (element, index) =>
          isObject(element) &&
          element.index === index &&
          typeof element.kind === "string" &&
          Buffer.byteLength(element.kind, "utf8") <= 256 &&
          [element.title, element.value].every(
            (v) => v === null || (typeof v === "string" && Buffer.byteLength(v, "utf8") <= 256),
          ) &&
          Array.isArray(element.actions) &&
          element.actions.every(
            (v) => typeof v === "string" && Buffer.byteLength(v, "utf8") <= 256,
          ),
      )
    )
      return reject("observation-invalid");
    const window = isObject(state) && isObject(state.window) ? state.window : undefined;
    if (
      !ctx.state.readTarget ||
      !window ||
      !isObject(state) ||
      !isObject(state.app) ||
      state.app.pid !== ctx.state.readTarget.pid ||
      window.pid !== ctx.state.readTarget.pid ||
      window.window_id !== ctx.state.readTarget.windowId
    )
      return reject("read-not-authorized");
  }
  if (!(await live(ctx))) return reject("scope_invalidated");
  if (
    !ctx.write({
      requestId: frame.requestId,
      method: frame.method,
      result: { ok: true, accepted: true },
    })
  )
    return;
  ctx.observation.accept(result as unknown as Parameters<typeof ctx.observation.accept>[0]);
  ctx.finish("adapter-close", true);
}
