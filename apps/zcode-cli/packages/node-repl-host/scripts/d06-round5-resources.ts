import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  D06_CANARY_CONTENT,
  createD06Workspace,
  errorText,
  type D06Paths,
} from "./d06-resources.js";

export interface D06Round5Paths extends D06Paths {
  round5Dir: string;
  nativeDir: string;
  nativeSourcePath: string;
  nativeAddonPath: string;
  nativeWritePath: string;
  ffiWritePath: string;
  browserClientPath: string;
  browserDocsDir: string;
  browserApiPath: string;
  browserDocumentsPath: string;
  browserOverviewPath: string;
  browserReadmePath: string;
  abortHandshakePath: string;
  abortPidPath: string;
  koffiIndexPath: string;
  koffiNativePath: string;
}

export class D06Round5CleanupError extends AggregateError {
  readonly d06CleanupFailed = true as const;
  readonly setupError: unknown;
  readonly cleanupError: unknown;

  constructor(setupError: unknown, cleanupError: unknown) {
    super(
      [setupError, cleanupError],
      `round 5 setup failed (${errorText(setupError)}); cleanup failed (${errorText(cleanupError)})`,
    );
    this.name = "D06Round5CleanupError";
    this.setupError = setupError;
    this.cleanupError = cleanupError;
  }
}

export function isD06Round5CleanupError(error: unknown): error is D06Round5CleanupError {
  return error instanceof D06Round5CleanupError;
}

export interface BoundedCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export async function createD06Round5Workspace(
  input: {
    indexPath: string;
    nativePath: string;
  },
  createBase: () => Promise<D06Paths> = createD06Workspace,
  removeBase = removeWorkspaceRoot,
): Promise<D06Round5Paths> {
  const base = await createBase();
  try {
    const round5Dir = join(base.root, "round5");
    const nativeDir = join(round5Dir, "native");
    const browserDocsDir = join(round5Dir, "browser-docs");
    await mkdir(round5Dir, { recursive: true });
    await Promise.all([
      mkdir(nativeDir, { recursive: true }),
      mkdir(browserDocsDir, { recursive: true }),
    ]);
    const paths: D06Round5Paths = {
      ...base,
      round5Dir,
      nativeDir,
      nativeSourcePath: join(nativeDir, "probe.c"),
      nativeAddonPath: join(nativeDir, "probe.node"),
      nativeWritePath: join(round5Dir, "native-write.txt"),
      ffiWritePath: join(round5Dir, "ffi-write.txt"),
      browserClientPath: join(round5Dir, "browser-client.mjs"),
      browserDocsDir,
      browserApiPath: join(browserDocsDir, "api.json"),
      browserDocumentsPath: join(browserDocsDir, "documents.json"),
      browserOverviewPath: join(browserDocsDir, "overview.md"),
      browserReadmePath: join(round5Dir, "README.md"),
      abortHandshakePath: join(round5Dir, "abort.handshake"),
      abortPidPath: join(round5Dir, "abort.pid"),
      koffiIndexPath: input.indexPath,
      koffiNativePath: input.nativePath,
    };
    paths.docsDir = browserDocsDir;
    paths.docsFile = paths.browserApiPath;
    paths.clientDir = browserDocsDir;
    paths.clientFile = paths.browserClientPath;
    await Promise.all([
      writeFile(paths.canaryReadPath, D06_CANARY_CONTENT, "utf8"),
      writeFile(paths.canaryWritePath, D06_CANARY_CONTENT, "utf8"),
      writeFile(paths.nativeWritePath, D06_CANARY_CONTENT, "utf8"),
      writeFile(paths.ffiWritePath, D06_CANARY_CONTENT, "utf8"),
    ]);
    return paths;
  } catch (error) {
    try {
      await removeBase(base.root);
    } catch (cleanupError) {
      throw new D06Round5CleanupError(error, cleanupError);
    }
    throw error;
  }
}

async function removeWorkspaceRoot(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true });
}

export async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes?: number },
): Promise<BoundedCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const maxBytes = options.maxBytes ?? 64 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let settled = false;
    let closeFallback: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (closeFallback) clearTimeout(closeFallback);
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode,
        signal: signalCode,
        stdout,
        stderr,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, maxBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(0, maxBytes);
    });
    child.once("error", (error) => {
      spawnError = errorText(error);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      signalCode = signal;
      // 直接 child 已退出；后代可能继续持有 stdout/stderr，close 不保证有界。
      closeFallback = setTimeout(finish, 50);
      closeFallback.unref();
    });
    child.once("close", finish);
  });
}

export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  return await waitFor(async () => {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }, timeoutMs);
}

export async function readPid(path: string): Promise<number | undefined> {
  const value = Number((await readFile(path, "utf8").catch(() => "")).trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await predicate();
}

export type PidStatus = "alive" | "dead" | "unknown";

export function pidStatus(pid: number): PidStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

export function isPidDead(pid: number): boolean {
  return pidStatus(pid) === "dead";
}

export function sha256Bytes(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const contents = await readFile(path);
  return { sha256: sha256Bytes(contents), bytes: contents.byteLength };
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
