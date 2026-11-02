import { spawn as spawnProcess, type ChildProcess, type SpawnOptions } from "node:child_process";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zody/contracts/plugins";
import type {
  ControlChannelAckResult,
  ControlChannelRequest,
  ControlChannelRequestInput,
  ControlChannelRequestResult,
} from "@zody/zody-cua/control-channel";
import type { ControlBinding } from "@zody/zody-cua/control-protocol";

export const ZCODE_NODE_REPL_CONTROL_FLAG = "--zcode-node-repl-control";

const MAX_IDENTIFIER_BYTES = 256;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

const CONTROL_ONLY_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
] as const;

export type ControlOnlyLauncherErrorCode =
  | "invalid_options"
  | "startup_failed"
  | "startup_timeout"
  | "startup_eof"
  | "startup_invalid"
  | "close_timeout"
  | "closed";

export class ControlOnlyLauncherError extends Error {
  readonly code: ControlOnlyLauncherErrorCode;

  constructor(code: ControlOnlyLauncherErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ControlOnlyLauncherError";
    this.code = code;
  }
}

export type ControlOnlyLauncherCloseReason =
  | "startup_failed"
  | "disposed"
  | "local_close"
  | "peer_eof"
  | "transport_closed"
  | "transport_error"
  | "protocol_error"
  | "request_timeout"
  | "child_exit"
  | "close_timeout"
  | "cleanup_failed";

export interface ControlOnlyLauncherClosedEvent {
  readonly reason: ControlOnlyLauncherCloseReason;
  readonly message: string;
  readonly cause: Error | null;
  readonly pendingRequests: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** First-close latch. It is emitted synchronously before cleanup or child exit is awaited. */
export interface ControlOnlyLauncherInvalidatedEvent {
  readonly reason: ControlOnlyLauncherCloseReason;
  readonly message: string;
  readonly cause: Error | null;
}

export interface ControlOnlyLaunchCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export type ControlOnlySpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * 受信 composition 在真实子进程 spawn 之前看到的启动材料面。这里只暴露由
 * createControlOnlyMaterial 本次生成的 producer incarnation，调用方不能替换或另造。
 */
export interface ControlOnlySpawnBinding {
  readonly appIncarnation: string;
  readonly producerIncarnation: string;
}

/**
 * 仅可信 launch 装配使用：返回 false 表示绑定失败，launcher 必须直接失败且不得 spawn。
 * 不能从模型参数、环境变量或公开协议注入。
 */
export type ControlOnlyBeforeSpawn = (binding: ControlOnlySpawnBinding) => boolean;

export interface StartControlOnlyDiagnosticLauncherOptions {
  readonly launch: ControlOnlyLaunchCommand;
  readonly appIncarnation: string;
  readonly onRequest?: (
    request: ControlChannelRequest,
  ) => ControlChannelAckResult | Promise<ControlChannelAckResult>;
  readonly onClosed?: (event: ControlOnlyLauncherClosedEvent) => void | Promise<void>;
  readonly onInvalidated?: (event: ControlOnlyLauncherInvalidatedEvent) => void | Promise<void>;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** 受信 pre-spawn 绑定钩子；失败时不得创建子进程。 */
  readonly beforeSpawn?: ControlOnlyBeforeSpawn;
  /** Trusted test hook; production callers should use the default real spawn. */
  readonly spawn?: ControlOnlySpawn;
}

export interface ControlOnlyDiagnosticLauncher {
  readonly binding: Readonly<ControlBinding>;
  readonly closed: boolean;
  readonly closeReason: ControlOnlyLauncherCloseReason | null;
  request(input: ControlChannelRequestInput): Promise<ControlChannelRequestResult>;
  close(): Promise<void>;
}

export interface OfficialControlOnlyLaunchInput {
  readonly execPath: string;
  readonly serverPath: string;
  /** Optional CLI source entry for development launchers. SEA callers omit it. */
  readonly cliEntryPath?: string;
  /** Arguments before the CLI entry, for example ["--import", tsxLoader]. */
  readonly cliPrefixArgs?: readonly string[];
}

export interface NormalizedControlOnlyOptions {
  readonly appIncarnation: string;
  readonly beforeSpawn?: ControlOnlyBeforeSpawn;
  readonly closeTimeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly launch: Required<Pick<ControlOnlyLaunchCommand, "args" | "command">> &
    Pick<ControlOnlyLaunchCommand, "cwd">;
  readonly onClosed?: StartControlOnlyDiagnosticLauncherOptions["onClosed"];
  readonly onInvalidated?: StartControlOnlyDiagnosticLauncherOptions["onInvalidated"];
  readonly onRequest: NonNullable<StartControlOnlyDiagnosticLauncherOptions["onRequest"]>;
  readonly requestTimeoutMs: number;
  readonly spawn: ControlOnlySpawn;
  readonly startupTimeoutMs: number;
}

function invalidOptions(message: string): never {
  throw new ControlOnlyLauncherError("invalid_options", message);
}

function readBoundedString(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    value.includes("\0")
  ) {
    invalidOptions(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function readTimeout(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    invalidOptions(`${name} must be an integer in ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function readRequestTimeout(value: number | undefined): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    invalidOptions("requestTimeoutMs must be an integer in 1..300000");
  }
  return value;
}

function rejectProducerRequest(request: ControlChannelRequest): ControlChannelAckResult {
  return {
    phase: "rejected",
    facts: {
      projection: { admissionClosed: false, projectionApplied: false },
      revoked: { authorizationRevoked: false },
      stop:
        request.body.payload.operation === "stop"
          ? {
              leaseReleased: false,
              nativeFenced: false,
              ownedInputsReleased: false,
              pending: true,
            }
          : null,
    },
  };
}

export function buildControlOnlyChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const byLower = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") byLower.set(key.toLowerCase(), value);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of CONTROL_ONLY_ENV_ALLOWLIST) {
    const value = byLower.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  if (byLower.get("electron_run_as_node") === "1") env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export function resolveOfficialControlOnlyLauncher(
  input: OfficialControlOnlyLaunchInput,
): ControlOnlyLaunchCommand {
  if (input === null || typeof input !== "object") invalidOptions("launcher input is required");
  const execPath = readBoundedString(input.execPath, "execPath", 4096);
  const serverPath = readBoundedString(input.serverPath, "serverPath", 4096);
  const prefix = input.cliPrefixArgs ?? [];
  if (!Array.isArray(prefix) || prefix.length > 16) {
    invalidOptions("cliPrefixArgs must be a bounded array");
  }
  for (const arg of prefix) readBoundedString(arg, "cliPrefixArgs[]", 4096);
  const cliEntryPath =
    input.cliEntryPath === undefined
      ? undefined
      : readBoundedString(input.cliEntryPath, "cliEntryPath", 4096);
  return {
    args: [
      ...prefix,
      ...(cliEntryPath === undefined ? [] : [cliEntryPath]),
      ZCODE_PLUGIN_HOST_COMMAND,
      serverPath,
      ZCODE_NODE_REPL_CONTROL_FLAG,
    ],
    command: execPath,
  };
}

export function normalizeControlOnlyOptions(
  options: StartControlOnlyDiagnosticLauncherOptions,
): NormalizedControlOnlyOptions {
  if (options === null || typeof options !== "object") invalidOptions("options are required");
  if (options.launch === null || typeof options.launch !== "object") {
    invalidOptions("launch is required");
  }
  const command = readBoundedString(options.launch.command, "launch.command", 4096);
  const args = options.launch.args;
  if (!Array.isArray(args) || args.length > 64) {
    invalidOptions("launch.args must be a bounded array");
  }
  for (const arg of args) readBoundedString(arg, "launch.args[]", 4096);
  if (options.launch.cwd !== undefined) {
    readBoundedString(options.launch.cwd, "launch.cwd", 4096);
  }
  const appIncarnation = readBoundedString(
    options.appIncarnation,
    "appIncarnation",
    MAX_IDENTIFIER_BYTES,
  );
  if (options.onRequest !== undefined && typeof options.onRequest !== "function") {
    invalidOptions("onRequest must be a function");
  }
  if (options.onClosed !== undefined && typeof options.onClosed !== "function") {
    invalidOptions("onClosed must be a function");
  }
  if (options.onInvalidated !== undefined && typeof options.onInvalidated !== "function") {
    invalidOptions("onInvalidated must be a function");
  }
  if (options.spawn !== undefined && typeof options.spawn !== "function") {
    invalidOptions("spawn must be a function");
  }
  if (options.beforeSpawn !== undefined && typeof options.beforeSpawn !== "function") {
    invalidOptions("beforeSpawn must be a function");
  }
  return {
    appIncarnation,
    ...(options.beforeSpawn === undefined ? {} : { beforeSpawn: options.beforeSpawn }),
    closeTimeoutMs: readTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "closeTimeoutMs"),
    env: options.env ?? process.env,
    launch: {
      args: [...args],
      command,
      ...(options.launch.cwd === undefined ? {} : { cwd: options.launch.cwd }),
    },
    onClosed: options.onClosed,
    onInvalidated: options.onInvalidated,
    onRequest: options.onRequest ?? rejectProducerRequest,
    requestTimeoutMs: readRequestTimeout(options.requestTimeoutMs),
    spawn: options.spawn ?? spawnProcess,
    startupTimeoutMs: readTimeout(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    ),
  };
}
