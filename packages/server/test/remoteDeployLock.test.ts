import { PassThrough } from "node:stream";
import { Emitter } from "@zody/rpc";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  StdioStream,
} from "@zody/server/remote/backend.js";
import { acquireRemoteDeployLock } from "@zody/server/remote/remoteDeployLock.js";
import { describe, expect, it, vi } from "vitest";

class ControlledLockBackend implements IRemoteBackend {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly closeEmitter = new Emitter<number>();
  readonly commands: string[] = [];

  dispose(): void {}

  detect(): Promise<RemoteEnvironment> {
    return Promise.resolve({ platform: "linux", arch: "x64" });
  }

  upload(): Promise<void> {
    return Promise.resolve();
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("not implemented"));
  }

  exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    return Promise.resolve({
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      onClose: this.closeEmitter.event,
    });
  }
}

function decodeEmbeddedLockScript(command: string): string {
  const encoded = command.match(/printf '%b' '([^']+)' >/u)?.[1];
  if (!encoded) {
    throw new Error("missing embedded lock-holder script");
  }
  return Buffer.from(
    encoded.replace(/\\([0-7]{3})/gu, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    ),
    "binary",
  ).toString("utf8");
}

describe("acquireRemoteDeployLock", () => {
  it("waits for the owner marker and builds a heartbeat stale-recovery lock", async () => {
    const backend = new ControlledLockBackend();
    let resolved = false;
    const acquirePromise = acquireRemoteDeployLock(backend, {
      lockDir: "~/.zcoder/server/.deploy.lock",
      ownerToken: "owner-test",
    }).then((handle) => {
      resolved = true;
      return handle;
    });

    await vi.waitFor(() => expect(backend.commands).toHaveLength(1));
    await Promise.resolve();
    expect(resolved).toBe(false);

    const command = backend.commands[0]!;
    // WSL 会在 bash -lc 参数边界提前展开未转义的局部 `$var`；lock-holder 必须先落盘再执行。
    expect(command).toContain("printf '%b'");
    expect(command).toContain(".holder-owner-test.sh");
    // Alpine/BusyBox 只有 POSIX sh；锁脚本不能把 bash 当成远端必备依赖。
    expect(command).toMatch(/\nsh .*\.holder-owner-test\.sh'/u);
    expect(command).not.toMatch(/\nbash .*\.holder-owner-test\.sh'/u);
    expect(command).not.toContain('owner_file="$lock_dir/owner"');
    const lockScript = decodeEmbeddedLockScript(command);
    expect(lockScript).toContain("mkdir");
    expect(lockScript).toContain("owner-test");
    expect(lockScript).toContain("sleep 30");
    expect(lockScript).toContain("-ge 600");
    expect(lockScript).toContain("current_owner");
    expect(lockScript).toContain("zcode-deploy-lock-acquired:owner-test");

    backend.stdout.write("zcode-deploy-lock-acquired:owner-test\n");
    const handle = await acquirePromise;
    expect(handle.ownerToken).toBe("owner-test");

    const stdinChunks: string[] = [];
    backend.stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString()));
    const releasePromise = handle.release();
    await vi.waitFor(() =>
      expect(stdinChunks.join("")).toContain("zcode-deploy-lock-release:owner-test"),
    );
    backend.closeEmitter.fire(0);
    await expect(releasePromise).resolves.toBeUndefined();
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it("rejects when the lock-holder exits before acquisition", async () => {
    const backend = new ControlledLockBackend();
    const acquirePromise = acquireRemoteDeployLock(backend, {
      ownerToken: "owner-closed",
    });
    await vi.waitFor(() => expect(backend.commands).toHaveLength(1));
    backend.stderr.write("lock holder failed");
    backend.closeEmitter.fire(23);

    await expect(acquirePromise).rejects.toThrow(/lock holder failed|23/u);
  });

  it("times out and destroys the owned lock stream when acquisition never completes", async () => {
    vi.useFakeTimers();
    try {
      const backend = new ControlledLockBackend();
      const acquirePromise = acquireRemoteDeployLock(backend, {
        ownerToken: "owner-acquire-timeout",
        acquireTimeoutMs: 20,
      });
      const settled = vi.fn();
      void acquirePromise.then(settled, settled);
      await Promise.resolve();
      expect(backend.commands).toHaveLength(1);
      backend.stderr.write("current owner is still alive");

      await vi.advanceTimersByTimeAsync(19);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      await expect(acquirePromise).rejects.toThrow(
        /acquisition timed out after 20ms.*owner=owner-acquire-timeout.*current owner/u,
      );
      expect(backend.stdin.destroyed).toBe(true);
      expect(backend.stdout.destroyed).toBe(true);
      expect(backend.stderr.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and destroys the owned lock stream when release never closes", async () => {
    const backend = new ControlledLockBackend();
    const acquirePromise = acquireRemoteDeployLock(backend, {
      ownerToken: "owner-timeout",
      releaseTimeoutMs: 20,
    });
    await vi.waitFor(() => expect(backend.commands).toHaveLength(1));
    backend.stdout.write("zcode-deploy-lock-acquired:owner-timeout\n");
    const handle = await acquirePromise;

    vi.useFakeTimers();
    try {
      const releasePromise = handle.release();
      const releaseSettled = vi.fn();
      void releasePromise.finally(releaseSettled).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(19);
      expect(releaseSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(releasePromise).rejects.toThrow(/timed out after 20ms.*owner=owner-timeout/u);
      expect(backend.stdin.destroyed).toBe(true);
      expect(backend.stdout.destroyed).toBe(true);
      expect(backend.stderr.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("serializes cooperative local lock holders but cannot fence an old uncooperative writer", async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const { mkdtemp, rm, writeFile, readFile, access } = await import("node:fs/promises");
  const { once } = await import("node:events");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "zody-r43-lock-"));
  const children = new Set<ReturnType<typeof spawn>>();
  class LocalBackend extends ControlledLockBackend {
    override async exec(command: string): Promise<StdioStream> {
      const emitter = new Emitter<number>();
      const child = spawn("/bin/sh", ["-c", command], {
        env: {
          HOME: process.env.HOME,
          USERPROFILE: process.env.USERPROFILE,
          TMPDIR: process.env.TMPDIR,
          PATH: process.env.PATH,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.once("close", (code) => {
        children.delete(child);
        emitter.fire(code ?? 1);
        emitter.dispose();
      });
      return {
        stdin: child.stdin!,
        stdout: child.stdout!,
        stderr: child.stderr!,
        onClose: emitter.event,
      };
    }
  }
  const backend = new LocalBackend();
  const lockDir = join(dir, "deploy.lock");
  let first: Awaited<ReturnType<typeof acquireRemoteDeployLock>> | undefined;
  let second: Awaited<ReturnType<typeof acquireRemoteDeployLock>> | undefined;
  try {
    first = await acquireRemoteDeployLock(backend, {
      lockDir,
      ownerToken: "first",
      acquireTimeoutMs: 3000,
    });
    const holder = [...children][0]!.pid!;
    const descendants = () => {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u)!;
          return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! };
        });
      const owned = new Set([holder]);
      for (let i = 0; i < rows.length; i++) {
        let changed = false;
        for (const row of rows)
          if (owned.has(row.ppid) && !owned.has(row.pid)) {
            owned.add(row.pid);
            changed = true;
          }
        if (!changed) break;
      }
      return rows.filter((row) => owned.has(row.pid));
    };
    await vi.waitFor(() =>
      expect(descendants().some((row) => row.command === "sleep 30")).toBe(true),
    );
    const heartbeatPids = descendants()
      .filter((row) => row.pid !== holder)
      .map((row) => row.pid);
    let secondAcquired = false;
    const pending = acquireRemoteDeployLock(backend, {
      lockDir,
      ownerToken: "second",
      acquireTimeoutMs: 5000,
    }).then((value) => {
      second = value;
      secondAcquired = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondAcquired).toBe(false);
    // 非协作旧进程能绕过锁写文件，必须依赖上线停用旧部署者的门禁。
    await writeFile(join(dir, "synthetic-target"), "old-writer");
    const firstHandle = first;
    first = undefined;
    await firstHandle.release();
    await vi.waitFor(() => {
      for (const pid of heartbeatPids) expect(() => process.kill(pid, 0)).toThrow();
    });
    await pending;
    expect(await readFile(join(dir, "synthetic-target"), "utf8")).toBe("old-writer");
    // 模拟连接中断，锁 holder 收到 EOF 后须删除自己的锁而非继续持有。
    const secondChild = [...children][0]!;
    const closed = once(secondChild, "close");
    secondChild.stdin!.end();
    await closed;
    second = undefined;
    await expect(access(lockDir)).rejects.toThrow();
  } finally {
    await first?.release().catch(() => undefined);
    await second?.release().catch(() => undefined);
    for (const child of children) child.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);

it("cancels a waiting lock channel immediately without affecting its backend", async () => {
  const backend = new ControlledLockBackend();
  const controller = new AbortController();
  const pending = acquireRemoteDeployLock(backend, {
    ownerToken: "synthetic",
    acquireTimeoutMs: 10000,
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(backend.commands).toHaveLength(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(backend.stdin.destroyed).toBe(true);
  expect(backend.stdout.destroyed).toBe(true);
  expect(backend.stderr.destroyed).toBe(true);
});
