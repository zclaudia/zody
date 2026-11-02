import { localRuntimeNetworkCapture } from "#src/zody-agent/localRuntimeNetworkCapture.js";
import { resolveZCodeAgentSpawnCwd } from "#src/zody-agent/zcodeAgentSpawnCwd.js";
import type { ZCodeAgentStorageStartupSnapshot } from "#src/zody-agent/zcodeAgent.js";
/* eslint-disable max-lines -- zcodeAgentProcessManager 集中维护 agent 子进程启动、复用、超时回收和 runtime identity，拆分会扩大进程生命周期状态同步面 */
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { Emitter } from "@zody/rpc";
import { GEN_UI_OUTPUT_DIRECTORY, GEN_UI_OUTPUT_ROOT_ENV } from "@zody/shared/node";
import { getAppConfigDir } from "../paths.js";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zody/shared/process-diagnostic";
import {
  ZCODE_AGENT_RUNTIME,
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveWorkspaceKey,
  resolveZodyRuntimeEnv,
  sanitizeZodyRuntimeEnv,
  zcodeProtocolMethods,
  zcodeRuntimeIdentityInitializeResultSchema,
} from "@zody/shared";
import type { ModelSelection } from "@zody/shared";
import {
  findZCodeAgentRuntimeBinary,
  findZCodeAgentRuntimeNodeBundle,
} from "../runtime-tools/providerRuntimeResolver.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import { ZCodeStdioTransport, type ZCodeStdioChildLike } from "./zcodeStdioTransport.js";
import { readZCodeStdioTapDevState } from "./zcodeStdioTapDevConfig.js";
import { parseCuaNativeAuditLine } from "./cuaNativeAuditLog.js";
import type { ZCodeAgentPresentationSurface } from "./zcodeAgentPresentationSurface.js";
import { shouldSpawnInDetachedProcessGroup } from "../process/processTreeTerminator.js";
import type { RuntimeProcessLifecycleReporter } from "../process/runtimeProcessLifecycle.js";
import { buildAgentWorkspaceIdentityEnv } from "../runtime-tools/agentProxyEnv.js";

export interface ZodyAgentCommand {
  /** 本地配套 CLI bundle 的存储专用 Worker 入口；远端/自定义命令不推断能力。 */
  storagePreparationEntry?: string;
  /** 本次部署的 Agent 支持迁移前的启动通知；旧自定义命令保持原协议。 */
  supportsStorageStartup?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Native CLI launcher supplies its protocol on dedicated fds instead of stdio 0/1. */
  stdio?: StdioOptions;
  stdioIndexes?: { stdin: number; stdout: number; stderr?: number };
  /** Explicit native launcher commands must never be wrapped by the dev Node proxy. */
  nativeLauncher?: boolean;
}

/**
 * Fixed native CLI launcher configuration supplied by trusted composition.
 *
 * This is wiring, not an OS trust proof. The native launcher verifies the signed CLI
 * entry and audit token; this object only tells the Host how to invoke it.
 */
export interface ZodyAgentNativeRuntimeConfig {
  /** Absolute path of the native launcher that verifies signed resources. */
  readonly launcherPath: string;
  readonly entryName?: "cli-entry.mjs";
  /** Native protocol fds; defaults 6/7. */
  readonly cliInFd?: number;
  readonly cliOutFd?: number;
  /** Default direct keeps the existing argv; workspace-relay adds the fixed launcher flag. */
  readonly launchMode?: "direct" | "workspace-relay";
  readonly env?: Readonly<Record<string, string>>;
}

export interface ZodyAgentCommandResolverContext {
  presentationSurface?: ZCodeAgentPresentationSurface;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export type ZodyAgentCommandResolver = (
  context: ZodyAgentCommandResolverContext,
) => Promise<ZodyAgentCommand | null> | ZodyAgentCommand | null;

/**
 * Host-owned startup facts read from the existing provider/model/settings services.
 * Provider/network values are normalized summaries, not credentials or task-time overrides.
 */
export interface ZodyAgentNativeRuntimeStartupContext {
  readonly providerRevisionSha256: string;
  readonly selection: ModelSelection | null;
  readonly network: {
    readonly httpProxy?: string | null;
    readonly noProxy?: string | null;
    readonly caCertPath?: string | null;
  };
}

export interface ZCodeAgentNativeRuntimeResolverContext {
  /** Called for every new Agent spawn; the Host must re-read current service facts. */
  readonly readStartupContext: () => Promise<ZodyAgentNativeRuntimeStartupContext>;
}

/**
 * Selects the native CLI launcher for a specific spawn context.
 *
 * Returning `null` is the normal fallback: the manager keeps its original command
 * resolver, so non-eligible local/remote workspaces never enter the native path.
 * This is routing, not an authorization or trust proof.
 */
export type ZCodeAgentNativeRuntimeResolver = (
  context: ZodyAgentCommandResolverContext,
  runtimeContext?: ZCodeAgentNativeRuntimeResolverContext,
) => Promise<ZodyAgentNativeRuntimeConfig | null> | ZodyAgentNativeRuntimeConfig | null;

export interface ZodyAgentProcessManagerOptions {
  commandResolver?: ZodyAgentCommandResolver;
  /** Trusted composition injects this to bypass PATH/env command discovery. */
  nativeRuntime?: ZodyAgentNativeRuntimeConfig;
  /**
   * Optional per-workspace native-runtime selector. Only a non-null result overrides
   * the original resolver; otherwise the existing command resolution is preserved.
   */
  nativeRuntimeResolver?: ZCodeAgentNativeRuntimeResolver;
  presentationSurface?: ZCodeAgentPresentationSurface;
  requestTimeoutMs?: number;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  /**
   * 进程泳道标识。同一 workspace 的不同泳道各走独立 manager 实例；lane 会写入
   * runtimeIdentity 与 spawn/exit 日志，便于排障区分。
   * 缺省为 chat 主泳道，不追加任何标记。
   */
  lane?: string;
  /**
   * 空闲回收阈值：连接上没有请求在飞持续超过该时长，就主动回收整棵进程树，
   * 下次 getClient 透明重新拉起。只给 mcp-status 这类“按需探测、进程内挂着 MCP 子进程”
   * 的控制面 lane 使用；chat / plugin 缺省不回收。
   */
  idleTimeoutMs?: number;
  /**
   * 仅当默认进程 cwd 等于目标 workspace 且该目录不可用时使用。
   * 业务 workspacePath/workspaceKey 不随 cwd 兜底改变。
   */
  spawnFallbackCwd?: string;
  /**
   * 每次 spawn agent 子进程前解析的额外环境变量（在 process.env 之后、workspace 变量之前合入）。
   * 用于把设置页的代理等配置注入子进程；按 spawn 时读取，天然「下次启动生效」。
   *
   * context 携带本次 spawn 的 workspace 标识三元组（workspacePath/workspaceIdentity/workspaceKey）。
   * Helper lifecycle 不再回收或重启已有 Agent。
   */
  resolveSpawnEnv?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /**
   * 可选的外部 spawn admission hook。CUA 默认装配不再注入 Helper recovery gate，
   * 避免 Helper lifecycle 阻塞或间接重启 Agent；保留该通用 hook 供其他产品策略使用。
   */
  waitForSpawnAdmission?: (context: {
    workspacePath: string;
    workspaceIdentity?: string;
    workspaceKey: string;
    signal?: AbortSignal;
  }) => Promise<void> | void;
  /**
   * 真实 Host 实例身份。仅由 Host 装配层注入；配置后本 manager 会在 spawn 出实际 client
   * 后通过私有 stdio startup 帧写入 Host/runtime 身份。缺省不发送，CLI 保持无 CUA candidate。
   */
  cuaHostInstanceId?: string;
  /**
   * startup 身份握手连续失败熔断阈值（非 method-not-found 的失败按 workspaceKey 计数）。
   * 达到阈值后进入冷却窗口，窗口内拒绝再启动新 runtime。0 或缺省 = 3。
   */
  startupIdentityFailureThreshold?: number;
  /** startup 身份熔断冷却窗口毫秒数；窗口过期后放行一次探测。缺省 60s。 */
  startupIdentityRetryCooldownMs?: number;
}

interface ManagedZCodeAgentProcess {
  client: ZCodeProtocolClient;
  child: ChildProcess;
  cleanupPromise?: Promise<void>;
  exited: boolean;
  firstCleanupReason?: AgentProcessCleanupReason;
  idleTimer?: ReturnType<typeof setTimeout>;
  readyAt?: number;
  readyReported: boolean;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  runtimeInstanceId: string;
  spawned: boolean;
  startedAt: number;
  terminationIntent?: AgentProcessTerminationIntent;
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

type AgentProcessCleanupReason =
  | "idle-timeout"
  | "idle-timeout-retry"
  | "manager-dispose"
  | "manager-dispose-retry"
  | "protocol-close"
  | "request-timeout"
  | "startup-identity"
  | "startup-identity-retry"
  | "workspace-dispose"
  | "workspace-dispose-retry";

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** 只有明确的 JSON-RPC method-not-found 能证明旧 Agent 不认识 startup 帧。 */
function isJsonRpcMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === JSON_RPC_METHOD_NOT_FOUND
  );
}

interface AgentProcessTerminationIntent {
  kind: "expected" | "watchdog_recycle";
  reason: Exclude<AgentProcessCleanupReason, "protocol-close">;
  requestedAt: number;
}

const E2E_COVERAGE_PRELOAD_SOURCE = `
const { takeCoverage } = require("node:v8");
const { writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const coverageDirectory = process.env.NODE_V8_COVERAGE;
let coverageFlushStarted = false;
for (const signal of process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const flushCoverage = () => {
    if (coverageFlushStarted) return;
    coverageFlushStarted = true;
    if (coverageDirectory) {
      writeFileSync(
        resolve(coverageDirectory, \`coverage-signal-\${process.pid}.marker\`),
        signal,
      );
    }
    try {
      takeCoverage();
    } catch (error) {
      if (coverageDirectory) {
        writeFileSync(
          resolve(coverageDirectory, \`coverage-signal-error-\${process.pid}.txt\`),
          error instanceof Error ? error.stack || error.message : String(error),
        );
      }
    }
    if (process.listenerCount(signal) !== 1) return;
    setTimeout(() => {
      process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
    }, 1000);
  };
  process.prependListener(signal, flushCoverage);
}
if (coverageDirectory) {
  writeFileSync(resolve(coverageDirectory, \`coverage-ready-\${process.pid}.marker\`), "");
}
`;

export function buildE2EAgentCoverageEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const artifactDir = env.ZCODE_E2E_ARTIFACT_DIR?.trim();
  if (env.ZCODE_E2E_COVERAGE !== "1" || !artifactDir) {
    return {};
  }
  const directory = resolve(artifactDir, "coverage", "raw", "cli");
  mkdirSync(directory, { recursive: true });
  const preloadPath = resolve(directory, "zcode-e2e-coverage-preload.cjs");
  // CLI bundle 未压缩时解析耗时可能超过 E2E 的早退窗口，普通 shutdown
  // handler 尚未注册就收到 SIGTERM。用 NODE_OPTIONS preload 在解析 bundle 前接管落盘。
  writeFileSync(preloadPath, E2E_COVERAGE_PRELOAD_SOURCE, "utf8");
  const requireOption = `--require=${JSON.stringify(preloadPath)}`;
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), requireOption].filter(Boolean).join(" "),
    NODE_V8_COVERAGE: directory,
  };
}

/**
 * （CLI 重连重订边界）：同一 workspace 的 agent 进程被重建（超时回收/崩溃后
 * 首个 getClient 重新拉起）。v4 订阅（sessions-index/workspace-config/conversation）
 * 都活在 CLI 进程内存里，进程换代即失效——订阅方收到本事件后必须重发 subscribe。
 */
export interface ZCodeAgentRuntimeRestartedEvent {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
}

export interface ZCodeAgentRuntimeLifecycleEvent {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentRuntimeIdentity;
  state: "available" | "unavailable";
}

export interface ZCodeAgentRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
  /** 进程泳道标识；chat 主泳道缺省为空。 */
  lane?: string;
}

interface ZCodeAgentSpawnPreflight {
  command: string;
  args: string[];
  requestedCwd: string;
  cwd: string;
  cwdSource: "command" | "workspace" | "workspace-fallback";
  commandPathKind: "absolute" | "path-search";
  commandExists: boolean | null;
  cwdExists: boolean;
}

const serviceLog = createServiceLogger("zcode-agent");

const log = (...args: unknown[]) => serviceLog.info(undefined, ...args);
const warnLog = (...args: unknown[]) => serviceLog.warn(undefined, ...args);
const errorLog = (...args: unknown[]) => serviceLog.error(undefined, ...args);

const AGENT_STDERR_TAIL_MAX_LINES = 20;
const AGENT_STDERR_LINE_MAX_CHARS = 1_000;
const AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AGENT_STDERR_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const AGENT_STDERR_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

function redactAgentDiagnostic(value: string): string {
  return (
    value
      .replace(AGENT_STDERR_SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
      .replace(AGENT_STDERR_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      // 裸 key 也必须在跨进程诊断和生产日志之前遮盖。
      .replace(AGENT_STDERR_API_KEY_PATTERN, "$1<redacted>")
  );
}

const debugLog = (...args: unknown[]) => {
  if (!isEffectiveDevelopmentNodeEnv()) {
    return;
  }
  serviceLog.debug(undefined, ...args);
};

function createAgentStderrTail(): {
  append(line: string): void;
  snapshot(): { lineCount: number; tail: string[] };
} {
  const tail: string[] = [];
  let lineCount = 0;

  return {
    append(line) {
      lineCount += 1;
      const redacted = redactAgentDiagnostic(line);
      const bounded =
        redacted.length > AGENT_STDERR_LINE_MAX_CHARS
          ? `${redacted.slice(0, AGENT_STDERR_LINE_MAX_CHARS)}…[truncated]`
          : redacted;
      tail.push(bounded);
      if (tail.length > AGENT_STDERR_TAIL_MAX_LINES) {
        tail.shift();
      }
    },
    snapshot() {
      return { lineCount, tail: [...tail] };
    },
  };
}

function parseArgsJson(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("ZCODE_AGENT_SERVER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function findUpward(relativePath: string): string | null {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function buildZCodeAgentSpawnPreflight(
  command: ZodyAgentCommand,
  workspacePath: string,
  spawnFallbackCwd?: string,
): Promise<ZCodeAgentSpawnPreflight> {
  const commandPathKind = isAbsolute(command.command) ? "absolute" : "path-search";
  const requestedCwd = command.cwd ?? workspacePath;
  const {
    cwd,
    usedFallback: shouldUseWorkspaceFallback,
    cwdExists,
  } = await resolveZCodeAgentSpawnCwd({ requestedCwd, workspacePath, spawnFallbackCwd });
  return {
    command: command.command,
    args: command.args ?? [],
    requestedCwd,
    cwd,
    cwdSource: shouldUseWorkspaceFallback
      ? "workspace-fallback"
      : command.cwd === undefined
        ? "workspace"
        : "command",
    commandPathKind,
    // Node spawn 的 ENOENT 既可能来自 command 缺失，也可能来自 cwd 缺失。
    // 生产日志在 spawn 前同时记录两者可见性，避免把工作区路径丢失误判成自动更新丢 binary。
    commandExists: commandPathKind === "absolute" ? existsSync(command.command) : null,
    cwdExists,
  };
}

function resolveBundledWorkspaceZCodeAgentCommand(
  context: ZodyAgentCommandResolverContext,
): ZodyAgentCommand | null {
  const distEntrypoint = findUpward("apps/zody-cli/packages/cli/dist/zody.cjs");
  if (distEntrypoint) {
    const useBytecode =
      process.versions.electron && process.env.ZCODE_DESKTOP_AGENT_BYTECODE === "1";
    const entrypoint = useBytecode
      ? join(dirname(distEntrypoint), "zcode.bytecode.cjs")
      : distEntrypoint;
    // 此同步 command resolver 沿用既有 existsSync 契约；显式试验不能静默回退成 JS。
    if (useBytecode && !existsSync(entrypoint)) {
      throw new Error("桌面 Agent 字节码入口缺失，请运行 pnpm build:desktop-agent:bytecode");
    }
    return {
      command: process.execPath,
      args: [entrypoint, "app-server", "--stdio"],
      // Worker 与 Electron Node 子进程的 V8 snapshot 可不同；临时存储准备继续用 JS。
      storagePreparationEntry: distEntrypoint,
      cwd: context.workspacePath,
      // 桌面端 host 运行在 Electron utility process 中，process.execPath 指向 Electron Helper。
      // 这里显式启用 Node 运行模式，避免内置 zcode-agent 被当成 Electron/Chromium 子进程启动并卡在 GPU 初始化。
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const sourceEntrypoint = findUpward("apps/zody-cli/packages/cli/src/main.ts");
  const tsxEntrypoint = findUpward("node_modules/.bin/tsx");
  if (!sourceEntrypoint || !tsxEntrypoint) {
    return null;
  }
  return {
    command: tsxEntrypoint,
    args: [sourceEntrypoint, "app-server", "--stdio"],
    cwd: context.workspacePath,
  };
}

function resolveDeployedZCodeAgentBinaryCommand(
  context: ZodyAgentCommandResolverContext,
): ZodyAgentCommand | null {
  // 旧 resolver 只识别 ZCODE_AGENT_SERVER_COMMAND env 和 monorepo 源码树。
  // SSH 远端把 zody-server.cjs 单文件部署到 ~/.zody/server/，宿主进程的 cwd 不在仓库内、
  // env 也不会被 ssh exec 继承，即使 zcode-agent 已经部署到 ~/.zody/server/agents/glm/，
  // resolver 也找不到，第一次 getClient 就抛 "Zody agent server command is not configured"。
  // 这里复用 findZCodeAgentRuntimeBinary 的候选链（含 GLM_BINARY_PATH env、
  // packagedResourcesPath、~/.zody/server/agents/glm、bundled-agents 等），
  // 把已部署的原生 binary 当成最终兜底，远端/桌面打包形态都能命中。
  const binaryPath = findZCodeAgentRuntimeBinary();
  if (!binaryPath) {
    return null;
  }
  return {
    command: binaryPath,
    args: ZCODE_AGENT_RUNTIME.spawnArgs,
    cwd: context.workspacePath,
  };
}

function resolveElectronRuntimeZCodeAgentCommand(
  context: ZodyAgentCommandResolverContext,
): ZodyAgentCommand | null {
  // 桌面打包态：host 跑在 Electron utility process 里，process.execPath 指向 Electron Helper，
  // 它内置的 Node runtime 与 zcode-cli 目标版本一致（Electron 41 = Node 24.x）。
  // 这里直接用 app 自带的 Electron Node 执行打进 resources/glm 的 zody.cjs，
  // 不再随包内置一份独立 Node 二进制（体积从 ~180MB 降到 ~16MB，且跨平台同一份 JS）。
  // 用 process.versions.electron 作为闸门：远端 SSH/WSL host 由系统 Node 运行、没有 electron，
  // 会跳过这里继续走原生二进制兜底，桌面/远端两条链路互不影响。
  if (!process.versions.electron) {
    return null;
  }
  const bundlePath = findZCodeAgentRuntimeNodeBundle();
  if (!bundlePath) {
    return null;
  }
  return {
    command: process.execPath,
    args: [bundlePath, ...ZCODE_AGENT_RUNTIME.spawnArgs],
    storagePreparationEntry: bundlePath,
    cwd: context.workspacePath,
    // 关键：必须以纯 Node 模式启动，否则子进程会被当成 Electron/Chromium 子进程卡在 GPU 初始化。
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function assertAbsoluteNativeRuntimePath(path: string, field: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`ZCode Agent native runtime ${field} must be an absolute path: ${path}`);
  }
}

function assertNativeRuntimeEnv(
  env: Readonly<Record<string, string>> | undefined,
  context: string,
): void {
  if (env && Object.prototype.hasOwnProperty.call(env, "ELECTRON_RUN_AS_NODE")) {
    throw new Error(`${context} must not set ELECTRON_RUN_AS_NODE`);
  }
}

function assertNativeCliFd(fd: number, field: string): void {
  if (!Number.isInteger(fd) || fd < 3 || fd > 1_024) {
    throw new Error(`ZCode Agent native runtime ${field} must be an fd between 3 and 1024`);
  }
}

/** Validate a trusted native launcher config before it reaches spawn. */
export function validateZCodeAgentNativeRuntimeConfig(
  config: ZodyAgentNativeRuntimeConfig,
): ZodyAgentNativeRuntimeConfig {
  assertAbsoluteNativeRuntimePath(config.launcherPath, "launcherPath");
  if (config.entryName !== undefined && config.entryName !== "cli-entry.mjs") {
    throw new Error(`Unsupported ZCode Agent native entry: ${config.entryName}`);
  }
  const cliInFd = config.cliInFd ?? 6;
  const cliOutFd = config.cliOutFd ?? 7;
  assertNativeCliFd(cliInFd, "cliInFd");
  assertNativeCliFd(cliOutFd, "cliOutFd");
  if (cliInFd === cliOutFd) {
    throw new Error("ZCode Agent native runtime cliInFd and cliOutFd must differ");
  }
  if (
    config.launchMode !== undefined &&
    config.launchMode !== "direct" &&
    config.launchMode !== "workspace-relay"
  ) {
    throw new Error(`Unsupported ZCode Agent native launchMode: ${config.launchMode}`);
  }
  assertNativeRuntimeEnv(config.env, "ZCode Agent native runtime env");
  return config;
}

function buildNativeCliStdio(cliInFd: number, cliOutFd: number): StdioOptions {
  const lastFd = Math.max(cliInFd, cliOutFd, 2);
  return Array.from({ length: lastFd + 1 }, (_, fd) => {
    // 根因：native 协议输出只读 cliOutFd（默认 7），原实现把 fd1 也建成 pipe；
    // 该 pipe 没有任何消费者，native/子进程日志写满 pipe 缓冲后会阻塞。
    // fd1 不是协议通道，直接忽略，仅保留 stderr 与显式协议 fd。
    if (fd === 2 || fd === cliInFd || fd === cliOutFd) return "pipe";
    return "ignore";
  });
}

/** Build the Agent command from the trusted native launcher config. */
export function resolveZCodeAgentNativeRuntimeCommand(
  config: ZodyAgentNativeRuntimeConfig,
  context: ZodyAgentCommandResolverContext,
): ZodyAgentCommand {
  validateZCodeAgentNativeRuntimeConfig(config);
  const cliInFd = config.cliInFd ?? 6;
  const cliOutFd = config.cliOutFd ?? 7;
  const args = [
    "--launch-session",
    "--entry-name",
    "cli-entry.mjs",
    "--cli-in-fd",
    String(cliInFd),
    "--cli-out-fd",
    String(cliOutFd),
  ];
  if (config.launchMode === "workspace-relay") {
    args.push("--launch-via-workspace");
  }
  return {
    command: config.launcherPath,
    args,
    cwd: context.workspacePath,
    // Native entry has no separate storage worker path. Requiring storage startup without
    // one would silently fall back to a non-native CLI spawn.
    supportsStorageStartup: false,
    nativeLauncher: true,
    stdio: buildNativeCliStdio(cliInFd, cliOutFd),
    stdioIndexes: { stdin: cliInFd, stdout: cliOutFd, stderr: 2 },
    ...(config.env ? { env: { ...config.env } } : {}),
  };
}

export function resolveDefaultZCodeAgentCommand(
  context: ZodyAgentCommandResolverContext,
  options?: { nativeRuntime?: ZodyAgentNativeRuntimeConfig | null },
): ZodyAgentCommand | null {
  // 可信组合注入优先于任何 PATH/env 发现；环境变量不能改写固定 native 启动。
  if (options?.nativeRuntime) {
    return resolveZCodeAgentNativeRuntimeCommand(options.nativeRuntime, context);
  }
  const command = process.env.ZCODE_AGENT_SERVER_COMMAND?.trim();
  if (command) {
    return applyPresentationSurfaceToCommand(
      {
        command,
        args: parseArgsJson(process.env.ZCODE_AGENT_SERVER_ARGS_JSON) ?? ["app-server", "--stdio"],
        cwd: process.env.ZCODE_AGENT_SERVER_CWD?.trim() || context.workspacePath,
      },
      context.presentationSurface,
    );
  }

  // 顺序：env 显式覆盖 → monorepo dev 源码/dist（dev 改源码立刻生效，不会被远端历史装的 native binary
  // 抢先匹配）→ 桌面打包态 Electron Node runtime 跑 zody.cjs → 已部署 native binary（远端 SSH 兜底）。
  const bundled =
    resolveBundledWorkspaceZCodeAgentCommand(context) ??
    resolveElectronRuntimeZCodeAgentCommand(context);
  return applyPresentationSurfaceToCommand(
    bundled
      ? { ...bundled, supportsStorageStartup: true }
      : resolveDeployedZCodeAgentBinaryCommand(context),
    context.presentationSurface,
  );
}

function applyPresentationSurfaceToCommand(
  command: ZodyAgentCommand | null,
  presentationSurface: ZodyAgentCommandResolverContext["presentationSurface"],
): ZodyAgentCommand | null {
  if (!command || presentationSurface !== "desktop") {
    return command;
  }

  const commandArgs = command.args ?? [];
  const args: string[] = [];
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index]!;
    if (arg === "--surface") {
      const nextArg = commandArgs[index + 1];
      // Bug 原因：旧逻辑无条件消费下一个 token，孤立的 --surface 会把后续
      // --stdio 等 option 一并吞掉，导致自定义 Agent 命令失去协议启动参数。
      // 只有明确的非 option value 才属于 --surface；其他 option 继续走原参数链路。
      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--surface=")) {
      continue;
    }
    args.push(arg);
  }

  return {
    ...command,
    args: [...args, "--surface", "desktop"],
  };
}

export function wrapZCodeAgentCommandWithStdioTapDevProxy(
  command: ZodyAgentCommand,
  workspaceKey: string,
): ZodyAgentCommand {
  // Native launcher verification is bound to its exact argv/fds; wrapping it with a Node
  // dev proxy would both break the protocol and bypass the native entry contract.
  if (command.nativeLauncher) {
    return command;
  }
  const tapState = readZCodeStdioTapDevState();
  if (!tapState.enabled) {
    return command;
  }

  const tapScript = findUpward("scripts/dev/zody-stdio-tap.mjs");
  if (!tapScript) {
    debugLog("ZCode stdio tap proxy enabled but script not found");
    return command;
  }

  // 开发态 raw stdio 帧数据量和消息流同级，不能打进普通 info 日志。
  // 这里只在显式开关打开时用旁路 proxy 写盘，生产构建和默认开发路径都不受影响。
  return {
    supportsStorageStartup: command.supportsStorageStartup,
    command: process.execPath,
    args: [
      tapScript,
      "--workspace-key",
      workspaceKey,
      "--log-dir",
      tapState.logDir,
      "--",
      command.command,
      ...(command.args ?? []),
    ],
    cwd: command.cwd,
    env: {
      ...command.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

/**
 * Builds the manager's command resolver without losing the existing resolution path.
 *
 * Priority: an explicit `nativeRuntime` composition wins (sealed candidate Host),
 * then the selective resolver for eligible workspaces, then the original resolver.
 * A selective resolver that returns `null` must not change local/remote behavior.
 */
export function createZCodeAgentCommandResolver(
  options?: ZodyAgentProcessManagerOptions,
): ZodyAgentCommandResolver {
  const fallbackResolver = options?.commandResolver ?? resolveDefaultZCodeAgentCommand;
  const nativeRuntime = options?.nativeRuntime;
  if (nativeRuntime) {
    return (context) => resolveZCodeAgentNativeRuntimeCommand(nativeRuntime, context);
  }
  // Selective startup-profile routing belongs to the chat/main lane only. Control-plane,
  // plugin, and background managers keep their original command resolver even when the
  // shared service options contain a native resolver.
  const nativeRuntimeResolver = options?.lane?.trim() ? undefined : options?.nativeRuntimeResolver;
  if (!nativeRuntimeResolver) {
    return fallbackResolver;
  }
  return async (context) => {
    const selected = await nativeRuntimeResolver(context);
    if (!selected) return fallbackResolver(context);
    return resolveZCodeAgentNativeRuntimeCommand(selected, context);
  };
}

function createZCodeStdioChildView(
  child: ChildProcess,
  command: ZodyAgentCommand,
): ZCodeStdioChildLike {
  const indexes = command.stdioIndexes;
  const stdin = indexes ? child.stdio[indexes.stdin] : child.stdin;
  const stdout = indexes ? child.stdio[indexes.stdout] : child.stdout;
  const stderr = indexes ? child.stdio[indexes.stderr ?? 2] : child.stderr;
  if (
    !(stdin instanceof Writable) ||
    !(stdout instanceof Readable) ||
    !(stderr instanceof Readable)
  ) {
    throw new Error("ZCode Agent spawn did not expose the configured protocol stdio streams");
  }
  return {
    get pid() {
      return child.pid;
    },
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    stdin,
    stdout,
    stderr,
    processTreeChild: child,
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

export class ZodyAgentProcessManager {
  private readonly processesByWorkspaceKey = new Map<string, ManagedZCodeAgentProcess>();
  private readonly ownedProcesses = new Set<ManagedZCodeAgentProcess>();
  private readonly startingByWorkspaceKey = new Map<string, Promise<ZCodeProtocolClient>>();
  private readonly restartGenerationByWorkspaceKey = new Map<string, number>();
  private readonly runtimeGenerationByWorkspaceKey = new Map<string, number>();
  private readonly availableRuntimeIdentityByWorkspaceKey = new Map<string, string>();
  private readonly startAdmissionAbortControllersByWorkspaceKey = new Map<
    string,
    Set<AbortController>
  >();
  private readonly storageStartupEmitter = new Emitter<{
    workspaceKey: string;
    snapshot: ZCodeAgentStorageStartupSnapshot;
  }>();
  readonly onStorageStartupChanged = this.storageStartupEmitter.event;

  getStorageStartupState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeAgentStorageStartupSnapshot | null {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    return managed
      ? {
          generation: managed.runtimeIdentity.generation,
          state: managed.client.storageStartup.snapshot ?? null,
        }
      : null;
  }

  private readonly commandResolver: ZodyAgentCommandResolver;
  private readonly presentationSurface: ZodyAgentProcessManagerOptions["presentationSurface"];
  private readonly requestTimeoutMs: number | undefined;
  private readonly processLifecycleReporter: RuntimeProcessLifecycleReporter | undefined;
  private readonly resolveSpawnEnv: ZodyAgentProcessManagerOptions["resolveSpawnEnv"];
  private readonly waitForSpawnAdmission: ZodyAgentProcessManagerOptions["waitForSpawnAdmission"];
  private readonly spawnFallbackCwd: string | undefined;
  private readonly cuaHostInstanceId: string | undefined;
  private readonly startupIdentityFailureThreshold: number;
  private readonly startupIdentityRetryCooldownMs: number;
  private readonly lane: string | undefined;
  private readonly idleTimeoutMs: number | undefined;
  private readonly runtimeRestartedEmitter = new Emitter<ZCodeAgentRuntimeRestartedEvent>();
  private readonly runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  /**
   * startup 身份握手连续失败计数与最近失败时间，按 workspaceKey 隔离。
   * 熔断状态唯一所有者是本 manager；成功启动即清零，冷却窗口过期后放行一次探测。
   */
  private readonly startupIdentityFailuresByWorkspaceKey = new Map<
    string,
    { count: number; lastFailedAt: number }
  >();
  private disposeAllInFlight: Promise<void> | undefined;
  private disposed = false;

  /** 进程换代通知（generation>1 时触发）；v4 订阅方据此重订，见 ZCodeAgentRuntimeRestartedEvent。 */
  readonly onRuntimeRestarted = this.runtimeRestartedEmitter.event;
  /** 真实 spawn、启动握手与 single-flight 收口后 available；client 关闭后 unavailable。 */
  readonly onRuntimeLifecycle = this.runtimeLifecycleEmitter.event;

  constructor(options?: ZodyAgentProcessManagerOptions) {
    this.commandResolver = createZCodeAgentCommandResolver(options);
    this.presentationSurface = options?.presentationSurface;
    this.requestTimeoutMs = options?.requestTimeoutMs;
    this.processLifecycleReporter = options?.processLifecycleReporter;
    this.resolveSpawnEnv = options?.resolveSpawnEnv;
    this.waitForSpawnAdmission = options?.waitForSpawnAdmission;
    this.spawnFallbackCwd = options?.spawnFallbackCwd;
    this.cuaHostInstanceId = options?.cuaHostInstanceId?.trim() || undefined;
    this.startupIdentityFailureThreshold =
      options?.startupIdentityFailureThreshold && options.startupIdentityFailureThreshold > 0
        ? options.startupIdentityFailureThreshold
        : 3;
    this.startupIdentityRetryCooldownMs =
      options?.startupIdentityRetryCooldownMs && options.startupIdentityRetryCooldownMs > 0
        ? options.startupIdentityRetryCooldownMs
        : 60_000;
    this.lane = options?.lane?.trim() || undefined;
    this.idleTimeoutMs =
      options?.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  }

  private reportProcessLifecycle(
    callback: (reporter: RuntimeProcessLifecycleReporter) => void,
  ): void {
    const reporter = this.processLifecycleReporter;
    if (!reporter) {
      return;
    }

    try {
      callback(reporter);
    } catch (error) {
      // 进程生命周期上报是旁路观测，临时失败不得阻断 agent 启动或回收。
      warnLog("ZCode agent process lifecycle reporter failed", error);
    }
  }

  private clearIdleTimer(managed: ManagedZCodeAgentProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
      delete managed.idleTimer;
    }
  }

  /**
   * 空闲回收：每次在飞请求归零就重置计时；到点时若仍无请求在飞且该进程仍是当前活跃实例，
   * 主动回收整棵进程树（含挂在其下的 MCP 子进程）。归因为 expected/idle-timeout，
   * 不会被监控当作崩溃。到点时有新请求在飞则什么都不做，等下一次归零重新计时。
   */
  private scheduleIdleReclaim(workspaceKey: string, managed: ManagedZCodeAgentProcess): void {
    if (!this.idleTimeoutMs || this.disposed || managed.exited) {
      return;
    }
    this.clearIdleTimer(managed);
    const timer = setTimeout(() => {
      delete managed.idleTimer;
      if (this.disposed || managed.exited) {
        return;
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      // 自定义 Agent 的旧启动请求可能先结清，再继续数据库准备；无在飞 RPC 不代表迁移空闲。
      if (
        managed.client.pendingOperationRequestCount > 0 ||
        managed.client.storageStartup.isWaiting
      ) {
        return;
      }
      log("ZCode agent process idle timeout; reclaiming", {
        workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        idleTimeoutMs: this.idleTimeoutMs,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      void this.cleanupManagedProcessWithRetry(
        managed,
        "idle-timeout",
        "idle-timeout-retry",
        "idle timeout",
      ).catch(() => undefined);
    }, this.idleTimeoutMs);
    // 空闲计时器不能把 host 进程钉在事件循环里。
    timer.unref?.();
    managed.idleTimer = timer;
  }

  private recordTerminationIntent(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
  ): void {
    if (managed.firstCleanupReason) {
      return;
    }
    managed.firstCleanupReason = reason;
    if (reason === "protocol-close") {
      return;
    }
    // protocol close 可能是 Agent 崩溃的结果，只有 Host 主动发起的回收
    // 才能建立退出意图。首次 cleanup 原因是根因事实，后续 app quit 等幂等回收不能
    // 把已经发生的异常 protocol close 改写成 expected。
    managed.terminationIntent = {
      kind: reason === "request-timeout" ? "watchdog_recycle" : "expected",
      reason,
      requestedAt: Date.now(),
    };
  }

  /**
   * 熔断闸门：连续握手失败达到阈值且仍在冷却窗口内时拒绝再启动。
   * 窗口过期后放行一次探测（half-open），由后续成功清零或失败重新计数。
   */
  private assertStartupIdentityCircuitClosed(workspaceKey: string): void {
    const failure = this.startupIdentityFailuresByWorkspaceKey.get(workspaceKey);
    if (!failure) return;
    if (
      failure.count < this.startupIdentityFailureThreshold ||
      Date.now() - failure.lastFailedAt >= this.startupIdentityRetryCooldownMs
    ) {
      return;
    }
    const cooldownRemainMs =
      this.startupIdentityRetryCooldownMs - (Date.now() - failure.lastFailedAt);
    throw new Error(
      `ZCode agent startup identity circuit is open for workspace ${workspaceKey}: ` +
        `${failure.count} consecutive failures, retry in ${Math.ceil(cooldownRemainMs / 1000)}s.`,
    );
  }

  private noteStartupIdentityFailure(workspaceKey: string): void {
    const previous = this.startupIdentityFailuresByWorkspaceKey.get(workspaceKey);
    this.startupIdentityFailuresByWorkspaceKey.set(workspaceKey, {
      count: (previous?.count ?? 0) + 1,
      lastFailedAt: Date.now(),
    });
  }

  private clearStartupIdentityFailures(workspaceKey: string): void {
    this.startupIdentityFailuresByWorkspaceKey.delete(workspaceKey);
  }

  private reportRuntimeAvailable(managed: ManagedZCodeAgentProcess): void {
    const { workspaceKey, generation, identity } = managed.runtimeIdentity;
    // Bug 根因：spawn 早于 startup ACK，且 getExistingClient 在 single-flight 中拒绝读取。
    // 提前通知会让 task-index 的 existing-only 订阅永久退回 dormant。两处边界共用此闸门，
    // 必须同时满足真实 spawn、握手收口、当前代仍存活；沿既有 identity 保证只通知一次。
    if (
      this.disposed ||
      !managed.spawned ||
      managed.exited ||
      managed.client.isDisposed ||
      this.getExistingClient(managed.workspace) !== managed.client ||
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) === identity
    ) {
      return;
    }
    // restart 先清旧订阅路由，再让 available listener 建立新代订阅。
    if (generation > 1) {
      this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity: managed.runtimeIdentity });
    }
    // restart listener 可能同步关闭 workspace，不能随后发布已失效 runtime 的 available。
    if (
      this.disposed ||
      managed.exited ||
      managed.client.isDisposed ||
      this.getExistingClient(managed.workspace) !== managed.client
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, identity);
    this.runtimeLifecycleEmitter.fire({
      ...managed.workspace,
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "available",
    });
  }

  private reportRuntimeUnavailable(managed: ManagedZCodeAgentProcess): void {
    const workspaceKey = managed.runtimeIdentity.workspaceKey;
    if (
      this.availableRuntimeIdentityByWorkspaceKey.get(workspaceKey) !==
      managed.runtimeIdentity.identity
    ) {
      return;
    }
    this.availableRuntimeIdentityByWorkspaceKey.delete(workspaceKey);
    this.runtimeLifecycleEmitter.fire({
      workspacePath: managed.workspace.workspacePath,
      ...(managed.workspace.workspaceIdentity
        ? { workspaceIdentity: managed.workspace.workspaceIdentity }
        : {}),
      workspaceKey,
      runtimeIdentity: managed.runtimeIdentity,
      state: "unavailable",
    });
  }

  private reportRuntimeReady(managed: ManagedZCodeAgentProcess): void {
    if (
      !managed.spawned ||
      managed.exited ||
      managed.readyReported ||
      managed.readyAt == null ||
      typeof managed.child.pid !== "number"
    ) {
      return;
    }
    managed.readyReported = true;
    this.reportProcessLifecycle((reporter) =>
      reporter.onReady?.({
        pid: managed.child.pid!,
        provider: ZCODE_AGENT_PROVIDER,
        ...(this.lane ? { lane: this.lane } : {}),
        workspacePath: managed.workspace.workspacePath,
        readyAt: managed.readyAt!,
        startupDurationMs: Math.max(0, managed.readyAt! - managed.startedAt),
        runtimeGeneration: managed.runtimeIdentity.generation,
        runtimeInstanceId: managed.runtimeInstanceId,
      }),
    );
  }

  private cleanupManagedProcess(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    options: { reportError?: boolean } = {},
  ): Promise<void> {
    this.recordTerminationIntent(managed, reason);
    this.clearIdleTimer(managed);
    if (managed.cleanupPromise) {
      return managed.cleanupPromise;
    }

    // protocol close 只会使 client 不再可复用，不代表它对应的
    // OS 进程已退出。将回收 Promise 绑在 managed process 上，timeout、restart 和
    // app quit 可以共用同一次幂等回收，Host 也不会丢失已退休进程的所有权。
    let cleanupCompleted = false;
    const cleanupPromise = managed.client
      .disposeAndWait()
      .then(() => {
        cleanupCompleted = true;
        log("ZCode agent process cleanup completed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason,
        });
      })
      .finally(() => {
        if (managed.cleanupPromise === cleanupPromise) {
          delete managed.cleanupPromise;
        }
        if (cleanupCompleted) {
          this.ownedProcesses.delete(managed);
        }
      });
    managed.cleanupPromise = cleanupPromise;
    // Bug 原因：dispose 与重试编排竞态时，rejection 可能先于调用方 await 挂靠被判为
    // unhandledRejection（vitest 计为运行级失败，生产等价于未处理拒绝）。catch 必须在
    // 创建点无条件挂靠：reportError:false（重试路径）时静默吞掉，统一上报由
    // cleanupManagedProcessWithRetry 的 await/catch 完成，告警语义不变。
    void cleanupPromise.catch((error) => {
      if (options.reportError === false) {
        return;
      }
      errorLog("ZCode agent process cleanup failed", {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        reason,
        error,
      });
    });
    return cleanupPromise;
  }

  private async cleanupManagedProcessForShutdown(managed: ManagedZCodeAgentProcess): Promise<void> {
    await this.cleanupManagedProcessWithRetry(
      managed,
      "manager-dispose",
      "manager-dispose-retry",
      "manager dispose",
    );
  }

  private async cleanupManagedProcessWithRetry(
    managed: ManagedZCodeAgentProcess,
    reason: AgentProcessCleanupReason,
    retryReason: AgentProcessCleanupReason,
    retryScope: string,
  ): Promise<void> {
    try {
      // 首次 cleanup 的进程树/exit 观察可能只是中间态；在 retry 成功时，
      // 首次 rejection 不应提前升级为生产 error 告警。最终失败仍由本方法统一上报一次。
      await this.cleanupManagedProcess(managed, reason, { reportError: false });
    } catch (firstError) {
      // Windows 进程表查询/exit 事件可能短暂落后，首次 cleanup 会误报 root
      // 残留。restart/app quit 都不能把这种中间态暴露给调用方，需重试一次并复用
      // transport 内部快照；真实残留会在第二次 cleanup 继续抛出。
      const cleanupError = firstError as NodeJS.ErrnoException;
      warnLog(`ZCode agent process cleanup retrying during ${retryScope}`, {
        workspaceKey: managed.runtimeIdentity.workspaceKey,
        pid: managed.child.pid,
        runtimeIdentity: managed.runtimeIdentity.identity,
        cleanupStage: reason,
        errorName: firstError instanceof Error ? firstError.name || "Error" : "UnknownError",
        ...(typeof cleanupError.code === "string" ? { errorCode: cleanupError.code } : {}),
        error: firstError,
      });
      try {
        await this.cleanupManagedProcess(managed, retryReason, { reportError: false });
      } catch (finalError) {
        errorLog("ZCode agent process cleanup failed", {
          workspaceKey: managed.runtimeIdentity.workspaceKey,
          pid: managed.child.pid,
          runtimeIdentity: managed.runtimeIdentity.identity,
          reason: retryReason,
          retryScope,
          error: finalError,
        });
        throw finalError;
      }
    }
  }

  async getClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeProtocolClient> {
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    const workspaceKey = resolveWorkspaceKey(params);
    const starting = this.startingByWorkspaceKey.get(workspaceKey);
    if (starting) {
      const waitStartedAt = Date.now();
      log("ZCode agent process start already in progress", {
        workspaceKey,
      });
      const client = await starting;
      log("ZCode agent process start wait completed", {
        workspaceKey,
        durationMs: Date.now() - waitStartedAt,
      });
      return client;
    }

    // startClient 会先把 managed 写入 processesByWorkspaceKey，再等待私有 startup 身份握手。
    // 因此 starting 必须优先于 existing，否则并发 getClient 会拿到尚未 pin 身份的 client。
    const existing = this.processesByWorkspaceKey.get(workspaceKey);
    if (existing && !existing.child.killed) {
      return existing.client;
    }

    // startup 身份熔断只拦截"再启动一个新 runtime"：持续冲突的 Agent 若不设闸会形成
    // spawn→握手失败→清理→再 spawn 循环，每次都白白拉起进程。存活 client 读取与
    // in-flight 启动等待在上面的分支已返回，不受影响。
    this.assertStartupIdentityCircuitClosed(workspaceKey);

    // agent 启动前置后，host warmup 和 UI 首次 readWorkspacePresentation/sendPrompt
    // 可能同时进入 getClient。这里按 workspaceKey 收敛启动中的 promise，避免同一工作区重复 spawn。
    const startGeneration = this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0;
    const admissionAbortController = new AbortController();
    let controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.startAdmissionAbortControllersByWorkspaceKey.set(workspaceKey, controllers);
    }
    controllers.add(admissionAbortController);
    const startPromise = this.startClient(
      params,
      workspaceKey,
      startGeneration,
      admissionAbortController.signal,
    );
    this.startingByWorkspaceKey.set(workspaceKey, startPromise);
    let client: ZCodeProtocolClient;
    try {
      client = await startPromise;
    } finally {
      controllers.delete(admissionAbortController);
      if (controllers.size === 0) {
        this.startAdmissionAbortControllersByWorkspaceKey.delete(workspaceKey);
      }
      if (this.startingByWorkspaceKey.get(workspaceKey) === startPromise) {
        this.startingByWorkspaceKey.delete(workspaceKey);
      }
    }
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    if (managed?.client === client) {
      this.reportRuntimeAvailable(managed);
    }
    return client;
  }

  /**
   * 只读取已经登记的 runtime client；被动 observer 使用本入口避免 getClient 的隐式 spawn。
   */
  getExistingClient(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeProtocolClient | undefined {
    const workspaceKey = resolveWorkspaceKey(params);
    // 启动握手完成前不能向被动业务观察者暴露 client；listManagedProcesses 仍可用于诊断。
    if (this.startingByWorkspaceKey.has(workspaceKey)) return undefined;
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    return managed && !managed.child.killed ? managed.client : undefined;
  }

  /** 资源管理器：当前仍存活的受管 runtime（pid + workspace + client） */
  listManagedProcesses(): Array<{
    pid: number;
    workspacePath: string;
    workspaceIdentity?: string;
    lane?: string;
    client: ZCodeProtocolClient;
  }> {
    const result: Array<{
      pid: number;
      workspacePath: string;
      workspaceIdentity?: string;
      lane?: string;
      client: ZCodeProtocolClient;
    }> = [];
    for (const managed of this.processesByWorkspaceKey.values()) {
      if (managed.exited || managed.child.killed || typeof managed.child.pid !== "number") continue;
      result.push({
        pid: managed.child.pid,
        workspacePath: managed.workspace.workspacePath,
        ...(managed.workspace.workspaceIdentity
          ? { workspaceIdentity: managed.workspace.workspaceIdentity }
          : {}),
        ...(this.lane ? { lane: this.lane } : {}),
        client: managed.client,
      });
    }
    return result;
  }

  /** Agent service 首次通过 provider/model 门禁后调用；同一 runtime 只上报一次。 */
  markReady(
    params: { workspacePath: string; workspaceIdentity?: string },
    client: ZCodeProtocolClient,
  ): void {
    const managed = this.processesByWorkspaceKey.get(resolveWorkspaceKey(params));
    if (!managed || managed.client !== client || managed.readyAt != null || managed.exited) {
      return;
    }
    managed.readyAt = Date.now();
    // getClient 可能早于 ChildProcess 的异步 spawn 事件返回，也可能在 await 期间
    // 被新 runtime 替换。只给返回该 entry 的进程标 ready，并由 spawn 回调保证 start → ready 顺序。
    this.reportRuntimeReady(managed);
  }

  private async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "Zody agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("Zody agent process start was cancelled.");
    }
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery 可能在 command resolve 期间开始；先等待一次，确保 env 解析使用
    // recovery 后的 broker 凭据，而不是把旧状态带到 spawn 边界。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // 设置页代理等运行时 env 在 process.env 之后合入（覆盖继承的同名 shell 变量），
    // 但仍让 command.env（部署特定）保持最高优先级。
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // app 正在关闭时，启动中的 warmup 可能刚完成 command/env resolve。
      // 这时继续 spawn 会绕过 disposeAllAndWait 的快照，重新制造一个无人托管的 agent 进程。
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // 切模型会重启单个 workspace。旧启动请求如果在重启后才恢复，
      // 不能继续 spawn 并写回进程池，否则新配置会被旧 agent 覆盖。
      throw new Error("Zody agent process start was cancelled.");
    }
    // cwd 探测也让出事件循环，必须放在最终 admission 与销毁/代际检查之前。
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve 本身是异步的，恢复屏障可能在这段时间重新关闭；必须在 spawn 前
    // 再等待并复查代际，不能只依赖第一次 admission。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("Zody agent process start was cancelled.");
    }
    // app 以本地开发方式启动时，让 agent 子进程也带上 ZCODE_RUNTIME_ENV=development；
    // 不再传 NODE_ENV，避免用户 shell/runtime 变量影响 ZCode 运行模式或泄漏到 Bash 工具。
    const runtimeEnv = resolveZodyRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // agent 可能再派生实际 runtime/MCP 子进程。POSIX 下让 wrapper 进入独立进程组，
      // 关闭时才能按进程树整体回收；Windows 保持非 detached，交给 taskkill /T 处理。
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
        ...sanitizeZodyRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // 生成文件根目录由执行端 Host 唯一决定，保证 Agent 写入与 Host 读取授权一致。
        [GEN_UI_OUTPUT_ROOT_ENV]: join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY),
        // 身份/隔离语义使用 workspaceIdentity；cwd 继续使用 workspacePath。
        ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
        ...buildE2EAgentCoverageEnv(),
      },
      stdio: effectiveCommand.stdio ?? ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    let transportChild: ZCodeStdioChildLike;
    try {
      transportChild = createZCodeStdioChildView(child, effectiveCommand);
    } catch (error) {
      child.kill();
      throw error;
    }
    const transport = new ZCodeStdioTransport(transportChild, {
      onStderrLine: (line) => {
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // 根因：只保存 exit tail 会漏掉存活 runtime 的异常；此旁路不依赖 debug 开关。
          // 身份绑定创建时的 child，不能查当前 workspace，避免重启后的迟到事件串进程。
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // 脱敏占位符可能比原文长，必须再次限长，避免 IPC schema 拒绝合法异常。
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        if (effectiveCommand.nativeLauncher) {
          // 根因：fixed native launcher 的审计 marker 过去只进 debug/退出 tail，正式包
          // 看不到存活 cell 的验证与 diagnostic gate；这里只提升严格解析后的固定行，
          // 不转发普通 CLI stderr，也不把该自报日志当作身份或授权事实。
          const normalizedAuditLine = parseCuaNativeAuditLine(line);
          if (normalizedAuditLine) {
            log("CUA native audit", normalizedAuditLine);
            return;
          }
        }
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // POSIX 下 child 由本 manager 以 detached=true 启动，pid 同时就是 Host
      // 拥有的独立 PGID；异常 root exit 后 cleanup 仍可按组回收同组后代。
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (child.pid) {
      const unregisterNetworkCapture = localRuntimeNetworkCapture.register(client, child.pid);
      child.once("close", unregisterNetworkCapture);
    }
    // Agent 进程重启后，Host 仍需要 runtime identity 区分新旧订阅和运行命令。
    // Provider Registry 由新 Worker 从所属 Environment 的 Config 重建，不再由 UI 重新下发。
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // 生命周期事件关联只需要本次 runtime 的不透明身份，不能复用包含 workspaceKey 的协议 identity。
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      this.storageStartupEmitter.fire({
        workspaceKey,
        snapshot: { generation: runtimeGeneration, state: client.storageStartup.snapshot ?? null },
      });
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() 会先返回 ChildProcess，再异步报告 cwd/command ENOENT。
      // 旧代码在确认 spawn 成功前就发布 runtimeRestarted，订阅方随即重连并再次触发
      // 启动，最终形成失败启动 -> 假重启 -> 重连的自激风暴。没有 startup 握手时，
      // spawn 也可能晚于 getClient 收口，因此两处都通过同一闸门检查可读性。
      this.reportRuntimeAvailable(managed);
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    });
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      managed.exited = true;
      this.clearIdleTimer(managed);
      const endedAt = Date.now();
      const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
      // 协议解析/stream 故障会先触发 protocol-close，再由 Host 用 SIGTERM
      // 回收仍存活的进程。若只透传主动 termination intent，desktop 只能看到最终信号，
      // 无法区分协议故障与受控退出；保留首次 cleanup 原因作为结构化根因。
      const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
      // 协议已立即失效，但 exit 先于 stderr EOF；保留旧 runtime 闭包身份收齐最后诊断。
      await transport.waitForStderrDrain();
      const stderr = stderrTail.snapshot();
      const exitContext = {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        code,
        signal,
        terminationKind,
        terminationReason,
      };
      // 之前日志只有新的 "process started"，缺少旧 pid 的退出轨迹。
      // agent native crash 后 UI 只会看到 protocol close/Session is not active，无法判断是崩溃还是主动重启。
      log("ZCode agent process exited", exitContext);
      if (terminationKind === "unexpected") {
        // Agent 顶层异常只写 stderr 并以非零 code 退出；stderr 过去仅走开发态
        // debug，生产日志只剩 code=1，无法还原异常。不能只按非零 code 判断：signal crash
        // 和长期运行的 Agent 自行 exit 0 同样是非预期退出。
        // 已有独立生命周期事件，显式标记包装日志，避免 Electron 将其再计为 JS 异常。
        errorLog(
          `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
          {
            ...exitContext,
            stderr,
          },
        );
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onExit({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            exitCode: code,
            signal,
            endedAt,
            terminationKind,
            runtimeReady: managed.readyAt != null,
            ...(terminationReason ? { terminationReason } : {}),
            runtimeGeneration,
            runtimeInstanceId,
            uptimeMs: Math.max(0, endedAt - startedAt),
            stderrLineCount: stderr.lineCount,
            ...(terminationKind === "unexpected" && stderr.tail.length > 0
              ? { stderrTail: stderr.tail }
              : {}),
          }),
        );
      }
    });
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout 说明协议请求/响应链路已经不可信。旧实现只 reject 当前请求，
      // 但 child 仍未 exit，后续同 workspace 会继续复用坏 client 并反复超时。
      // 这里主动回收进程树，让下一次 getClient 重新拉起干净的 app-server。
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // 根 child 的 exit 不等于同组 MCP 后代已退出。即使 protocol close
        // 来自根进程退出，也必须按原进程组完成幂等回收后才能释放 Host 所有权。
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    // 启动身份与进程同寿命：由真正 spawn 这个 client 的 manager 发送一次，bootstrap 固定后
    // 不接受业务命令替换。旧 Agent 明确返回 -32601 才兼容普通聊天继续；冲突/超时/校验失败
    // 说明身份不可信，必须关闭当前进程，避免保留对端已固定的旧 candidate。
    if (this.cuaHostInstanceId) {
      try {
        await client.request(
          zcodeProtocolMethods.runtimeIdentityInitialize,
          {
            identity: {
              hostInstanceId: this.cuaHostInstanceId,
              runtimeInstanceId,
            },
          },
          zcodeRuntimeIdentityInitializeResultSchema,
          { timeoutMs: 15_000 },
        );
      } catch (error) {
        if (!isJsonRpcMethodNotFound(error)) {
          if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
            this.processesByWorkspaceKey.delete(workspaceKey);
          }
          this.reportRuntimeUnavailable(managed);
          await this.cleanupManagedProcessWithRetry(
            managed,
            "startup-identity",
            "startup-identity-retry",
            "startup identity initialization",
          );
          // 非 method-not-found 的握手失败计入熔断：调用方若自动重试 getClient，
          // 持续冲突的 Agent 会反复 spawn→清理；达到阈值后由冷却窗口挡住新启动。
          // 计数与窗口起点放在清理收口之后，避免慢速回收占掉冷却窗口。
          this.noteStartupIdentityFailure(workspaceKey);
          throw new Error("ZCode agent startup CUA identity initialization failed.", {
            cause: error,
          });
        }
        warnLog("ZCode agent startup CUA identity was not accepted", {
          workspaceKey,
          pid: child.pid,
          hostInstanceId: this.cuaHostInstanceId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 启动成功（握手成功、旧 Agent 兼容或未配置握手）即清零熔断计数。
    this.clearStartupIdentityFailures(workspaceKey);
    return client;
  }

  async getRuntimeIdentity(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAgentRuntimeIdentity> {
    const workspaceKey = resolveWorkspaceKey(params);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    // runtime identity 是查询接口，旧实现却复用了启动型 getClient，
    // 导致 provider 保存等被动探测按 workspace 数量隐式 spawn Agent CLI。
    if (!managed || managed.exited || managed.child.killed) {
      throw new Error("ZCode agent runtime identity is unavailable.");
    }
    return managed.runtimeIdentity;
  }

  async canStart(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{ available: boolean; workspaceKey: string; reason?: string }> {
    const workspaceKey = resolveWorkspaceKey(params);
    try {
      const command = await this.commandResolver({
        ...params,
        ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
        workspaceKey,
      });
      return command
        ? { available: true, workspaceKey }
        : {
            available: false,
            workspaceKey,
            reason: "ZCODE_AGENT_SERVER_COMMAND is not configured",
          };
    } catch (error) {
      return {
        available: false,
        workspaceKey,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async disposeWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params);
    this.restartGenerationByWorkspaceKey.set(
      workspaceKey,
      (this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1,
    );
    this.abortPendingStarts(workspaceKey);
    const managed = this.processesByWorkspaceKey.get(workspaceKey);
    this.processesByWorkspaceKey.delete(workspaceKey);
    // dispose 不能把尚未完成的 start promise 从追踪表中删掉。删除会让
    // recovery/UI 的下一次 getClient 再开一条 spawn，旧 promise 随后又可能越过异步
    // resolve 回写进程池，形成同一 workspace 的 spawn/dispose 风暴。代际检查会让旧
    // promise 在真正 spawn 前失败，finally 再按 promise identity 清理 map。
    if (managed) {
      // restartWorkspaceProcess 只应回收当前 workspace 的 agent。
      // 不能复用 disposeAll，否则会把整个 manager 标记为已关闭，后续首发/预热无法重新拉起。
      this.reportRuntimeUnavailable(managed);
      await this.cleanupManagedProcessWithRetry(
        managed,
        "workspace-dispose",
        "workspace-dispose-retry",
        "workspace dispose",
      );
    }
  }

  private abortPendingStarts(
    workspaceKey: string,
    reason = new Error("Zody agent process start was cancelled."),
  ): void {
    const controllers = this.startAdmissionAbortControllersByWorkspaceKey.get(workspaceKey);
    if (!controllers) {
      return;
    }
    for (const controller of controllers) {
      controller.abort(reason);
    }
  }

  private abortAllPendingStarts(
    reason = new Error("ZCode agent process manager is disposed."),
  ): void {
    for (const workspaceKey of this.startAdmissionAbortControllersByWorkspaceKey.keys()) {
      this.abortPendingStarts(workspaceKey, reason);
    }
  }

  disposeAll(): void {
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();
    for (const managed of this.ownedProcesses) {
      this.recordTerminationIntent(managed, "manager-dispose");
      this.reportRuntimeUnavailable(managed);
      managed.client.dispose();
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();
  }

  async disposeAllAndWait(): Promise<void> {
    if (this.disposeAllInFlight) {
      return this.disposeAllInFlight;
    }
    this.disposed = true;
    this.storageStartupEmitter.dispose();
    this.abortAllPendingStarts();

    const managedProcesses = [...this.ownedProcesses];
    for (const managed of managedProcesses) {
      this.reportRuntimeUnavailable(managed);
    }
    this.processesByWorkspaceKey.clear();
    this.startingByWorkspaceKey.clear();

    // app/host 退出时旧逻辑只同步 dispose client，底层进程树的 SIGKILL 兜底
    // 依赖 unref timer，host 自己退出后 timer 不会再执行，zcode-cli 会残留为孤儿进程。
    // 这里让 host 可以等待每个 workspace 的 agent 进程树完成 graceful + force 清理。
    this.disposeAllInFlight = Promise.all(
      managedProcesses.map((managed) => this.cleanupManagedProcessForShutdown(managed)),
    ).then(() => undefined);
    try {
      await this.disposeAllInFlight;
    } finally {
      this.disposeAllInFlight = undefined;
    }
  }
}
