import { createReadStream, createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import type { RunZCodeProtocolAgentOptions } from "@zcode/bootstrap";

export const CUA_LAUNCH_ENTRY_NAMES = [
  "host-entry.mjs",
  "cli-entry.mjs",
  "session-entry.mjs",
] as const;

export type CuaLaunchEntryName = (typeof CUA_LAUNCH_ENTRY_NAMES)[number];

export interface CuaLaunchSessionReady {
  /** native 与 CLI 的唯一首帧协议版本；未知版本必须整帧拒绝。 */
  readonly schemaVersion: 1;
  readonly type: "session-ready";
  readonly entryName: CuaLaunchEntryName;
  readonly authorityEndpoint: string;
  readonly nodePid: number;
  readonly entrySha256: string;
  readonly producerIncarnation: string;
  readonly captureRoot: string;
}

export interface CuaLaunchSessionOptions {
  readonly entryName: CuaLaunchEntryName;
  /** fd3：native 私有控制流；首帧必须是 session-ready。 */
  readonly control: NodeJS.ReadableStream | number;
  /** fd6：CLI app-server 输入。 */
  readonly input: NodeJS.ReadableStream | number;
  /** fd7：CLI app-server 输出。 */
  readonly output: NodeJS.WritableStream | number;
  /** 仅由外层可信 composition 注入；默认不从 sealed JS 自报事实推导认证。 */
  readonly expectedEntrySha256?: string;
  readonly runProtocolAgent?: (options?: RunZCodeProtocolAgentOptions) => Promise<void>;
  readonly connectAuthority?: (endpoint: string, signal?: AbortSignal) => Promise<Duplex>;
  /**
   * 由 native cli-entry 从 @zcode/node-repl-host 公开入口显式注入；不读取 env/argv。
   * 缺省时仍是普通 protocol app，不装配真实 node_repl 截图。
   */
  readonly cuaNodeReplMcpPortFactory?: RunZCodeProtocolAgentOptions["cuaNodeReplMcpPortFactory"];
}

const MAX_SESSION_READY_BYTES = 16 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_PRODUCER_BYTES = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CUA_LAUNCH_ENTRY_NAME_SET = new Set<string>(CUA_LAUNCH_ENTRY_NAMES);
const READY_KEYS = new Set([
  "schemaVersion",
  "type",
  "entryName",
  "authorityEndpoint",
  "nodePid",
  "entrySha256",
  "producerIncarnation",
  "captureRoot",
]);

export async function runCuaLaunchSession(options: CuaLaunchSessionOptions): Promise<void> {
  if (!CUA_LAUNCH_ENTRY_NAMES.includes(options.entryName)) {
    throw new Error("fault.cua_launch.entry_not_allowlisted");
  }
  if (options.expectedEntrySha256 !== undefined && !SHA256_HEX.test(options.expectedEntrySha256)) {
    throw new Error("fault.cua_launch.expected_entry_sha_invalid");
  }
  const control = asReadable(options.control, "control");
  const line = await readFirstControlLine(control);
  // 首帧解析器会移除 data/error listener；必须立刻建立存活监听，覆盖随后所有
  // captureRoot 校验、模块加载和 protocol 启动 await，避免原生控制端先死却无人观察。
  const controlLifetime = createControlLifetime(control);
  try {
    const ready = parseCuaLaunchSessionReady(line);
    if (ready.nodePid !== process.pid) throw new Error("fault.cua_launch.pid_mismatch");
    if (ready.entryName !== options.entryName) {
      throw new Error("fault.cua_launch.entry_name_mismatch");
    }
    if (
      options.expectedEntrySha256 !== undefined &&
      ready.entrySha256 !== options.expectedEntrySha256
    ) {
      throw new Error("fault.cua_launch.entry_sha_mismatch");
    }
    await assertPrivateCaptureRoot(ready.captureRoot);
    const runProtocolAgent = options.runProtocolAgent ?? (await loadProtocolAgent());
    const connectAuthority = options.connectAuthority ?? connectAuthoritySocket;
    // session-ready 之后 fd3 仍是本次 sealed Node 的存活控制面；无论首帧何时完成，
    // EOF/error/close 都必须触发同一 protocol lifecycle 的取消和资源清理。
    controlLifetime.throwIfFailed();
    await runProtocolAgent({
      lifecycle: controlLifetime.lifecycle,
      input: asReadable(options.input, "input"),
      output: asWritable(options.output, "output"),
      // sealed CLI entry 固定属于 Desktop Host；不能退回 terminal 默认值。
      presentationSurface: "zcode_desktop",
      cuaNativeCapture: {
        connect: (signal) => connectAuthority(ready.authorityEndpoint, signal),
        producerIncarnation: ready.producerIncarnation,
        captureRoot: ready.captureRoot,
      },
      ...(options.cuaNodeReplMcpPortFactory
        ? { cuaNodeReplMcpPortFactory: options.cuaNodeReplMcpPortFactory }
        : {}),
    });
  } finally {
    controlLifetime.dispose();
  }
}

/** sealed launcher 直接传 fd3/fd6/fd7；只接受显式数字 fd，不读取 env/argv。 */
function asReadable(value: NodeJS.ReadableStream | number, name: string): NodeJS.ReadableStream {
  if (typeof value !== "number") return value;
  assertFd(value, name);
  return createReadStream("", { fd: value, autoClose: false });
}

function asWritable(value: NodeJS.WritableStream | number, name: string): NodeJS.WritableStream {
  if (typeof value !== "number") return value;
  assertFd(value, name);
  return createWriteStream("", { fd: value, autoClose: false });
}

function assertFd(fd: number, name: string): void {
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new Error(`fault.cua_launch.${name}_fd_invalid`);
  }
}

export function parseCuaLaunchSessionReady(line: string): CuaLaunchSessionReady {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("fault.cua_launch.session_ready_invalid");
  }
  if (!isObject(value) || Object.keys(value).some((key) => !READY_KEYS.has(key))) {
    throw new Error("fault.cua_launch.session_ready_invalid");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("fault.cua_launch.schema_version_unsupported");
  }
  if (value.type !== "session-ready") throw new Error("fault.cua_launch.session_ready_invalid");
  if (typeof value.entryName !== "string" || !CUA_LAUNCH_ENTRY_NAME_SET.has(value.entryName)) {
    throw new Error("fault.cua_launch.entry_name_invalid");
  }
  if (!isBoundedPath(value.authorityEndpoint) || !isAbsolute(value.authorityEndpoint)) {
    throw new Error("fault.cua_launch.authority_endpoint_invalid");
  }
  if (!isBoundedPath(value.captureRoot) || !isAbsolute(value.captureRoot)) {
    throw new Error("fault.cua_launch.capture_root_invalid");
  }
  const nodePid = value.nodePid;
  if (!Number.isSafeInteger(nodePid) || Number(nodePid) <= 0) {
    throw new Error("fault.cua_launch.session_ready_invalid");
  }
  if (typeof value.entrySha256 !== "string" || !SHA256_HEX.test(value.entrySha256)) {
    throw new Error("fault.cua_launch.session_ready_invalid");
  }
  if (!isBoundedProducer(value.producerIncarnation)) {
    throw new Error("fault.cua_launch.session_ready_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    type: "session-ready",
    entryName: value.entryName as CuaLaunchEntryName,
    authorityEndpoint: value.authorityEndpoint,
    nodePid: nodePid as number,
    entrySha256: value.entrySha256,
    producerIncarnation: value.producerIncarnation,
    captureRoot: value.captureRoot,
  });
}

async function assertPrivateCaptureRoot(root: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(root);
  } catch {
    throw new Error("fault.cua_launch.capture_root_unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("fault.cua_launch.capture_root_invalid");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("fault.cua_launch.capture_root_not_private");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("fault.cua_launch.capture_root_owner_mismatch");
  }
}

async function connectAuthoritySocket(endpoint: string, signal?: AbortSignal): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ path: endpoint });
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
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
    const onClose = () => finish(new Error("fault.cua_launch.authority_closed"));
    const onAbort = () => finish(new DOMException("The operation was aborted", "AbortError"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function loadProtocolAgent(): Promise<
  (options?: RunZCodeProtocolAgentOptions) => Promise<void>
> {
  const module = await import("@zcode/bootstrap");
  return module.runZCodeProtocolAgent;
}

interface CuaControlLifetime {
  readonly lifecycle: NonNullable<RunZCodeProtocolAgentOptions["lifecycle"]>;
  throwIfFailed(): void;
  dispose(): void;
}

function createControlLifetime(control: NodeJS.ReadableStream): CuaControlLifetime {
  const controller = new AbortController();
  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    if (!controller.signal.aborted) controller.abort(failure);
  };
  // 首帧解析器会移除自己的 data listener；保留一个 drain listener，确保 fd3 继续流入
  // 并能在后续 EOF/error/close 时及时报告原生端死亡。
  const drain = () => undefined;
  const onEnd = () => stop(new Error("fault.cua_launch.control_eof"));
  const onClose = () => stop(new Error("fault.cua_launch.control_closed"));
  const onError = (cause: unknown) =>
    stop(new Error("fault.cua_launch.control_error", { cause }));
  control.on("data", drain);
  control.once("end", onEnd);
  control.once("close", onClose);
  control.once("error", onError);
  const ended = control as NodeJS.ReadableStream & {
    readonly readableEnded?: boolean;
    readonly destroyed?: boolean;
  };
  if (ended.readableEnded) onEnd();
  else if (ended.destroyed) onClose();

  return {
    lifecycle: {
      signal: controller.signal,
      deadlineAt: undefined,
      requestShutdown(error?: Error) {
        if (error) stop(error);
        else if (!controller.signal.aborted) {
          controller.abort(new Error("fault.cua_launch.control_shutdown"));
        }
      },
    },
    throwIfFailed() {
      if (failure) throw failure;
    },
    dispose() {
      control.removeListener("data", drain);
      control.removeListener("end", onEnd);
      control.removeListener("close", onClose);
      control.removeListener("error", onError);
    },
  };
}

async function readFirstControlLine(control: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const cleanup = () => {
      control.removeListener("data", onData);
      control.removeListener("end", onEnd);
      control.removeListener("error", onError);
    };
    const finish = (error?: Error, line?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(line!);
    };
    const onData = (chunk: string | Buffer) => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(buffered, "utf8") > MAX_SESSION_READY_BYTES) {
        finish(new Error("fault.cua_launch.session_ready_too_large"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline).trim();
      if (!line) finish(new Error("fault.cua_launch.session_ready_invalid"));
      else finish(undefined, line);
    };
    const onEnd = () => finish(new Error("fault.cua_launch.session_ready_eof"));
    const onError = () => finish(new Error("fault.cua_launch.control_error"));
    control.on("data", onData);
    control.once("end", onEnd);
    control.once("error", onError);
  });
}

function isBoundedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
  );
}

function isBoundedProducer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_PRODUCER_BYTES
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
