/* eslint-disable max-lines -- Host process transport keeps frame validation, port ownership and exit cleanup in one state machine. */
import { fork, spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type { Duplex } from "node:stream";
import type { MessagePortMain } from "electron";
import type { HostProcessHandle } from "./hostProcessHandle.js";
import {
  MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL,
  NODE_HOST_BRIDGE_PROTOCOL_VERSION,
  isNodeHostBridgeFrame,
  normalizeNodeHostBridgeData,
  type NodeHostBridgeChannel,
  type NodeHostBridgeFrame,
} from "../common/nodeHostBridgeProtocol.js";
import {
  createLengthPrefixedV8Channel,
  createProcessIpcChannel,
} from "../common/nodeHostBridgeTransport.js";

/** Native launcher contract: host entry name is fixed; fd5 is the bridge duplex. */
export const NATIVE_HOST_ENTRY_NAME = "host-entry.mjs" as const;
export const NATIVE_HOST_BRIDGE_FD = 5;
const MAX_BRIDGE_PORT_ID = Number.MAX_SAFE_INTEGER;

/** Explicit native launcher transport mode. It is not an authorization result. */
export type NativeHostLaunchMode = "direct" | "workspace-relay";

export interface NodeHostChildLike extends EventEmitter {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface NodeHostProcessLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

interface BridgedPortRecord {
  readonly portId: number;
  readonly port: MessagePortMain;
  readonly onMessage: (event: { data: unknown }) => void;
  readonly onClose: () => void;
  closed: boolean;
}

/** Trusted native launcher spawn config. It is wiring, not an OS verification result. */
export interface NativeHostLaunchConfig {
  /**
   * Absolute path of the native executable that verifies signed resources.
   * The launcher must still check the Node pid/audit token and fixed entry identity;
   * this config object is not authorization.
   */
  readonly launcherPath: string;
  readonly cwd: string;
  readonly entryName?: typeof NATIVE_HOST_ENTRY_NAME;
  readonly bridgeFd?: number;
  /**
   * `workspace-relay` asks the native launcher to start the Host through the
   * LaunchServices workspace relation. Default `direct` keeps the existing argv.
   */
  readonly launchMode?: NativeHostLaunchMode;
  readonly env?: Readonly<Record<string, string>>;
}

/** Generic IPC-fork config used only as a transport fixture in tests/dev. */
export interface NodeHostLaunchConfig {
  readonly execPath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function assertAbsolutePath(path: string, field: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${field} must be an absolute path, got: ${path}`);
  }
}

function assertNoElectronRunAsNode(
  env: Readonly<Record<string, string>> | undefined,
  context: string,
): void {
  if (env && Object.prototype.hasOwnProperty.call(env, "ELECTRON_RUN_AS_NODE")) {
    throw new Error(`${context} must not set ELECTRON_RUN_AS_NODE`);
  }
}

function assertBridgeFd(fd: number, field: string): void {
  if (!Number.isInteger(fd) || fd < 3 || fd > 1_024) {
    throw new Error(`${field} must be an fd between 3 and 1024, got: ${fd}`);
  }
}

function assertNativeHostLaunchMode(mode: NativeHostLaunchMode | undefined): void {
  if (mode !== undefined && mode !== "direct" && mode !== "workspace-relay") {
    throw new Error(`nativeHost.launchMode must be direct or workspace-relay, got: ${mode}`);
  }
}

function inheritedEnvWithoutElectronRunAsNode(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function assertNativeHostLaunchConfig(config: NativeHostLaunchConfig): void {
  assertAbsolutePath(config.launcherPath, "nativeHost.launcherPath");
  assertAbsolutePath(config.cwd, "nativeHost.cwd");
  if (config.entryName !== undefined && config.entryName !== NATIVE_HOST_ENTRY_NAME) {
    throw new Error(
      `nativeHost.entryName must be ${NATIVE_HOST_ENTRY_NAME}, got: ${config.entryName}`,
    );
  }
  assertBridgeFd(config.bridgeFd ?? NATIVE_HOST_BRIDGE_FD, "nativeHost.bridgeFd");
  assertNativeHostLaunchMode(config.launchMode);
  assertNoElectronRunAsNode(config.env, "nativeHost.env");
}

export function assertNodeHostLaunchConfig(config: NodeHostLaunchConfig): void {
  assertAbsolutePath(config.execPath, "nodeHost.execPath");
  assertAbsolutePath(config.entryPath, "nodeHost.entryPath");
  assertAbsolutePath(config.cwd, "nodeHost.cwd");
  assertNoElectronRunAsNode(config.env, "nodeHost.env");
}

/**
 * Host child adapter shared by the native fd transport and the IPC-fork fixture path.
 *
 * Electron MessagePortMain cannot be transferred over either transport, so Main keeps
 * each renderer-facing port and forwards payloads as ordered port-data frames keyed by a
 * numeric id. The Host reconstructs a surrogate port on its side.
 */
export class NodeHostProcess extends EventEmitter implements HostProcessHandle {
  private readonly ports = new Map<number, BridgedPortRecord>();
  private readonly registeredPorts = new WeakSet<object>();
  private readonly hostIdPromise: Promise<string>;
  private resolveHostId!: (hostId: string) => void;
  private rejectHostId!: (error: Error) => void;
  private adoptedHostId: string | undefined;
  private nextPortId = 0;
  private exited = false;
  private failed = false;

  constructor(
    private readonly child: NodeHostChildLike,
    options: {
      channel: NodeHostBridgeChannel;
      hostId?: string;
      logger?: NodeHostProcessLogger;
    },
  ) {
    super();
    this.logger = options.logger;
    this.channel = options.channel;
    this.hostIdPromise = new Promise<string>((resolve, reject) => {
      this.resolveHostId = resolve;
      this.rejectHostId = reject;
    });
    // A caller that never waits for identity must not trigger an unhandled rejection.
    void this.hostIdPromise.catch(() => undefined);
    if (options.hostId?.trim()) {
      this.adoptHostId(options.hostId.trim());
    }

    options.channel.onFrame((frame) => this.handleFrame(frame));
    options.channel.onClose((error) => this.handleTransportClose(error));
    child.on("error", (error: Error) => {
      this.emitError(error);
      this.closeAllPorts();
    });
    child.on("disconnect", () => this.closeAllPorts());
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      this.rejectHostId(new Error("Node Host exited before announcing its hostId"));
      this.closeAllPorts();
      try {
        options.channel.close();
      } catch {
        // best-effort transport teardown
      }
      this.emit("exit", code ?? (signal ? 1 : 0));
    });
  }

  private readonly channel: NodeHostBridgeChannel;
  private readonly logger?: NodeHostProcessLogger;

  get pid(): number | undefined {
    return this.child.pid;
  }

  get stdout(): NodeJS.ReadableStream | null {
    return this.child.stdout;
  }

  get stderr(): NodeJS.ReadableStream | null {
    return this.child.stderr;
  }

  get hostId(): string | undefined {
    return this.adoptedHostId;
  }

  waitForHostId(): Promise<string> {
    return this.hostIdPromise;
  }

  postMessage(message: unknown, transfer?: MessagePortMain[]): void {
    if (this.exited || this.failed) {
      throw new Error("Node Host process is not running");
    }
    const transferredPorts = transfer ?? [];
    if (transferredPorts.length > MAX_NODE_HOST_BRIDGE_PORTS_PER_CONTROL) {
      throw new Error("Too many MessagePortMain objects transferred to the Node Host bridge");
    }
    const seen = new Set<object>();
    for (const port of transferredPorts) {
      if (seen.has(port)) {
        throw new Error("A MessagePortMain was duplicated within one transfer");
      }
      if (this.registeredPorts.has(port)) {
        throw new Error("MessagePortMain was already transferred to the Node Host bridge");
      }
      seen.add(port);
    }
    const portIds: number[] = [];
    for (const port of transferredPorts) {
      portIds.push(this.registerPort(port));
    }
    this.sendFrame({
      v: NODE_HOST_BRIDGE_PROTOCOL_VERSION,
      kind: "control",
      message,
      portIds,
    });
    if (this.exited || this.failed) return;
    // Start only after the control frame is queued; this preserves control-before-data order.
    for (const port of transferredPorts) {
      port.start();
    }
  }

  kill(): boolean {
    if (this.exited) return false;
    return this.child.kill("SIGTERM");
  }

  private adoptHostId(hostId: string): void {
    if (this.adoptedHostId) {
      if (this.adoptedHostId !== hostId) {
        this.protocolFailure("Node Host announced a conflicting hostId", {
          expected: this.adoptedHostId,
          received: hostId,
        });
      }
      return;
    }
    this.adoptedHostId = hostId;
    this.resolveHostId(hostId);
  }

  private registerPort(port: MessagePortMain): number {
    if (this.registeredPorts.has(port)) {
      throw new Error("MessagePortMain was already transferred to the Node Host bridge");
    }
    const portId = this.nextPortId;
    this.nextPortId += 1;
    if (this.nextPortId > MAX_BRIDGE_PORT_ID) {
      throw new Error("Node Host bridge port id exhausted");
    }
    const record: BridgedPortRecord = {
      portId,
      port,
      onMessage: (event: { data: unknown }) => {
        if (record.closed) return;
        this.sendFrame({
          v: NODE_HOST_BRIDGE_PROTOCOL_VERSION,
          kind: "port-data",
          portId,
          data: normalizeNodeHostBridgeData(event.data),
        });
      },
      onClose: () => {
        if (record.closed) return;
        record.closed = true;
        this.ports.delete(portId);
        this.sendFrame({ v: NODE_HOST_BRIDGE_PROTOCOL_VERSION, kind: "port-close", portId });
      },
      closed: false,
    } satisfies BridgedPortRecord;
    port.on("message", record.onMessage);
    port.on("close", record.onClose);
    this.registeredPorts.add(port);
    this.ports.set(portId, record);
    return portId;
  }

  private handleFrame(raw: unknown): void {
    if (this.exited || this.failed) return;
    if (!isNodeHostBridgeFrame(raw)) {
      this.protocolFailure("Invalid Node Host bridge frame");
      return;
    }
    switch (raw.kind) {
      case "hello":
        this.adoptHostId(raw.hostId.trim());
        return;
      case "control":
        if (raw.portIds.length > 0) {
          this.protocolFailure("Host must not transfer ports back to Main");
          return;
        }
        this.emit("message", raw.message);
        return;
      case "port-data": {
        const record = this.ports.get(raw.portId);
        if (!record || record.closed) {
          this.protocolFailure("Node Host sent data for an unknown or closed port", {
            portId: raw.portId,
          });
          return;
        }
        try {
          record.port.postMessage(raw.data);
        } catch (error) {
          this.emitError(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      case "port-close": {
        const record = this.ports.get(raw.portId);
        if (!record || record.closed) {
          this.protocolFailure("Node Host closed an unknown or already closed port", {
            portId: raw.portId,
          });
          return;
        }
        this.closePort(record, { closeElectronPort: true });
        return;
      }
      case "error": {
        const error = new Error(raw.message);
        if (raw.portId === undefined) {
          this.emitError(error);
          return;
        }
        const record = this.ports.get(raw.portId);
        if (!record || record.closed) {
          this.protocolFailure("Node Host errored an unknown or closed port", {
            portId: raw.portId,
          });
          return;
        }
        this.closePort(record, { closeElectronPort: true });
        this.emitError(error);
        return;
      }
      case "port-ready":
        return;
      default:
        this.protocolFailure("Unexpected Node Host bridge frame");
        return;
    }
  }

  private closePort(
    record: BridgedPortRecord,
    options: { closeElectronPort: boolean },
  ): void {
    if (record.closed) return;
    record.closed = true;
    this.ports.delete(record.portId);
    record.port.off("message", record.onMessage);
    record.port.off("close", record.onClose);
    if (!options.closeElectronPort) return;
    try {
      record.port.close();
    } catch {
      // The renderer already tore the port down.
    }
  }

  private sendFrame(frame: NodeHostBridgeFrame): void {
    if (this.exited || this.failed) {
      throw new Error("Node Host process is not running");
    }
    try {
      this.channel.send(frame);
    } catch (error) {
      this.protocolFailure(
        "Node Host bridge send failed",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handleTransportClose(error?: Error): void {
    if (this.exited || this.failed) return;
    this.failed = true;
    this.closeAllPorts();
    if (error) this.emitError(error);
    this.child.kill("SIGTERM");
  }

  private protocolFailure(message: string, details?: unknown): void {
    if (this.exited || this.failed) return;
    this.failed = true;
    this.logger?.warn(message, details);
    this.emitError(new Error(message));
    this.closeAllPorts();
    try {
      this.channel.close();
    } catch {
      // best-effort transport teardown
    }
    this.child.kill("SIGTERM");
  }

  private closeAllPorts(): void {
    for (const record of this.ports.values()) {
      this.closePort(record, { closeElectronPort: true });
    }
    this.ports.clear();
  }

  private emitError(error: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
      return;
    }
    this.logger?.error("Node Host transport error", error);
  }
}

/**
 * Spawns the native launcher with the fixed Host contract:
 * `--launch-session --entry-name host-entry.mjs --host-fd 5`.
 *
 * Trust (signature/audit-token/entry whitelist) is established by the native launcher,
 * not by this config object. Main only transports frames over fd5.
 */
export function spawnNativeHostProcess(options: {
  config: NativeHostLaunchConfig;
  label: string;
  logger?: NodeHostProcessLogger;
  expectedHostId?: string;
}): NodeHostProcess {
  const config = options.config;
  assertNativeHostLaunchConfig(config);
  const bridgeFd = config.bridgeFd ?? NATIVE_HOST_BRIDGE_FD;
  const stdio: StdioOptions = Array.from({ length: bridgeFd + 1 }, (_, index) => {
    if (index === 1 || index === 2 || index === bridgeFd) return "pipe";
    return "ignore";
  });
  const child = spawn(
    config.launcherPath,
    buildNativeHostLaunchArgs(config),
    {
      cwd: config.cwd,
      env: {
        ...inheritedEnvWithoutElectronRunAsNode(),
        ...config.env,
        ZCODE_PROCESS_LABEL: options.label,
      },
      stdio,
      windowsHide: true,
    },
  );
  return attachBridgeToChild(child, child.stdio[bridgeFd], {
    hostId: options.expectedHostId,
    logger: options.logger,
    field: "nativeHost.bridgeFd",
  });
}

/**
 * Fixed native Host argv. `direct` is byte-for-byte the pre-relay contract;
 * only the explicit workspace relay mode appends its launcher flag.
 */
export function buildNativeHostLaunchArgs(config: NativeHostLaunchConfig): string[] {
  const args = [
    "--launch-session",
    "--entry-name",
    config.entryName ?? NATIVE_HOST_ENTRY_NAME,
    "--host-fd",
    String(config.bridgeFd ?? NATIVE_HOST_BRIDGE_FD),
  ];
  if (config.launchMode === "workspace-relay") {
    args.push("--launch-via-workspace");
  }
  return args;
}

/** IPC-fork variant for transport tests; it is not a trust or candidate assembly path. */
export function spawnNodeHostProcess(options: {
  config: NodeHostLaunchConfig;
  label: string;
  logger?: NodeHostProcessLogger;
  expectedHostId?: string;
}): NodeHostProcess {
  assertNodeHostLaunchConfig(options.config);
  const child = fork(options.config.entryPath, [...(options.config.args ?? [])], {
    execPath: options.config.execPath,
    cwd: options.config.cwd,
    env: {
      ...inheritedEnvWithoutElectronRunAsNode(),
      ...options.config.env,
      ZCODE_PROCESS_LABEL: options.label,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
  });
  return new NodeHostProcess(child, {
    channel: createProcessIpcChannel(child),
    ...(options.expectedHostId ? { hostId: options.expectedHostId } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function attachBridgeToChild(
  child: ChildProcess,
  stream: NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined,
  options: { hostId?: string; logger?: NodeHostProcessLogger; field: string },
): NodeHostProcess {
  if (
    !stream ||
    typeof (stream as Duplex).write !== "function" ||
    typeof (stream as Duplex).on !== "function"
  ) {
    child.kill("SIGTERM");
    throw new Error(`${options.field} did not produce a duplex stream`);
  }
  return new NodeHostProcess(child, {
    channel: createLengthPrefixedV8Channel(stream as Duplex),
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
