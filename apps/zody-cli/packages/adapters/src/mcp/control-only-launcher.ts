import type { ChildProcess } from "node:child_process";
import { Duplex, type Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  createControlChannel,
  type ControlChannel,
  type ControlChannelRequestInput,
} from "@zody/zody-cua/control-channel";
import {
  ControlOnlyLauncherError,
  buildControlOnlyChildEnvironment,
  normalizeControlOnlyOptions,
  type ControlOnlyDiagnosticLauncher,
  type ControlOnlyLauncherCloseReason,
  type ControlOnlyLauncherClosedEvent,
  type StartControlOnlyDiagnosticLauncherOptions,
} from "./control-only-contract.js";
import {
  createControlOnlyInvalidationEmitter,
  createChildTerminator,
  destroyStdio,
  mapChannelClose,
  normalizeStartupError,
  startupEvent,
  withTimeout,
  type ExitInfo,
} from "./control-only-lifecycle.js";
import {
  createControlOnlyMaterial,
  readReadyLine,
  verifyReady,
  type ControlOnlyMaterial,
} from "./control-only-ready.js";

const CONTROL_ONLY_READY_MAX_BYTES = 8 * 1024;

interface LauncherState {
  closed: boolean;
  closeReason: ControlOnlyLauncherCloseReason | null;
  closedEmitted: boolean;
  invalidatedEmitted: boolean;
  finalizePromise: Promise<void> | null;
  startupPhase: boolean;
  channel: ControlChannel | null;
  childExit: ExitInfo | null;
  lastPendingRequests: number;
}

export {
  ControlOnlyLauncherError,
  ZCODE_NODE_REPL_CONTROL_FLAG,
  buildControlOnlyChildEnvironment,
  resolveOfficialControlOnlyLauncher,
  type ControlOnlyDiagnosticLauncher,
  type ControlOnlyLaunchCommand,
  type ControlOnlyLauncherCloseReason,
  type ControlOnlyLauncherClosedEvent,
  type ControlOnlyLauncherInvalidatedEvent,
  type ControlOnlyLauncherErrorCode,
  type ControlOnlySpawn,
  type OfficialControlOnlyLaunchInput,
  type StartControlOnlyDiagnosticLauncherOptions,
} from "./control-only-contract.js";

export async function startControlOnlyDiagnosticLauncher(
  options: StartControlOnlyDiagnosticLauncherOptions,
): Promise<ControlOnlyDiagnosticLauncher> {
  const config = normalizeControlOnlyOptions(options);
  const material: ControlOnlyMaterial = createControlOnlyMaterial(config.appIncarnation);

  let child: ChildProcess | null = null;
  const state: LauncherState = {
    channel: null,
    childExit: null,
    closeReason: null,
    closed: false,
    closedEmitted: false,
    invalidatedEmitted: false,
    finalizePromise: null,
    lastPendingRequests: 0,
    startupPhase: true,
  };
  let rejectStartup!: (error: Error) => void;
  const startupFailure = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
  });
  startupFailure.catch(() => undefined);
  let resolveExit!: (exit: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  let startupTimer: NodeJS.Timeout | undefined;
  const startupTimeout = new Promise<never>((_resolve, reject) => {
    startupTimer = setTimeout(() => {
      reject(new ControlOnlyLauncherError("startup_timeout", "control startup deadline expired"));
    }, config.startupTimeoutMs);
    startupTimer.unref?.();
  });
  startupTimeout.catch(() => undefined);

  const emitClosed = async (event: ControlOnlyLauncherClosedEvent): Promise<void> => {
    if (state.closedEmitted) return;
    state.closedEmitted = true;
    try {
      await config.onClosed?.(event);
    } catch {
      // A trusted observer cannot reopen the closed launcher.
    }
  };

  const emitInvalidated = createControlOnlyInvalidationEmitter(state, config.onInvalidated);

  const waitForExit = async (timeoutMs: number): Promise<ExitInfo | null> => {
    if (state.childExit) return state.childExit;
    return await withTimeout(exited, timeoutMs);
  };

  const terminateChild = createChildTerminator({
    getChild: () => child,
    getExit: () => state.childExit,
    waitForExit,
    closeTimeoutMs: config.closeTimeoutMs,
  });

  const finalize = (reason: ControlOnlyLauncherCloseReason, cause: Error | null): Promise<void> => {
    if (state.finalizePromise) return state.finalizePromise;
    state.closed = true;
    state.closeReason = state.closeReason ?? reason;
    state.finalizePromise = Promise.resolve().then(async () => {
      let closeError: Error | null = null;
      try {
        await state.channel?.dispose();
      } catch (error) {
        closeError = error instanceof Error ? error : new Error("control channel dispose failed");
      }
      destroyStdio(child);
      try {
        await terminateChild(true);
      } catch (error) {
        closeError =
          error instanceof Error
            ? error
            : new ControlOnlyLauncherError("close_timeout", "control-only launcher close failed");
      }
      if (closeError) state.closeReason = "cleanup_failed";
      const event = Object.freeze({
        cause: closeError ?? cause,
        exitCode: state.childExit?.code ?? null,
        message:
          closeError?.message ??
          cause?.message ??
          `control-only launcher closed: ${state.closeReason}`,
        pendingRequests: state.lastPendingRequests,
        reason: state.closeReason ?? reason,
        signal: state.childExit?.signal ?? null,
      }) satisfies ControlOnlyLauncherClosedEvent;
      await emitClosed(event);
      if (closeError) throw closeError;
    });
    emitInvalidated(
      state.closeReason,
      cause,
      cause?.message ?? `control-only launcher invalidated: ${state.closeReason}`,
    );
    return state.finalizePromise;
  };

  const failStartup = async (rawError: unknown): Promise<never> => {
    let error = normalizeStartupError(rawError);
    state.closed = true;
    state.closeReason = "startup_failed";
    emitInvalidated("startup_failed", error, "control-only launcher startup failed");
    rejectStartup(error);
    let cleanupError: Error | null = null;
    try {
      await state.channel?.dispose();
    } catch (disposeError) {
      cleanupError =
        disposeError instanceof Error ? disposeError : new Error("control channel dispose failed");
    }
    destroyStdio(child);
    try {
      await terminateChild(false);
    } catch (terminateError) {
      cleanupError =
        terminateError instanceof Error
          ? terminateError
          : new ControlOnlyLauncherError(
              "close_timeout",
              "control-only launcher child did not exit",
            );
    }
    if (error.code === "startup_eof" && state.childExit) {
      error = new ControlOnlyLauncherError(
        "startup_failed",
        "control launcher exited before ready",
        { cause: error },
      );
    }
    if (cleanupError) {
      const cleanupEvent = Object.freeze({
        cause: cleanupError,
        exitCode: state.childExit?.code ?? null,
        message: "control-only launcher startup cleanup failed",
        pendingRequests: 0,
        reason: "cleanup_failed" as const,
        signal: state.childExit?.signal ?? null,
      });
      await emitClosed(cleanupEvent);
      throw error;
    }
    await emitClosed(startupEvent(error, state.childExit));
    throw error;
  };

  try {
    if (config.beforeSpawn) {
      let bound: boolean;
      try {
        bound = config.beforeSpawn({
          appIncarnation: config.appIncarnation,
          producerIncarnation: material.binding.producerIncarnation,
        });
      } catch (error) {
        throw new ControlOnlyLauncherError(
          "startup_failed",
          "control producer binding failed",
          { cause: error },
        );
      }
      // 绑定必须先于真实 spawn：失败时不能留下无 owner binding 的控制子进程。
      if (!bound) {
        throw new ControlOnlyLauncherError(
          "startup_failed",
          "control producer binding rejected",
        );
      }
    }
    try {
      child = config.spawn(config.launch.command, config.launch.args, {
        cwd: config.launch.cwd,
        env: buildControlOnlyChildEnvironment(config.env),
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new ControlOnlyLauncherError("startup_failed", "control launcher spawn failed", {
        cause: error,
      });
    }

    const bootstrapStream = child.stdio[3] as Writable | null;
    const readyStream = child.stdio[4] as Readable | null;
    if (!bootstrapStream || !readyStream) {
      throw new ControlOnlyLauncherError(
        "startup_failed",
        "control launcher private fds unavailable",
      );
    }
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);

    child.on("error", (error) => {
      if (state.startupPhase) {
        emitInvalidated("startup_failed", error, "control-only launcher startup errored");
        rejectStartup(error);
      } else {
        void finalize("transport_error", error).catch(() => undefined);
      }
    });
    child.on("exit", (code, signal) => {
      state.childExit = { code, signal };
      resolveExit(state.childExit);
      if (state.startupPhase) {
        emitInvalidated("startup_failed", null, "control launcher exited before ready");
        rejectStartup(
          new ControlOnlyLauncherError("startup_failed", "control launcher exited before ready"),
        );
      } else {
        void finalize("child_exit", null).catch(() => undefined);
      }
    });

    const bootstrapWrite = (async () => {
      bootstrapStream.end(material.bootstrapLine);
      await finished(bootstrapStream);
    })();
    bootstrapWrite.catch(() => undefined);
    try {
      await Promise.race([bootstrapWrite, startupFailure, startupTimeout]);
    } catch (error) {
      if (error instanceof ControlOnlyLauncherError) throw error;
      throw new ControlOnlyLauncherError("startup_failed", "control bootstrap write failed", {
        cause: error,
      });
    }
    if (state.closed || state.childExit) {
      throw new ControlOnlyLauncherError("startup_failed", "control launcher closed before ready");
    }

    const readyRead = readReadyLine(readyStream, CONTROL_ONLY_READY_MAX_BYTES);
    readyRead.catch(() => undefined);
    const readyLine = await Promise.race([readyRead, startupFailure, startupTimeout]);
    if (state.closed || state.childExit) {
      throw new ControlOnlyLauncherError("startup_failed", "control launcher closed before ready");
    }
    if (child.pid === undefined) {
      throw new ControlOnlyLauncherError("startup_failed", "control launcher has no pid");
    }
    verifyReady(
      readyLine,
      { binding: material.binding, challenge: material.challenge, producerPid: child.pid },
      material.producerPublicKey,
    );

    // child 读 fd5 / 写 fd6；父端方向必须相反，读取 fd6、写入 fd5。
    const extraStdio = child.stdio as Array<Readable | Writable | null | undefined>;
    const controlReadable = (extraStdio[6] ?? null) as Readable | null;
    const controlWritable = (extraStdio[5] ?? null) as Writable | null;
    if (!controlReadable || !controlWritable) {
      throw new ControlOnlyLauncherError(
        "startup_failed",
        "control launcher private fds unavailable",
      );
    }
    const duplex = Duplex.from({ readable: controlReadable, writable: controlWritable });
    const channel = createControlChannel({
      binding: material.binding,
      duplex,
      keyId: "controller",
      onClosed: (event) => {
        state.lastPendingRequests = event.pendingRequests;
        if (state.startupPhase) {
          state.closed = true;
          state.closeReason = mapChannelClose(event.code);
          emitInvalidated(state.closeReason, event.cause, "control channel closed during startup");
          rejectStartup(
            new ControlOnlyLauncherError("startup_failed", "control channel closed during startup"),
          );
          return;
        }
        // 首个关闭原因优先：child 已异常退出时，finalize 会先记录 child_exit；
        // dispose 触发的 disposed 不能覆盖这个事实。
        state.closeReason ??= mapChannelClose(event.code);
        void finalize(mapChannelClose(event.code), event.cause).catch(() => undefined);
      },
      onRequest: config.onRequest,
      privateKey: material.controllerPrivateKey,
      requestTimeoutMs: config.requestTimeoutMs,
      role: "controller",
      trustedKeys: { producer: material.producerPublicKey },
    });
    state.channel = channel;
    state.startupPhase = false;
    if (state.closed || state.childExit) {
      throw new ControlOnlyLauncherError(
        "startup_failed",
        "control launcher exited during startup",
      );
    }

    return Object.freeze({
      binding: material.binding,
      get closed() {
        return state.closed;
      },
      get closeReason() {
        return state.closeReason;
      },
      request(input: ControlChannelRequestInput) {
        if (state.closed || state.finalizePromise || !state.channel) {
          return Promise.reject(
            new ControlOnlyLauncherError("closed", "control-only launcher is closed"),
          );
        }
        return state.channel.request(input);
      },
      close() {
        if (state.finalizePromise) return state.finalizePromise;
        if (state.closed) return Promise.resolve();
        return finalize("disposed", null);
      },
    }) satisfies ControlOnlyDiagnosticLauncher;
  } catch (error) {
    const normalized =
      state.childExit && error instanceof ControlOnlyLauncherError && error.code === "startup_eof"
        ? new ControlOnlyLauncherError("startup_failed", "control launcher exited before ready", {
            cause: error,
          })
        : error;
    return await failStartup(normalized);
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }
}
