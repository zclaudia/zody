import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeEmptyOutputDirectory } from "./bash-file-output.js";
import { resolveBashMaxOutputLength } from "./bash-output-policy.js";
import { cleanupStaleExecutionOutput } from "./bash-output-retention.js";
import { ShellInitSnapshotManager, cleanupStaleShellInitSnapshots } from "./shell-init-snapshot.js";
import { OutputCollector, type AggregatePersistedOutputBudget } from "./output-collector.js";
import {
  DEFAULT_INLINE_OUTPUT_BYTES,
  BASH_RUNTIME_OUTPUT_LIMIT_BYTES,
  DEFAULT_MAX_PERSISTED_OUTPUT_BYTES,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_PROGRESS_TAIL_BYTES,
  DEFAULT_PROGRESS_THRESHOLD_MS,
  isBashMergedOutputRequest,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
} from "./execution-utils.js";
import type {
  ActiveExecutionRecord,
  BackgroundTaskRecord,
  ExecutionOutputPaths,
  NodeExecutionAdapterOptions,
  StopReason,
} from "./execution-adapter-types.js";
import type {
  BackgroundExecutionSnapshot,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
} from "@zcode/contracts";

export class NodeExecutionAdapterBase {
  protected readonly activeExecutions = new Map<string, ActiveExecutionRecord>();

  protected readonly backgroundTasks = new Map<string, BackgroundTaskRecord>();

  protected readonly pendingBashProcessTreeKills = new Map<Promise<void>, { ref(): unknown }>();

  protected readonly shellInitRetentionCleanup: Promise<unknown>;

  protected readonly shellInitSnapshots = new ShellInitSnapshotManager();

  protected readonly outputPathsByRequest = new WeakMap<
    ExecutionRequest,
    { rootDir: string; paths: ExecutionOutputPaths }
  >();

  protected closePromise?: Promise<void>;

  protected readonly options: NodeExecutionAdapterOptions;

  private readonly configuredOutputRootDir: string;

  private activeOutputRootDir?: string;

  private fallbackOutputRootDir?: string;

  private outputRootPromise?: Promise<string>;

  /** I16：第二层默认数据根是持久根；首次选中时补一次输出与 shell 快照的按龄扫描。 */
  private defaultRootRetentionCleanup?: Promise<unknown>;

  /** I16：start()/lifecycle 在 run() 登记 active execution 前准备输出；close() 必须等它们结束。 */
  private readonly pendingOutputPreparations = new Set<Promise<unknown>>();

  /** I16：background 预创建的空输出文件；spawn 失败/取消时只删除这些本次新建的文件。 */
  private readonly createdOutputFilesByRequest = new WeakMap<ExecutionRequest, string[]>();

  protected readonly outputRetentionCleanup: Promise<unknown>;

  constructor(options: NodeExecutionAdapterOptions = {}) {
    this.options = options;
    const rootDir = options.outputRootDir ?? resolveDefaultOutputRootDir(options.processEnv);
    this.configuredOutputRootDir = rootDir;
    this.shellInitRetentionCleanup = cleanupStaleShellInitSnapshots({ rootDir }).catch(
      () => undefined,
    );
    // I16：保留期清理由 execution adapter 独占；构造时异步扫描，close() 等待其结束。
    this.outputRetentionCleanup = cleanupStaleExecutionOutput(rootDir).catch(() => undefined);
  }

  protected createOutputCollector(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
    legacyOutputEncoding: string | null,
    onPersistedLimit?: () => void,
    aggregatePersistedBudget?: AggregatePersistedOutputBudget,
  ): OutputCollector {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const outputPath = this.outputPathForRequest(request, streamName);
    return new OutputCollector({
      maxInlineBytes: this.inlineLimit(request),
      maxPersistedBytes: this.persistedOutputLimit(request),
      legacyOutputEncoding,
      maxTailBytes: this.progressTailBytes,
      onPersistedLimit,
      outputPath,
      persistOutput,
      aggregatePersistedBudget,
    });
  }

  protected outputPathForRequest(
    request: ExecutionRequest,
    streamName: "stdout" | "stderr",
  ): string | undefined {
    const paths = this.outputPathsForRequest(request);
    return streamName === "stdout"
      ? paths.stdoutPersistedOutputPath
      : paths.stderrPersistedOutputPath;
  }

  protected outputPathsForRequest(request: ExecutionRequest): ExecutionOutputPaths {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    const usesBashMergedOutput = isBashMergedOutputRequest(request);
    if (persistOutput === "none" && !usesBashMergedOutput) return {};

    // 根尚未完成可用性判定时先按配置根给出路径；prepareOutputPaths() 会在执行前用实际选中的根覆盖缓存。
    const rootDir = this.activeOutputRootDir ?? this.configuredOutputRootDir;
    const existing = this.outputPathsByRequest.get(request);
    if (existing?.rootDir === rootDir) return existing.paths;

    const paths = this.deriveOutputPaths(request, rootDir);
    this.outputPathsByRequest.set(request, { rootDir, paths });
    return paths;
  }

  /** 后台生命周期把同一请求复制成 runRequest 时，复用已确定的根与路径（含缺省 toolCallId 生成的随机名）。 */
  protected shareOutputPaths(from: ExecutionRequest, to: ExecutionRequest): void {
    const prepared = this.outputPathsByRequest.get(from);
    if (prepared) this.outputPathsByRequest.set(to, prepared);
  }

  /**
   * I16：记录后台预创建的空输出文件。只有这里登记的文件才允许在 spawn 失败/取消时删除，
   * 避免误删同路径既有输出或本次已经写入内容的文件。
   */
  protected rememberCreatedOutputFiles(request: ExecutionRequest, paths: string[]): void {
    if (paths.length === 0) this.createdOutputFilesByRequest.delete(request);
    else this.createdOutputFilesByRequest.set(request, paths);
  }

  /** I16：删除后台预创建、但本次执行从未写入的输出文件，并清理因此变空的 toolCall 目录。 */
  protected async discardCreatedOutputFiles(request: ExecutionRequest): Promise<void> {
    const created = this.createdOutputFilesByRequest.get(request);
    if (!created) return;
    this.createdOutputFilesByRequest.delete(request);
    for (const path of created) {
      // 清理失败不能覆盖取消/spawn 的真实结果。
      await rm(path, { force: true }).catch(() => undefined);
      await removeEmptyOutputDirectory(path);
    }
  }

  /**
   * I16：执行前确定本次输出根并生成路径。
   * 配置根、默认数据根都不可写时回落到进程临时根；回调层的记录直接复用这里的路径。
   */
  protected async prepareOutputPaths(request: ExecutionRequest): Promise<ExecutionOutputPaths> {
    const persistOutput = request.outputLimit?.persistOutput ?? "none";
    if (persistOutput === "none" && !isBashMergedOutputRequest(request)) return {};
    const rootDir = await this.resolveOutputRootDir();
    // 同一请求重复 prepare（run 前、后台记录前）必须复用同一 toolCall 目录：
    // 缺省 toolCallId 由随机名补齐，重新派生会得到不同路径并造成记录与文件错位。
    const existing = this.outputPathsByRequest.get(request);
    if (existing?.rootDir === rootDir) return existing.paths;
    const paths = this.deriveOutputPaths(request, rootDir);
    this.outputPathsByRequest.set(request, { rootDir, paths });
    return paths;
  }

  private deriveOutputPaths(request: ExecutionRequest, rootDir: string): ExecutionOutputPaths {
    const usesBashMergedOutput = isBashMergedOutputRequest(request);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const toolCallId = sanitizePathSegment(
      String(request.trace?.attributes?.toolCallId ?? crypto.randomUUID()),
    );
    // I16：每次执行独占 <sessionId>/<toolCallId>/ 目录，同一 session 的并发执行不共用输出文件。
    const stdoutPersistedOutputPath = join(rootDir, sessionId, toolCallId, "stdout.log");
    if (usesBashMergedOutput) {
      return {
        outputPath: stdoutPersistedOutputPath,
        stdoutPersistedOutputPath,
      };
    }
    return {
      outputPath: stdoutPersistedOutputPath,
      stderrPersistedOutputPath: join(rootDir, sessionId, toolCallId, "stderr.log"),
      stdoutPersistedOutputPath,
    };
  }

  /** 已选定的输出根；bash 内部 source 脚本等同一写域必须复用，避免配置根不可写时在 spawn 前失败。 */
  protected get outputRootDir(): string {
    return this.activeOutputRootDir ?? this.configuredOutputRootDir;
  }

  private async resolveOutputRootDir(): Promise<string> {
    this.outputRootPromise ??= this.selectOutputRootDir();
    return await this.outputRootPromise;
  }

  /**
   * I16：登记一次“执行前输出准备”。start()/runBashWithBackgroundLifecycle() 在 run()
   * 登记 active execution 之前就会写目录；close() 必须先等这些准备结束，再删除临时根，
   * 否则准备过程可能在临时根删除后重新创建它并留下残留。
   */
  protected trackOutputPreparation<T>(preparation: Promise<T>): Promise<T> {
    this.pendingOutputPreparations.add(preparation);
    void preparation
      .finally(() => this.pendingOutputPreparations.delete(preparation))
      .catch(() => undefined);
    return preparation;
  }

  private async selectOutputRootDir(): Promise<string> {
    // I16：按龄扫描与首次执行并行，不阻塞首个命令；扫描只删超龄文件和因此变空的目录，
    // 不会碰刚创建的 session/toolCall 目录。
    if (await this.isUsableOutputRoot(this.configuredOutputRootDir)) {
      this.activeOutputRootDir = this.configuredOutputRootDir;
      return this.configuredOutputRootDir;
    }
    const defaultRootDir = resolveDefaultOutputRootDir(this.options.processEnv);
    if (
      defaultRootDir !== this.configuredOutputRootDir &&
      (await this.isUsableOutputRoot(defaultRootDir))
    ) {
      this.activeOutputRootDir = defaultRootDir;
      // I16：第二层默认数据根仍是持久根。输出文件与 shell 启动快照都写在实际选中的根，
      // 因此首次选中时两者都要按既有保留策略扫描一次，并纳入 close() 等待。
      this.defaultRootRetentionCleanup = Promise.all([
        cleanupStaleExecutionOutput(defaultRootDir),
        cleanupStaleShellInitSnapshots({ rootDir: defaultRootDir }),
      ]).catch(() => undefined);
      return defaultRootDir;
    }
    // I16 决策：前两层都不可用时落到本 adapter 独占的系统临时根；close() 删除，不参与 30 天扫描。
    const temporaryRootDir = await mkdtemp(join(tmpdir(), "zody-cli-exec-"));
    this.fallbackOutputRootDir = temporaryRootDir;
    this.activeOutputRootDir = temporaryRootDir;
    return temporaryRootDir;
  }

  private async isUsableOutputRoot(rootDir: string): Promise<boolean> {
    try {
      await mkdir(rootDir, { recursive: true });
      // 已存在的只读目录 mkdir 也会成功，必须真实写入探针才能暴露 EACCES/EROFS/ENOSPC。
      const probePath = join(rootDir, `.zody-output-probe-${crypto.randomUUID()}`);
      try {
        const handle = await open(probePath, "w", 0o600);
        // close 失败不影响“可写”结论；finally 保证探针即使 close 抛错也会被删除。
        await handle.close().catch(() => undefined);
      } finally {
        await rm(probePath, { force: true }).catch(() => undefined);
      }
      return true;
    } catch (error) {
      // I16 spec：只有文件系统写入失败才进入下一层根；未知异常照常上抛，避免把编程错误
      // 伪装成“根不可写”并掩盖真实失败。
      if (isOutputRootFallbackError(error)) return false;
      throw error;
    }
  }

  protected inlineLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxInlineBytes ??
      request.outputLimit?.maxBufferBytes ??
      DEFAULT_INLINE_OUTPUT_BYTES
    );
  }

  protected bashInlineLimit(request: ExecutionRequest): number {
    return resolveBashMaxOutputLength(this.processEnv, this.inlineLimit(request));
  }

  protected persistedOutputLimit(request: ExecutionRequest): number {
    return (
      request.outputLimit?.maxPersistedBytes ??
      this.options.maxPersistedOutputBytes ??
      (isBashMergedOutputRequest(request)
        ? BASH_RUNTIME_OUTPUT_LIMIT_BYTES
        : DEFAULT_MAX_PERSISTED_OUTPUT_BYTES)
    );
  }

  protected createBackgroundTaskRecord(args: {
    controller: AbortController;
    outputPaths: ExecutionOutputPaths;
    startedAt: Date;
    taskId: string;
    request: ExecutionRequest;
  }): BackgroundTaskRecord {
    let resolveCompletion: (snapshot: BackgroundExecutionSnapshot) => void = () => undefined;
    const completion = new Promise<BackgroundExecutionSnapshot>((resolve) => {
      resolveCompletion = resolve;
    });
    return {
      completion,
      controller: args.controller,
      resolveCompletion,
      startedAt: args.startedAt,
      status: "running",
      taskId: args.taskId,
      sessionId: args.request.trace?.sessionId,
      isBash: isBashMergedOutputRequest(args.request),
      legacyOutputEncoding: null,
      ...args.outputPaths,
    };
  }

  protected updateBackgroundTaskRecordFromEvent(
    record: BackgroundTaskRecord,
    event: ExecutionEvent,
  ): void {
    if (event.type === "started") {
      record.pid = event.pid;
      return;
    }
    if (event.type !== "progress") return;
    record.pid = event.pid ?? record.pid;
    record.stderrBytes = event.stderrBytes;
    record.stderrTail = event.stderrTail;
    record.stdoutBytes = event.stdoutBytes;
    record.stdoutTail = event.stdoutTail;
  }

  protected finalizeBackgroundTaskRecord(
    record: BackgroundTaskRecord,
    result: ExecutionResult,
  ): void {
    record.status = result.status;
    record.completedAt = result.completedAt;
    record.pid = result.pid ?? record.pid;
    record.result = result;
    record.error = result.error;
    record.resolveCompletion(this.snapshot(record));
  }

  protected snapshot(record: BackgroundTaskRecord): BackgroundExecutionSnapshot {
    return {
      taskId: record.taskId,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      pid: record.pid,
      stderrBytes: record.stderrBytes,
      stderrTail: record.stderrTail,
      stdoutBytes: record.stdoutBytes,
      stdoutTail: record.stdoutTail,
      outputPath: record.outputPath,
      stderrPersistedOutputPath: record.stderrPersistedOutputPath,
      stdoutPersistedOutputPath: record.stdoutPersistedOutputPath,
      result: record.result,
      error: record.error,
    };
  }

  protected get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  protected get processEnv(): NodeJS.ProcessEnv {
    return this.options.processEnv ?? process.env;
  }

  protected get progressIntervalMs(): number {
    return Math.max(1, this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  }

  protected get progressTailBytes(): number {
    return Math.max(0, this.options.progressTailBytes ?? DEFAULT_PROGRESS_TAIL_BYTES);
  }

  protected get progressThresholdMs(): number {
    return Math.max(0, this.options.progressThresholdMs ?? DEFAULT_PROGRESS_THRESHOLD_MS);
  }

  protected completeActiveExecution(executionId: string): void {
    const record = this.activeExecutions.get(executionId);
    if (!record) return;
    record.resolveCompletion();
    this.activeExecutions.delete(executionId);
  }

  protected registerActiveExecution(stop: (reason: StopReason) => void): string {
    const executionId = crypto.randomUUID();
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.activeExecutions.set(executionId, {
      completion,
      resolveCompletion,
      stop,
    });
    return executionId;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return await this.closePromise;
  }

  protected async shutdown(): Promise<void> {
    for (const record of this.backgroundTasks.values()) {
      if (record.status === "running") {
        record.status = "cancelled";
        record.controller.abort();
      }
    }

    const activeExecutions = Array.from(this.activeExecutions.values());
    for (const record of activeExecutions) {
      record.stop("cancelled");
    }

    await Promise.allSettled(activeExecutions.map((record) => record.completion));
    // I16：start()/runBashWithBackgroundLifecycle() 在 run() 登记 active execution 前就会
    // 创建输出目录；先等这些准备结束，避免临时根删除后又被准备过程重新创建。
    while (this.pendingOutputPreparations.size > 0) {
      await Promise.allSettled(Array.from(this.pendingOutputPreparations));
    }
    // 直写后没有 pipe 保活，仅 await Promise 会让 Node 在 SIGKILL 前退出。
    // active execution 已结算，所有主动终止均已登记；只在 shutdown 引用既有清理句柄。
    for (const handle of this.pendingBashProcessTreeKills.values()) handle.ref();
    await Promise.allSettled(Array.from(this.pendingBashProcessTreeKills.keys()));
    await this.shellInitRetentionCleanup;
    await this.outputRetentionCleanup;
    // 根选择可能仍在进行；先等它落定，避免默认根的按龄扫描未被等待，
    // 也避免删除回落根后又被重新创建。
    await this.outputRootPromise?.catch(() => undefined);
    await this.defaultRootRetentionCleanup;
    const fallbackRootDir = this.fallbackOutputRootDir;
    this.fallbackOutputRootDir = undefined;
    if (fallbackRootDir) {
      // 第三层临时根是临时降级，close() 完成前删除；持久根中已产生的输出不删除。
      await rm(fallbackRootDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.shellInitSnapshots.cleanup();
  }
}

/** I16 spec 列出的回落触发错误；其它异常不视为“根不可写”。 */
const OUTPUT_ROOT_FALLBACK_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "ENOTDIR",
  "EEXIST",
]);

function isOutputRootFallbackError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return OUTPUT_ROOT_FALLBACK_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code));
}
