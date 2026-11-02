import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { MCP_TOOL_META_TIMEOUT_MAX_MS } from "@zcode/contracts";
import type { NodeReplRunResult } from "@zcode/core/repl";
import {
  assertTransportAuthenticationKey,
  generateTransportChallenge,
  parseHelperProofLine,
  transportProofCanonical,
  verifyHelperTransportProof,
} from "@zcode/shared/cua-helper-transport-auth";
import {
  CELL_REQUEST_MAX_BYTES,
  CELL_RESPONSE_MAX_BYTES,
  CellProtocolError,
  parseCellResponse,
  type CellRequest,
} from "./cell-protocol.js";

export const CUA_HELPER_CELL_CONTROL_MAX_BYTES = 16 * 1024;
export const CUA_HELPER_CELL_CONNECT_TIMEOUT_MS = 10_000;
// 安全硬上限取既有 MCP 工具最大预算；实际 server/per-tool timeout 由外层调用
// signal 执行，transport 不能先于现有允许的调用预算中断截图审批。
export const CUA_HELPER_CELL_DEFAULT_TIMEOUT_MS = MCP_TOOL_META_TIMEOUT_MAX_MS;
const MAX_ENDPOINT_BYTES = 4 * 1024;

export interface CuaHelperCellOpenFrame {
  readonly schemaVersion: 1;
  readonly type: "cell-open";
  readonly sourceSha256: string;
  readonly challenge: string;
  readonly requestMaxBytes: number;
  readonly responseMaxBytes: number;
}

export interface CuaHelperCellRunInput {
  /** 已编码的原始 fd3 request 行；Helper 只做字节中继，必须原样发送。 */
  readonly line: string;
  readonly request: CellRequest;
  readonly responseMaxBytes: number;
  readonly signal: AbortSignal;
}

export interface CuaHelperCellTransport {
  run(input: CuaHelperCellRunInput): Promise<NodeReplRunResult>;
}

export interface CuaHelperCellTransportOptions {
  /**
   * ready 帧里的私有 cellEndpoint。CUA factory 必须提供；返回 undefined 时
   * 明确 fail closed，绝不回退到按 serverPath spawn。
   */
  readonly endpoint: () => string | undefined;
  readonly sourceSha256: string;
  /**
   * 只由 native fd3 session-ready 注入的瞬时 key getter。缺失/非法时在 cell
   * 调用前 fail closed，不发送 CellRequest，也不回退到 path spawn。
   */
  readonly transportAuthenticationKey?: () => string | undefined;
  readonly requestMaxBytes?: number;
  readonly responseMaxBytes?: number;
  readonly timeoutMs?: number;
  /** 测试注入；生产只使用本机私有 Unix socket。 */
  readonly connectImpl?: (path: string, signal: AbortSignal) => Promise<Duplex>;
  /** 诊断回调，便于核对 Helper 上报的实际 cell PID。 */
  readonly onCellReady?: (pid: number) => void;
}

export function cuaHelperSourceSha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function createCuaHelperCellTransport(
  options: CuaHelperCellTransportOptions,
): CuaHelperCellTransport {
  if (!/^[0-9a-f]{64}$/u.test(options.sourceSha256)) {
    throw new Error("cua_node_repl_helper_source_sha_invalid");
  }
  const connectImpl = options.connectImpl ?? connectPrivateEndpoint;
  const timeoutMs = options.timeoutMs ?? CUA_HELPER_CELL_DEFAULT_TIMEOUT_MS;

  return {
    async run(input) {
      if (input.signal.aborted) throw input.signal.reason;
      const endpoint = resolveEndpoint(options.endpoint);
      const key = resolveTransportAuthenticationKey(options.transportAuthenticationKey);
      const challenge = generateTransportChallenge();
      const open: CuaHelperCellOpenFrame = {
        schemaVersion: 1,
        type: "cell-open",
        sourceSha256: options.sourceSha256,
        challenge,
        requestMaxBytes: options.requestMaxBytes ?? CELL_REQUEST_MAX_BYTES,
        responseMaxBytes: options.responseMaxBytes ?? input.responseMaxBytes,
      };
      assertBound("request", open.requestMaxBytes, CELL_REQUEST_MAX_BYTES);
      assertBound("response", open.responseMaxBytes, CELL_RESPONSE_MAX_BYTES);
      if (open.responseMaxBytes !== input.responseMaxBytes) {
        throw new Error("cua_node_repl_helper_response_bound_mismatch");
      }
      // 中文原因：Helper 只中继一条原始 fd3 行；必须在 connect/spawn 前执行真实
      // frame 上限和单行形状，不能等 native 侧声明值或只靠缓冲高水位。
      const requestBytes = Buffer.byteLength(input.line, "utf8");
      if (requestBytes > open.requestMaxBytes) {
        throw new Error("cua_node_repl_helper_request_bound_exceeded");
      }
      if (
        requestBytes === 0 ||
        !input.line.endsWith("\n") ||
        input.line.indexOf("\n") !== input.line.length - 1
      ) {
        throw new Error("cua_node_repl_helper_request_frame_invalid");
      }
      const socket = await connectWithTimeout(connectImpl, endpoint, input.signal);
      if (input.signal.aborted) {
        destroyWithError(socket, abortError(input.signal));
        throw abortError(input.signal);
      }
      const abort = () => destroyWithError(socket, abortError(input.signal));
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => destroyWithError(socket, new Error("cua_node_repl_helper_cell_timeout")),
        timeoutMs,
      );
      timer.unref?.();
      let lines: AsyncGenerator<string> | undefined;
      try {
        lines = readBoundedLines(
          socket,
          input.signal,
          open.responseMaxBytes + CUA_HELPER_CELL_CONTROL_MAX_BYTES * 2 + 8,
        );
        await writeWithBackpressure(socket, `${JSON.stringify(open)}\n`);
        const proofLine = await readLine(lines, CUA_HELPER_CELL_CONTROL_MAX_BYTES);
        const proofError = cellErrorFromLine(proofLine);
        if (proofError) throw proofError;
        const proof = parseHelperProofLine(proofLine);
        if (proof.role !== "cell" || proof.challenge !== challenge) {
          throw new Error("cua_node_repl_helper_cell_proof_challenge_mismatch");
        }
        const canonical = transportProofCanonical(
          "cell",
          challenge,
          options.sourceSha256,
          open.requestMaxBytes,
          open.responseMaxBytes,
        );
        if (!verifyHelperTransportProof(key, canonical, proof.proof)) {
          throw new Error("cua_node_repl_helper_cell_proof_invalid");
        }
        if (input.signal.aborted) throw abortError(input.signal);
        const ackLine = await readLine(lines, CUA_HELPER_CELL_CONTROL_MAX_BYTES);
        const ack = parseAck(ackLine);
        if (ack.type === "cell-error") {
          throw new Error(`cua_node_repl_helper_cell_error:${ack.reason}`);
        }
        if (input.signal.aborted) throw abortError(input.signal);
        options.onCellReady?.(ack.cellPid);

        // 中文原因：原 fd3 只需要完整的一行 JSON，cell 不要求 socket EOF。调用
        // end() 会半关整条连接，Helper 会把 CLI 的 FIN 视为断开并 abort 掉仍可能
        // 在执行/返回大响应的 cell。这里只完成本地 request write，不 end 同一 socket。
        await writeWithBackpressure(socket, input.line);
        const responseLine = await readLine(lines, input.responseMaxBytes);
        const helperError = cellErrorFromLine(responseLine);
        if (helperError) throw helperError;
        const response = parseCellResponse(responseLine, input.responseMaxBytes);
        if (response.invocationId !== input.request.invocationId) {
          throw new CellProtocolError("node_repl cell response invocationId mismatch");
        }
        const trailerLine = await readLine(lines, CUA_HELPER_CELL_CONTROL_MAX_BYTES);
        const trailer = parseExit(trailerLine);
        if (!response.ok) {
          const error = new Error(response.error.message);
          error.name = response.error.name;
          if (response.error.stack) error.stack = response.error.stack;
          throw error;
        }
        if (!trailer.reaped) {
          throw new Error("cua_node_repl_helper_cell_cleanup_unknown");
        }
        if (trailer.exitCode !== 0 || trailer.signal !== null) {
          throw new Error(
            `node_repl cell exited with code=${trailer.exitCode ?? "null"}, signal=${
              trailer.signal ?? "null"
            }`,
          );
        }
        return response.result;
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        // 先 destroy 再收尾 iterator：否则 generator 可能仍阻塞在 fd 读取上，
        // await return() 会无限等待。destroy 后 iterator 的 next 必定有界结束。
        socket.destroy();
        // 中文原因：手工 next() 的 async generator 不会自动收尾；显式 return
        // 让内部 for-await 释放 socket 的 iterator/error 监听，避免遗留资源。
        if (lines !== undefined) {
          try {
            await lines.return(undefined);
          } catch {
            // socket 已被 abort/destroy 时 iterator 收尾错误不再覆盖主错误。
          }
        }
      }
    },
  };
}

function assertBound(kind: "request" | "response", value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`cua_node_repl_helper_${kind}_bound_invalid`);
  }
}

function resolveEndpoint(provider: () => string | undefined): string {
  let endpoint: string | undefined;
  try {
    endpoint = provider();
  } catch (cause) {
    throw new Error("cua_node_repl_helper_cell_endpoint_required", { cause });
  }
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new Error("cua_node_repl_helper_cell_endpoint_required");
  }
  if (
    !isAbsolute(endpoint) ||
    endpoint.includes("\0") ||
    Buffer.byteLength(endpoint, "utf8") > MAX_ENDPOINT_BYTES
  ) {
    throw new Error("cua_node_repl_helper_cell_endpoint_invalid");
  }
  return endpoint;
}

function resolveTransportAuthenticationKey(
  provider: (() => string | undefined) | undefined,
): string {
  let key: string | undefined;
  try {
    key = provider?.();
    assertTransportAuthenticationKey(key);
    return key;
  } catch (cause) {
    throw new Error("cua_node_repl_helper_transport_key_required", { cause });
  }
}

async function connectWithTimeout(
  connectImpl: (path: string, signal: AbortSignal) => Promise<Duplex>,
  path: string,
  signal: AbortSignal,
): Promise<Duplex> {
  if (signal.aborted) throw abortError(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("cua_node_repl_helper_cell_connect_timeout")),
    CUA_HELPER_CELL_CONNECT_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const socket = await connectImpl(path, controller.signal);
    if (signal.aborted) {
      destroyWithError(socket, abortError(signal));
      throw abortError(signal);
    }
    return socket;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function connectPrivateEndpoint(path: string, signal: AbortSignal): Promise<Duplex> {
  return await new Promise<Duplex>((resolve, reject) => {
    const socket = createConnection({ path });
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("cua_node_repl_helper_cell_closed"));
    const onAbort = () => finish(abortError(signal));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("The operation was aborted");
}

// 中文原因：destroy(error) 会异步 emit 'error'；调用点可能已没有 listener，
// 必须临时挂一次性 listener，避免 Helper 客户端因未处理事件崩溃。
function destroyWithError(stream: Duplex, error: Error): void {
  stream.once("error", () => undefined);
  stream.destroy(error);
}

async function* readBoundedLines(
  stream: Duplex,
  signal: AbortSignal,
  maxBufferedBytes: number,
): AsyncGenerator<string> {
  const state = { buffer: "", bufferedBytes: 0 };
  const decoder = new StringDecoder("utf8");
  for await (const chunk of stream) {
    if (signal.aborted) throw abortError(signal);
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    yield* splitBoundedLines(state, text, maxBufferedBytes);
  }
  const tail = decoder.end();
  if (tail) yield* splitBoundedLines(state, tail, maxBufferedBytes);
  if (state.buffer.length > 0) {
    throw new Error("cua_node_repl_helper_cell_truncated");
  }
  if (signal.aborted) throw abortError(signal);
}

function* splitBoundedLines(
  state: { buffer: string; bufferedBytes: number },
  text: string,
  maxBufferedBytes: number,
): Generator<string> {
  state.bufferedBytes += Buffer.byteLength(text, "utf8");
  if (state.bufferedBytes > maxBufferedBytes) {
    throw new Error("cua_node_repl_helper_cell_frame_too_large");
  }
  state.buffer += text;
  let newline = state.buffer.indexOf("\n");
  while (newline >= 0) {
    const rawLine = state.buffer.slice(0, newline);
    let line = rawLine;
    state.buffer = state.buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    state.bufferedBytes = Math.max(
      0,
      state.bufferedBytes - Buffer.byteLength(rawLine, "utf8") - 1,
    );
    yield line;
    newline = state.buffer.indexOf("\n");
  }
}

async function readLine(
  iterator: AsyncIterator<string> | Promise<IteratorResult<string>>,
  maxBytes: number,
): Promise<string> {
  const next: IteratorResult<string> =
    typeof (iterator as AsyncIterator<string>).next === "function"
      ? await (iterator as AsyncIterator<string>).next()
      : await (iterator as Promise<IteratorResult<string>>);
  if (next.done === true) {
    throw new Error("cua_node_repl_helper_cell_truncated");
  }
  if (Buffer.byteLength(next.value, "utf8") > maxBytes) {
    throw new Error("cua_node_repl_helper_cell_frame_too_large");
  }
  return next.value;
}

async function writeWithBackpressure(stream: Duplex, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line, "utf8", (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function cellErrorFromLine(line: string): Error | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.type !== "cell-error" ||
    typeof value.reason !== "string"
  ) {
    return undefined;
  }
  return new Error(`cua_node_repl_helper_cell_error:${value.reason}`);
}

type AckFrame =
  | { readonly type: "cell-ready"; readonly cellPid: number }
  | { readonly type: "cell-error"; readonly reason: string };

function parseAck(line: string): AckFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("cua_node_repl_helper_cell_ack_invalid");
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("cua_node_repl_helper_cell_ack_invalid");
  }
  if (value.type === "cell-ready") {
    exactKeys(value, ["schemaVersion", "type", "cellPid"]);
    if (!Number.isSafeInteger(value.cellPid) || (value.cellPid as number) <= 1) {
      throw new Error("cua_node_repl_helper_cell_pid_invalid");
    }
    return { type: "cell-ready", cellPid: value.cellPid as number };
  }
  if (value.type === "cell-error") {
    exactKeys(value, ["schemaVersion", "type", "reason"]);
    if (
      typeof value.reason !== "string" ||
      value.reason.length === 0 ||
      value.reason.length > 256 ||
      hasControlCharacters(value.reason)
    ) {
      throw new Error("cua_node_repl_helper_cell_error_invalid");
    }
    return { type: "cell-error", reason: value.reason };
  }
  throw new Error("cua_node_repl_helper_cell_ack_invalid");
}

interface ExitFrame {
  readonly reaped: boolean;
  readonly exitCode: number | null;
  readonly signal: number | null;
}

function parseExit(line: string): ExitFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("cua_node_repl_helper_cell_exit_invalid");
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.type !== "cell-exit") {
    throw new Error("cua_node_repl_helper_cell_exit_invalid");
  }
  exactKeys(value, ["schemaVersion", "type", "reaped", "exitCode", "signal"]);
  if (typeof value.reaped !== "boolean") {
    throw new Error("cua_node_repl_helper_cell_exit_invalid");
  }
  const exitCode =
    value.exitCode === null
      ? null
      : Number.isSafeInteger(value.exitCode)
        ? (value.exitCode as number)
        : undefined;
  const signal =
    value.signal === null
      ? null
      : Number.isSafeInteger(value.signal)
        ? (value.signal as number)
        : undefined;
  if (exitCode === undefined || signal === undefined) {
    throw new Error("cua_node_repl_helper_cell_exit_invalid");
  }
  return { reaped: value.reaped, exitCode, signal };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error("cua_node_repl_helper_cell_frame_invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
