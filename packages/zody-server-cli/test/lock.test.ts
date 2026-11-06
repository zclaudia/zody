import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DataRootLock } from "../src/runtime/lock.js";

const execFileAsync = promisify(execFile);

// 超出常见平台 pid 上限的值：process.kill(pid, 0) 必然 ESRCH，模拟已死的持锁进程。
const DEAD_PID = 2 ** 30;

/** 与 lock.ts 相同算法读取进程身份，用于构造“身份一致/不一致”的锁记录。 */
async function readTestProcessIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const { readFile } = await import("node:fs/promises");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
    return `${bootId.trim()}:${startTime}`;
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim();
  }
  return undefined;
}

async function spawnSleepingChild(): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    if (child.pid === undefined) {
      reject(new Error("test child did not start"));
      return;
    }
    // 等待进程真正存在（拿到 pid 即可 kill 0 成功）；事件循环已启动。
    const timer = setInterval(() => {
      try {
        process.kill(child.pid!, 0);
        clearInterval(timer);
        resolve();
      } catch {
        // 还没起来就再等一拍。
      }
    }, 10);
    child.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
  });
  return {
    pid: child.pid!,
    stop: () => child.kill("SIGKILL"),
  };
}

describe("DataRootLock", () => {
  it("recovers a stale lock left behind by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-stale-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("recovers a corrupted lock file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-corrupt-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, "not-json", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
  });

  it("refuses to steal the lock from a live process in this same pid", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-live-"));
    const lockFile = join(root, "run", "server.lock");

    // 活着的持有者必须是“本进程真实持有的锁”：PID 等于自己且 ownerToken 在本进程持有集合中。
    const holder = new DataRootLock(lockFile);
    await holder.acquire();

    const second = new DataRootLock(lockFile);
    await expect(second.acquire()).rejects.toThrow(/already running/);
    await holder.release();
  });

  // Bug 反例（a60ba6a7）：旧逻辑对 pid === process.pid 一律判存活；容器/WSL 重启或 PID 复用后，
  // 残留锁带着自己的 PID 会让 Supervisor 永远报 already running。
  it("recovers a leftover lock that records the current pid without a token this process holds", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-own-pid-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    // 旧格式残留 + 本进程 PID + 未知 ownerToken：无法证明是本进程写的。
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: process.pid, acquiredAt: 0, ownerToken: "not-held-by-us" })}\n`,
      "utf8",
    );

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
  });

  it.skipIf(process.platform === "win32")(
    "recovers a leftover lock whose pid now belongs to a different live process identity",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-identity-reuse-"));
      const lockFile = join(root, "run", "server.lock");
      await mkdir(join(root, "run"), { recursive: true });
      const child = await spawnSleepingChild();
      try {
        // 容器/WSL 重启场景：锁里的 PID 落到了另一个活进程上，但进程身份对不上。
        await writeFile(
          lockFile,
          `${JSON.stringify({
            pid: child.pid,
            acquiredAt: 0,
            ownerToken: "dead-holder",
            processIdentity: "boot-id:1",
          })}\n`,
          "utf8",
        );

        const lock = new DataRootLock(lockFile);
        await lock.acquire();
        await lock.release();
      } finally {
        child.stop();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a lock alive when the recorded process identity matches the live holder",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-identity-match-"));
      const lockFile = join(root, "run", "server.lock");
      await mkdir(join(root, "run"), { recursive: true });
      const child = await spawnSleepingChild();
      try {
        const identity = await readTestProcessIdentity(child.pid);
        expect(identity).toBeTruthy();
        await writeFile(
          lockFile,
          `${JSON.stringify({
            pid: child.pid,
            acquiredAt: 0,
            ownerToken: "live-holder",
            processIdentity: identity,
          })}\n`,
          "utf8",
        );

        const lock = new DataRootLock(lockFile);
        await expect(lock.acquire()).rejects.toThrow(/already running/);
        await expect(lock.inspect()).resolves.toMatchObject({ state: "active", pid: child.pid });
      } finally {
        child.stop();
      }
    },
  );

  it("still honors legacy pid-only locks from live foreign processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-legacy-live-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    const child = await spawnSleepingChild();
    try {
      // 已部署的旧格式锁文件没有身份字段：只能按 PID 判定，活进程持有时不被接管。
      await writeFile(lockFile, `${JSON.stringify({ pid: child.pid, acquiredAt: 0 })}\n`, "utf8");

      const lock = new DataRootLock(lockFile);
      await expect(lock.acquire()).rejects.toThrow(/already running/);
    } finally {
      child.stop();
    }
  });

  it.skipIf(process.platform === "win32")(
    "writes a process identity into new lock records",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-identity-write-"));
      const lockFile = join(root, "run", "server.lock");
      const lock = new DataRootLock(lockFile);
      await lock.acquire();
      try {
        const record = JSON.parse(await readFile(lockFile, "utf8"));
        expect(record.pid).toBe(process.pid);
        expect(typeof record.ownerToken).toBe("string");
        // 新格式必须带进程身份字段，供重启/复用场景核对。
        expect(typeof record.processIdentity).toBe("string");
        expect(record.processIdentity.length).toBeGreaterThan(0);
      } finally {
        await lock.release();
      }
    },
  );

  it("reports missing, stale, active and malformed lock owners without mutating the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-inspect-"));
    const lockFile = join(root, "run", "server.lock");
    const lock = new DataRootLock(lockFile);

    await expect(lock.inspect()).resolves.toMatchObject({ state: "missing" });
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID })}\n`, "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: DEAD_PID });
    // PID 等于自己但 ownerToken 不是本进程持有的，不算 active（身份判活）。
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: process.pid, ownerToken: "not-ours" })}\n`,
      "utf8",
    );
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: process.pid });
    const holder = new DataRootLock(lockFile);
    await holder.acquire();
    await expect(lock.inspect()).resolves.toMatchObject({ state: "active", pid: process.pid });
    await holder.release();
    await writeFile(lockFile, "not-json", "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "invalid" });
    await expect(readFile(lockFile, "utf8")).resolves.toBe("not-json");
  });

  it("keeps locks under different data roots isolated (R2-CLI-13)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zcode-r2-lock-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zcode-r2-lock-b-"));
    const lockA = new DataRootLock(join(rootA, "run", "server.lock"));
    const lockB = new DataRootLock(join(rootB, "run", "server.lock"));
    await lockA.acquire();
    await lockB.acquire();
    await lockA.release();
    await lockB.release();
    // 释放后可重新获取。
    await lockA.acquire();
    await lockA.release();
  });

  it.skipIf(process.platform === "win32")(
    "does not delete a replacement lock owned by another token during release",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-owner-"));
      const lockFile = join(root, "run", "server.lock");
      const replacement = join(root, "run", "replacement.lock");
      const lock = new DataRootLock(lockFile);
      await lock.acquire();
      await writeFile(
        replacement,
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          ownerToken: "replacement-owner",
        })}\n`,
        "utf8",
      );
      await rename(replacement, lockFile);

      await lock.release();

      expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({
        ownerToken: "replacement-owner",
      });
    },
  );

  it("allows only one real process to claim the same stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-race-"));
    const lockFile = join(root, "server.lock");
    const barrierFile = join(root, "go");
    const resultsFile = join(root, "results");
    const readyDir = join(root, "ready");
    await mkdir(readyDir);
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");
    // 根目录 Vitest 与 package 脚本的 cwd 不同，不能用 cwd 推导源码路径，否则子进程会导入不存在的 root/src/runtime/lock.ts。
    const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
    const childProgram = `
      import { access, appendFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      const { DataRootLock } = await import(process.env.ZODY_TEST_LOCK_MODULE);
      await writeFile(process.env.ZODY_TEST_LOCK_READY, "ready\\n");
      while (true) { try { await access(process.env.ZODY_TEST_LOCK_BARRIER); break; } catch { await delay(5); } }
      const lock = new DataRootLock(process.env.ZODY_TEST_LOCK_FILE);
      try {
        await lock.acquire();
        await appendFile(process.env.ZODY_TEST_LOCK_RESULTS, "success " + process.env.ZODY_TEST_LOCK_CHILD + "\\n");
        await delay(1_000);
        await lock.release();
      } catch {
        await appendFile(process.env.ZODY_TEST_LOCK_RESULTS, "locked " + process.env.ZODY_TEST_LOCK_CHILD + "\\n");
      }
    `;
    const children = Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", childProgram],
            {
              env: {
                ...process.env,
                ZODY_TEST_LOCK_MODULE: moduleUrl,
                ZODY_TEST_LOCK_BARRIER: barrierFile,
                ZODY_TEST_LOCK_FILE: lockFile,
                ZODY_TEST_LOCK_READY: join(readyDir, String(index)),
                ZODY_TEST_LOCK_RESULTS: resultsFile,
                ZODY_TEST_LOCK_CHILD: String(index),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let childError = "";
          child.stderr.on("data", (chunk) => {
            childError += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(childError || `lock child exited ${code}`)),
          );
        }),
    );
    // 先等待所有子进程进入 barrier；只按固定时间放行会让慢启动的子进程在首个 owner
    // 释放后再次成功获取锁，导致“一个 success”断言随机出现多个 success。
    const readyDeadline = Date.now() + 20_000;
    let allChildrenReady = false;
    while (Date.now() < readyDeadline) {
      if ((await readdir(readyDir)).length === children.length) {
        allChildrenReady = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(barrierFile, "go", "utf8");
    await Promise.all(children);
    const results = (await readFile(resultsFile, "utf8")).trim().split("\n");
    expect(allChildrenReady).toBe(true);
    expect(results.filter((result) => result.startsWith("success "))).toHaveLength(1);
    expect(results.filter((result) => result.startsWith("locked "))).toHaveLength(7);
  }, 30_000);
});
