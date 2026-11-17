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

function associationKeys(ctx: CuaNativeAuthorityProtocolContext): string[] {
  return [...ASSOCIATION_KEYS, ...Object.keys(ctx.observation?.association ?? {})];
}

function matches(
  ctx: CuaNativeAuthorityProtocolContext,
  payload: Record<string, unknown>,
): boolean {
  return (
    sameCuaSubmissionRef(readCuaSubmissionRef(payload.ref), ctx.scope.ref) &&
    payload.traceId === ctx.scope.traceId &&
    payload.producerIncarnation === ctx.producerIncarnation &&
    payload.runId === ctx.scope.runId &&
    payload.turnId === ctx.scope.turnId &&
    payload.workspaceIdentity === ctx.observation?.association?.workspaceIdentity &&
    payload.remoteSessionId === ctx.observation?.association?.remoteSessionId
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
  const method = ctx.observation.request.method;
  const args = ctx.observation.request.arguments;
  const target = isObject(args.target) ? args.target : {};
  const element =
    target.type === "element" &&
    Number.isSafeInteger(target.index) &&
    Number(target.index) >= 0 &&
    onlyKeys(target, ["type", "index"]);
  const strategy =
    args.strategy === undefined || args.strategy === "auto" || args.strategy === "a11y";
  const control =
    element &&
    typeof args.state_id === "string" &&
    args.state_id.length > 0 &&
    (args.return_state === undefined ||
      ["none", "compact", "full"].includes(String(args.return_state))) &&
    ((method === "left_click" &&
      strategy &&
      (args.mouse_button === undefined || args.mouse_button === "left") &&
      (args.click_count === undefined || args.click_count === 1) &&
      (args.modifiers === undefined ||
        (Array.isArray(args.modifiers) && args.modifiers.length === 0))) ||
      (method === "perform_action" && args.action === "AXPress") ||
      (method === "set_value" && strategy && typeof args.value === "string"));
  if (frame.method === "confirmRead" || frame.method === "confirmControl") {
    const isControl = frame.method === "confirmControl";
    const payload = readCuaNativeConfirmRequestPayload(frame.payload);
    const ref = isObject(args.app_ref) ? args.app_ref : {};
    if (
      !payload ||
      !onlyKeys(frame.payload, [...associationKeys(ctx), "generation", "target"]) ||
      (isControl ? !control : method !== "get_app_state" && !control) ||
      !(isControl ? ctx.confirmControlRequest : ctx.confirmReadRequest) ||
      (isControl &&
        (method === "set_value" ||
          (args.return_state !== undefined && args.return_state !== "none")) &&
        (!ctx.state.readTarget ||
          ctx.state.readTarget.pid !== payload.target.pid ||
          ctx.state.readTarget.windowId !== payload.target.windowId)) ||
      (ref.pid !== undefined && ref.pid !== payload.target.pid) ||
      (ref.window_id !== undefined && ref.window_id !== payload.target.windowId) ||
      // 一个观察请求只有一次读取确认；不能换 generation 绕过用户刚作出的拒绝。
      (isControl
        ? ctx.state.controlConfirmSeen || ctx.state.controlTarget
        : ctx.state.confirmSeenGenerations.size > 0 || ctx.state.readTarget)
    )
      return reject("confirmation-invalid");
    if (isControl) ctx.state.controlConfirmSeen = true;
    else ctx.state.confirmSeenGenerations.add(payload.generation);
    if (!(await live(ctx))) return reject("scope_invalidated");
    let outcome;
    try {
      outcome = await (isControl ? ctx.confirmControlRequest! : ctx.confirmReadRequest!)(payload);
    } catch {
      return reject("confirmation-failed");
    }
    if (!(await live(ctx))) return;
    if ("ok" in outcome) return reject(outcome.reason);
    if (outcome.allowed === true)
      if (isControl)
        ctx.state.controlTarget = { pid: payload.target.pid, windowId: payload.target.windowId };
      else ctx.state.readTarget = { pid: payload.target.pid, windowId: payload.target.windowId };
    ctx.write({
      requestId: frame.requestId,
      method: frame.method,
      result: { ok: true, allowed: outcome.allowed === true },
    });
    return;
  }
  if (frame.method === "controlResult") {
    return handleControlResult(ctx, frame, control, reject);
  }
  if (["left_click", "perform_action", "set_value", "stop_computer_control"].includes(method))
    return reject("observation-invalid");
  if (
    ctx.state.observationResultStarted ||
    !onlyKeys(frame.payload, [...associationKeys(ctx), "result"])
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
  if (result.isError !== true && method === "commit_state") {
    // 中文原因：截图已交付后只提交原映射可见性；固定收据不能携带新正文或替换索引。
    const block = result.content[0];
    if (
      result.structuredContent !== undefined ||
      result._meta !== undefined ||
      result.content.length !== 1 ||
      !block ||
      !onlyKeys(block, ["type", "text"]) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    )
      return reject("observation-invalid");
    let committed: unknown;
    try {
      committed = JSON.parse(block.text);
    } catch {
      return reject("observation-invalid");
    }
    if (
      !isObject(committed) ||
      !onlyKeys(committed, ["committed", "state_id"]) ||
      committed.committed !== true ||
      typeof args.state_id !== "string" ||
      committed.state_id !== args.state_id
    )
      return reject("observation-invalid");
    if (!(await live(ctx))) return reject("scope_invalidated");
    if (
      !ctx.write({
        requestId: frame.requestId,
        method: frame.method,
        result: { ok: true, accepted: true },
      })
    )
      return;
    if (ctx.state.closed || ctx.state.invalidated) return;
    ctx.observation.accept(result as unknown as Parameters<typeof ctx.observation.accept>[0]);
    ctx.finish("adapter-close", true);
    return;
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
  // 中文原因：transport 写入可能同步触发关闭/撤销；成功 ACK 不能恢复已失效 scope 的交付权限。
  if (ctx.state.invalidated || ctx.state.closed) return;
  ctx.observation.accept(result as unknown as Parameters<typeof ctx.observation.accept>[0]);
  ctx.finish("adapter-close", true);
}

async function handleControlResult(
  ctx: CuaNativeAuthorityProtocolContext,
  frame: Frame,
  control: boolean,
  reject: (reason: string) => void,
): Promise<void> {
  if (
    !control ||
    ctx.state.observationResultStarted ||
    !(
      onlyKeys(frame.payload, [...associationKeys(ctx), "result"]) ||
      (onlyKeys(frame.payload, [...associationKeys(ctx), "result", "lease_watch"]) &&
        frame.payload.lease_watch === true)
    )
  )
    return reject("control-invalid");
  ctx.state.observationResultStarted = true;
  const raw = frame.payload.result;
  if (
    !isObject(raw) ||
    Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_RESULT_BYTES ||
    Object.keys(raw).some((key) => !["content", "isError", "structuredContent"].includes(key)) ||
    (raw.isError !== undefined && typeof raw.isError !== "boolean") ||
    !Array.isArray(raw.content) ||
    raw.content.length !== 1 ||
    !isObject(raw.content[0]) ||
    !onlyKeys(raw.content[0], ["type", "text"]) ||
    raw.content[0].type !== "text" ||
    typeof raw.content[0].text !== "string"
  )
    return reject("control-invalid");
  let receipt: unknown;
  try {
    receipt = JSON.parse(raw.content[0].text);
  } catch {
    return reject("control-invalid");
  }
  if (
    !isObject(receipt) ||
    typeof receipt.action_sent !== "boolean" ||
    !["not_sent", "sent", "possibly_sent"].includes(String(receipt.dispatch_status)) ||
    !["not_requested", "synced", "failed"].includes(String(receipt.state_sync_status)) ||
    (receipt.dispatch_status === "not_sent" && receipt.action_sent !== false) ||
    (receipt.dispatch_status !== "not_sent" && receipt.action_sent !== true) ||
    Object.keys(receipt).some(
      (key) =>
        !["action_sent", "dispatch_status", "state_sync_status", "code", "message"].includes(key),
    ) ||
    (receipt.code !== undefined &&
      ![
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
        "controller_busy",
        "internal",
      ].includes(String(receipt.code))) ||
    (receipt.message !== undefined && receipt.message !== "Computer use control failed")
  )
    return reject("control-invalid");
  if (receipt.dispatch_status !== "not_sent" && !ctx.state.controlTarget)
    return reject("control-not-authorized");
  // 中文原因：状态正文只能由本次读取授权交付，不能借动作回执绕过精确窗口检查。
  if (raw.structuredContent !== undefined) {
    const state = raw.structuredContent;
    if (
      !isObject(state) ||
      Object.keys(state).some(
        (key) =>
          ![
            "app",
            "window",
            "state_id",
            "text",
            "truncated",
            "snapshot_mode",
            "base_state_id",
            "elements",
          ].includes(key),
      ) ||
      !ctx.state.readTarget ||
      !isObject(state.app) ||
      !isObject(state.window) ||
      state.app.pid !== ctx.state.readTarget.pid ||
      state.window.pid !== ctx.state.readTarget.pid ||
      state.window.window_id !== ctx.state.readTarget.windowId ||
      ctx.state.controlTarget?.pid !== ctx.state.readTarget.pid ||
      ctx.state.controlTarget?.windowId !== ctx.state.readTarget.windowId ||
      receipt.state_sync_status !== "synced" ||
      typeof state.state_id !== "string" ||
      !state.state_id ||
      typeof state.text !== "string" ||
      typeof state.truncated !== "boolean" ||
      !["full", "diff"].includes(String(state.snapshot_mode)) ||
      (state.snapshot_mode === "diff" &&
        (typeof state.base_state_id !== "string" || !state.base_state_id)) ||
      !Array.isArray(state.elements) ||
      state.elements.length > 64 ||
      !state.elements.every(
        (element, index) =>
          isObject(element) &&
          Object.keys(element).every((key) =>
            ["index", "kind", "title", "value", "actions"].includes(key),
          ) &&
          element.index === index &&
          typeof element.kind === "string" &&
          Buffer.byteLength(element.kind, "utf8") <= 256 &&
          [element.title, element.value].every(
            (value) =>
              value === null ||
              (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256),
          ) &&
          Array.isArray(element.actions) &&
          element.actions.every(
            (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256,
          ),
      )
    )
      return reject("read-not-authorized");
  } else if (receipt.state_sync_status === "synced") return reject("control-invalid");
  if (!(await live(ctx))) return reject("scope_invalidated");
  const leaseWatch = frame.payload.lease_watch === true;
  if (leaseWatch && (!ctx.observation?.onLeaseWatch || !ctx.state.controlTarget))
    return reject("control-invalid");
  if (
    !ctx.write({
      requestId: frame.requestId,
      method: frame.method,
      result: { ok: true, accepted: true, ...(leaseWatch ? { lease_watch: true } : {}) },
    })
  )
    return;
  if (ctx.state.invalidated || ctx.state.closed) return;
  if (leaseWatch) {
    ctx.state.leaseWatch = true;
    ctx.observation!.onLeaseWatch!();
  }
  ctx.observation!.accept(
    raw as unknown as Parameters<NonNullable<typeof ctx.observation>["accept"]>[0],
  );
  if (!leaseWatch) ctx.finish("adapter-close", true);
}
