import { Socket } from "node:net";
import { CuaSubmissionAuthority } from "@zcode/core/cua-submission";

const AUTHORITY_FD = 3;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024;
const CLOSE_FLUSH_TIMEOUT_MS = 250;
const MAX_FIELD_BYTES = 4 * 1024;
const METHODS = new Set(["bootstrap", "check", "revoke", "close"]);
const REF_STRING_FIELDS = [
  "submissionLineageId",
  "appIncarnation",
  "hostInstanceId",
  "runtimeInstanceId",
  "sessionId",
  "workspaceKey",
];

let socket;
let authority;
let scope;
let pendingCandidate;
let bootstrapStarted = false;
let invalidated = false;
let input = "";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_FIELD_BYTES
  );
}

function readBoundedString(payload, field) {
  const value = payload[field];
  return isBoundedString(value) ? value : undefined;
}

function readRef(value) {
  if (!isObject(value)) return undefined;
  const ref = {};
  for (const field of REF_STRING_FIELDS) {
    if (!isBoundedString(value[field])) return undefined;
    ref[field] = value[field];
  }
  if (!Number.isSafeInteger(value.authorizationRevision) || value.authorizationRevision <= 0) {
    return undefined;
  }
  ref.authorizationRevision = value.authorizationRevision;
  return ref;
}

function sameRef(left, right) {
  return (
    REF_STRING_FIELDS.every((field) => left?.[field] === right?.[field]) &&
    left?.authorizationRevision === right?.authorizationRevision
  );
}

function writeFrame(frame) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  const line = `${JSON.stringify(frame)}\n`;
  const frameBytes = Buffer.byteLength(line, "utf8");
  if (frameBytes > MAX_FRAME_BYTES) return false;
  if (socket.writableLength + frameBytes > MAX_PENDING_OUTPUT_BYTES) return false;
  socket.write(line);
  return true;
}

function invalidate(options = {}) {
  if (invalidated) return false;
  invalidated = true;
  input = "";

  const activeAuthority = authority;
  const activeScope = scope;
  const pending = pendingCandidate;
  authority = undefined;
  pendingCandidate = undefined;
  let terminalFrameWritten = options.terminalFrame === undefined;
  try {
    if (activeAuthority && activeScope) {
      activeAuthority.producerLost({
        producerIncarnation: activeScope.producerIncarnation,
        reason: options.reason ?? "producer-lost",
      });
    } else if (pending) {
      pending.authority.producerLost({
        producerIncarnation: pending.producerIncarnation,
        reason: options.reason ?? "producer-lost",
      });
    }
  } finally {
    activeAuthority?.dispose();
    pending?.authority.dispose();
    scope = undefined;
    if (options.terminalFrame) terminalFrameWritten = writeFrame(options.terminalFrame);
    if (options.flush && terminalFrameWritten) {
      socket?.end();
      const timer = setTimeout(() => socket?.destroy(), CLOSE_FLUSH_TIMEOUT_MS);
      timer.unref();
      socket?.once("close", () => clearTimeout(timer));
    } else {
      socket?.destroy();
    }
  }
  return true;
}

function respond(requestId, method, result) {
  if (invalidated) return false;
  const written = writeFrame({ requestId, method, result });
  if (!written) invalidate();
  return written;
}

function reject(requestId, method, reason) {
  respond(requestId, method, { ok: false, reason });
}

function parseRequest(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: "invalid_json" };
  }
  if (!isObject(value) || !isBoundedString(value.requestId) || !isObject(value.payload)) {
    return { error: "invalid_frame", requestId: isObject(value) ? value.requestId : null };
  }
  if (!isBoundedString(value.method) || !METHODS.has(value.method)) {
    return { error: "unknown_method", requestId: value.requestId, method: value.method };
  }
  return { request: value };
}

async function handleBootstrap(request) {
  if (bootstrapStarted) {
    reject(request.requestId, request.method, "duplicate_bootstrap");
    return;
  }
  bootstrapStarted = true;

  const payload = request.payload;
  const traceId = readBoundedString(payload, "traceId");
  const appIncarnation = readBoundedString(payload, "appIncarnation");
  const hostInstanceId = readBoundedString(payload, "hostInstanceId");
  const runtimeInstanceId = readBoundedString(payload, "runtimeInstanceId");
  const sessionId = readBoundedString(payload, "sessionId");
  const workspaceKey = readBoundedString(payload, "workspaceKey");
  const sourceCommandId = readBoundedString(payload, "sourceCommandId");
  const producerIncarnation = readBoundedString(payload, "producerIncarnation");
  const runId = readBoundedString(payload, "runId");
  const turnId = readBoundedString(payload, "turnId");
  const queueItemId =
    payload.queueItemId === undefined ? undefined : readBoundedString(payload, "queueItemId");
  if (
    !traceId ||
    !appIncarnation ||
    !hostInstanceId ||
    !runtimeInstanceId ||
    !sessionId ||
    !workspaceKey ||
    !sourceCommandId ||
    !producerIncarnation ||
    !runId ||
    !turnId ||
    (payload.queueItemId !== undefined && !queueItemId)
  ) {
    reject(request.requestId, request.method, "invalid_payload");
    return;
  }

  const candidate = new CuaSubmissionAuthority({
    appIncarnation,
    hostInstanceId,
    runtimeInstanceId,
    sessionId,
    workspaceKey,
    onRevocation: (projection) => {
      if (!scope) return;
      const written = writeFrame({
        requestId: `revocation:${projection.ref.submissionLineageId}:${projection.ref.authorizationRevision}`,
        method: "revoked",
        result: { ok: true, traceId: scope.traceId, projection },
      });
      if (!written) invalidate();
    },
  });
  const admission = candidate.admitLive({
    origin: "desktop",
    inputKind: "new-submission",
    sourceCommandId,
    ...(queueItemId === undefined ? {} : { queueItemId }),
  });
  if (!admission.accepted) {
    candidate.dispose();
    reject(request.requestId, request.method, admission.reason);
    return;
  }
  const binding = candidate.bindTurn({
    ref: admission.ref,
    producerIncarnation,
    runId,
    turnId,
  });
  if (!binding.ok) {
    candidate.dispose();
    reject(request.requestId, request.method, binding.reason);
    return;
  }

  pendingCandidate = { authority: candidate, producerIncarnation };
  const projection = await candidate.resolve({ ref: binding.ref });
  if (invalidated) {
    candidate.dispose();
    if (pendingCandidate?.authority === candidate) pendingCandidate = undefined;
    return;
  }
  if (projection.status !== "candidate") {
    candidate.dispose();
    pendingCandidate = undefined;
    reject(request.requestId, request.method, "not_candidate");
    return;
  }

  authority = candidate;
  scope = {
    traceId,
    ref: projection.ref,
    producerIncarnation,
    runId,
    turnId,
  };
  pendingCandidate = undefined;
  respond(request.requestId, request.method, {
    ok: true,
    traceId,
    ref: projection.ref,
    producerIncarnation,
    runId,
    turnId,
    projection,
  });
}

async function handleCheck(request) {
  if (!authority || !scope) {
    reject(request.requestId, request.method, "not_bootstrapped");
    return;
  }
  const payload = request.payload;
  const ref = readRef(payload.ref);
  if (!ref) {
    reject(request.requestId, request.method, "invalid_ref");
    return;
  }

  const projection = await authority.resolve({ ref });
  if (invalidated) return;
  if (payload.traceId !== scope.traceId) {
    reject(request.requestId, request.method, "trace_mismatch");
    return;
  }
  if (!sameRef(ref, scope.ref)) {
    reject(request.requestId, request.method, "ref_mismatch");
    return;
  }
  if (
    payload.producerIncarnation !== scope.producerIncarnation ||
    payload.runId !== scope.runId ||
    payload.turnId !== scope.turnId
  ) {
    reject(request.requestId, request.method, "association_mismatch");
    return;
  }
  if (projection.status !== "candidate") {
    reject(request.requestId, request.method, "not_candidate");
    return;
  }
  respond(request.requestId, request.method, {
    ok: true,
    traceId: scope.traceId,
    ref: projection.ref,
    producerIncarnation: scope.producerIncarnation,
    runId: scope.runId,
    turnId: scope.turnId,
    projection,
  });
}

async function handleRevoke(request) {
  if (!authority || !scope) {
    reject(request.requestId, request.method, "not_bootstrapped");
    return;
  }
  const payload = request.payload;
  const ref = readRef(payload.ref);
  if (!ref) {
    reject(request.requestId, request.method, "invalid_ref");
    return;
  }
  if (payload.traceId !== scope.traceId) {
    reject(request.requestId, request.method, "trace_mismatch");
    return;
  }
  if (!sameRef(ref, scope.ref)) {
    reject(request.requestId, request.method, "ref_mismatch");
    return;
  }

  const revocation = await authority.revoke({ ref, reason: "user-stop" });
  if (invalidated) return;
  if (revocation.status !== "revoked") {
    reject(request.requestId, request.method, "unknown_ref");
    return;
  }
  respond(request.requestId, request.method, {
    ok: true,
    traceId: scope.traceId,
    revocation,
  });
}

function handleClose(request) {
  invalidate({
    flush: true,
    terminalFrame: {
      requestId: request.requestId,
      method: request.method,
      result: { ok: true, closed: true },
    },
  });
}

async function handleLine(line) {
  if (invalidated) return;
  const parsed = parseRequest(line);
  if (parsed.error) {
    reject(parsed.requestId ?? null, parsed.method ?? "error", parsed.error);
    return;
  }
  const request = parsed.request;
  if (request.method === "bootstrap") await handleBootstrap(request);
  else if (request.method === "check") await handleCheck(request);
  else if (request.method === "revoke") await handleRevoke(request);
  else if (request.method === "close") handleClose(request);
}

async function drainInput() {
  let newline = input.indexOf("\n");
  while (newline >= 0 && !invalidated) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (line.length > 0) await handleLine(line);
    newline = input.indexOf("\n");
  }
}

function handleDisconnect() {
  invalidate();
}

function rejectOversizeFrame() {
  invalidate();
}

try {
  socket = new Socket({ fd: AUTHORITY_FD, readable: true, writable: true });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (invalidated) return;
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > MAX_FRAME_BYTES) {
      rejectOversizeFrame();
      return;
    }
    socket.pause();
    void drainInput()
      .catch(() => invalidate())
      .finally(() => {
        if (!invalidated) socket.resume();
      });
  });
  socket.on("end", handleDisconnect);
  socket.on("error", handleDisconnect);
  socket.on("close", handleDisconnect);
  process.once("SIGTERM", handleDisconnect);
  process.once("SIGINT", handleDisconnect);
  socket.resume();
} catch (error) {
  process.stderr.write(`authority entry failed to open FD${AUTHORITY_FD}: ${String(error)}\n`);
  process.exitCode = 2;
}
