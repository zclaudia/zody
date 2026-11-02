import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  databaseStartupStateSchema,
  HostMessageTypes,
  HostResponseTypes,
  type DatabaseStartupState,
} from "@zcode/shared";
import type { MessagePortMain } from "electron";
import type { HostInitMessage } from "../src/main/desktopHostProcess.js";
import {
  spawnNativeHostProcess,
  type NativeHostLaunchConfig,
} from "../src/main/nodeHostProcess.js";

/**
 * Diagnostic-only client for the real native Host entry.
 *
 * This does not initialize a fake Host: it waits for the launcher-generated hello,
 * sends the complete existing InitLocal message through fd5, and waits for the existing
 * database/services ready state. A successful hello alone is not considered success.
 */
export interface NativeHostInitProbeOptions {
  nativeHostLaunch: NativeHostLaunchConfig;
  workspacePath: string;
  workspaceIdentity?: string;
  agentSpawnFallbackCwd?: string;
  zcodeBuiltinProviderConfigFilePath: string;
  deviceMid?: string;
  runtimeProcessEnvPatch?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onState?: (state: DatabaseStartupState) => void;
}

export interface NativeHostInitProbeResult {
  hostId: string;
  state: DatabaseStartupState;
  states: DatabaseStartupState[];
  durationMs: number;
}

interface ProbeHostProcess {
  waitForHostId(): Promise<string>;
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
  on(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this;
  off(event: "message" | "exit" | "error", listener: (...args: any[]) => void): this;
  kill(): boolean;
}

export interface NativeHostInitProbeDependencies {
  spawnHost?: (options: Parameters<typeof spawnNativeHostProcess>[0]) => ProbeHostProcess;
}

class ProbeMessagePort extends EventEmitter {
  private closed = false;

  postMessage(_message: unknown): void {}

  start(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

function hostInitMessage(
  options: NativeHostInitProbeOptions,
  hostId: string,
): HostInitMessage {
  return {
    type: HostMessageTypes.InitLocal,
    hostId,
    databaseStartupId: randomUUID(),
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    agentSpawnFallbackCwd: options.agentSpawnFallbackCwd ?? options.workspacePath,
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    ...(options.deviceMid ? { deviceMid: options.deviceMid } : {}),
    ...(options.runtimeProcessEnvPatch
      ? { runtimeProcessEnvPatch: options.runtimeProcessEnvPatch }
      : {}),
  };
}

export async function probeNativeHostInitialization(
  options: NativeHostInitProbeOptions,
  dependencies: NativeHostInitProbeDependencies = {},
): Promise<NativeHostInitProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const states: DatabaseStartupState[] = [];
  const port = new ProbeMessagePort();
  const spawnHost = dependencies.spawnHost ?? spawnNativeHostProcess;
  let host: ProbeHostProcess | undefined;
  let ready = false;
  let exitCode: number | null | undefined;
  let rejectReady!: (error: Error) => void;
  let resolveReady!: (state: DatabaseStartupState) => void;
  let resolveExit!: () => void;
  const readyPromise = new Promise<DatabaseStartupState>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const timeout = setTimeout(() => {
    rejectReady(new Error(`Native Host initialization timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const fail = (error: unknown) => {
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  };
  const onAbort = () => fail(new Error("Native Host initialization was aborted"));
  const onMessage = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== HostResponseTypes.DatabaseStartupState
    ) {
      return;
    }
    const parsed = databaseStartupStateSchema.safeParse(
      (message as { state?: unknown }).state,
    );
    if (!parsed.success) {
      fail(new Error("Native Host emitted an invalid DatabaseStartupState"));
      return;
    }
    states.push(parsed.data);
    options.onState?.(parsed.data);
    if (parsed.data.phase === "failed") {
      fail(
        new Error(
          `Native Host initialization failed at ${parsed.data.failedPhase ?? "unknown"}: ${
            parsed.data.errorCode ?? "unknown"
          }`,
        ),
      );
      return;
    }
    if (parsed.data.phase === "ready" && !ready) {
      ready = true;
      resolveReady(parsed.data);
    }
  };
  const onExit = (code: number | null) => {
    exitCode = code;
    resolveExit();
    if (!ready) fail(new Error(`Native Host exited before initialization (code ${code})`));
  };

  try {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) throw new Error("Native Host initialization was aborted");
    host = spawnHost({
      config: options.nativeHostLaunch,
      label: "cua-host-init-probe",
    });
    host.on("message", onMessage);
    host.on("error", fail);
    host.on("exit", onExit);
    const hostId = await host.waitForHostId();
    host.postMessage(hostInitMessage(options, hostId), [port as unknown as MessagePortMain]);
    const state = await readyPromise;
    host.postMessage({ type: HostMessageTypes.Dispose });
    let disposeTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        disposeTimeout = setTimeout(
          () => reject(new Error("Native Host did not exit after Dispose")),
          timeoutMs,
        );
      }),
    ]);
    if (disposeTimeout) clearTimeout(disposeTimeout);
    if (exitCode !== 0) {
      throw new Error(`Native Host exited after initialization with code ${exitCode}`);
    }
    return { hostId, state, states, durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    port.close();
    if (host && exitCode === undefined) host.kill();
  }
}

function parseProbeArgs(argv: string[]): NativeHostInitProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name?.startsWith("--")) throw new Error(`Unknown argument: ${name ?? ""}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const required = (name: string) => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const launcherPath = required("--launcher");
  const launcherCwd = required("--launcher-cwd");
  const workspacePath = required("--workspace");
  const zcodeBuiltinProviderConfigFilePath = required("--builtin-config");
  if (!isAbsolute(launcherPath) || !isAbsolute(launcherCwd) || !isAbsolute(workspacePath)) {
    throw new Error("--launcher, --launcher-cwd and --workspace must be absolute paths");
  }
  if (!isAbsolute(zcodeBuiltinProviderConfigFilePath)) {
    throw new Error("--builtin-config must be an absolute path");
  }
  const timeout = values.get("--timeout-ms");
  return {
    nativeHostLaunch: { launcherPath, cwd: launcherCwd },
    workspacePath,
    ...(values.get("--workspace-identity")
      ? { workspaceIdentity: values.get("--workspace-identity") }
      : {}),
    ...(values.get("--fallback-cwd")
      ? { agentSpawnFallbackCwd: values.get("--fallback-cwd") }
      : {}),
    ...(values.get("--device-mid") ? { deviceMid: values.get("--device-mid") } : {}),
    zcodeBuiltinProviderConfigFilePath,
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  };
}

const USAGE = `Usage: node --import tsx packages/desktop/scripts/hostInitProbe.ts -- \\
  --launcher <absolute native launcher> \\
  --launcher-cwd <absolute launcher cwd> \\
  --workspace <absolute workspace> \\
  --builtin-config <absolute zcode-builtin.json> \\
  [--workspace-identity <identity>] [--fallback-cwd <absolute path>] \\
  [--device-mid <id>] [--timeout-ms <ms>]`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      process.stdout.write(`${USAGE}\n`);
    } else {
      const result = await probeNativeHostInitialization(parseProbeArgs(process.argv.slice(2)));
      process.stdout.write(
        `${JSON.stringify({ status: "ready", ...result }, null, 2)}\n`,
      );
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        { status: "failed", error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
