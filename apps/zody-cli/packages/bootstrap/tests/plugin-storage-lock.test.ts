import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// I06 反例夹具：只旁路记录 cache 命中读是否仍进入跨进程 seed 写锁。
// 实际加锁/释放仍委托真实实现，不改变被测语义。
const seedLockCalls = vi.hoisted(() => [] as string[]);
vi.mock("../src/app/official-plugin-seed-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/official-plugin-seed-lock.js")>();
  return {
    ...actual,
    withOfficialPluginSeedLock<T>(
      targetRoot: string,
      action: () => T,
      options?: Parameters<typeof actual.withOfficialPluginSeedLock>[2],
    ): T {
      seedLockCalls.push(targetRoot);
      return actual.withOfficialPluginSeedLock(targetRoot, action, options);
    },
  };
});

import {
  withPluginStorageLock,
  withPluginStorageWriteGateWhenNeeded,
} from "../src/lib/plugin-storage-lock.js";
import { listZCodePlugins } from "../src/plugins.js";

describe("withPluginStorageLock", () => {
  it("serializes operations on the same storage root", async () => {
    const order: string[] = [];
    const slow = withPluginStorageLock("/root-a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    const fast = withPluginStorageLock("/root-a", async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs different roots concurrently", async () => {
    const order: string[] = [];
    await Promise.all([
      withPluginStorageLock("/root-a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
      }),
      withPluginStorageLock("/root-b", async () => {
        order.push("b");
      }),
    ]);
    expect(order[0]).toBe("a-start");
    expect(order).toContain("b");
    // b should not wait for a-end
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a-end"));
  });

  it("releases the lock even if the operation throws", async () => {
    await expect(
      withPluginStorageLock("/root-c", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // next op still runs
    await expect(
      withPluginStorageLock("/root-c", async () => "ok"),
    ).resolves.toBe("ok");
  });
});

describe("plugin storage read scheduling", () => {
  const temporaryRoots: string[] = [];
  afterAll(() => {
    for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  });

  it("does not take the cross-process seed write lock for a cache-hit read", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-plugin-read-fast-path-"));
    temporaryRoots.push(root);
    const pluginStorageRoot = join(root, "plugins");
    const options = {
      pluginStorageRoot,
      skipUserConfig: true,
      userConfigPath: join(root, "config.json"),
      workingDirectory: root,
    };

    // 第一次读取是冷启动：允许 lazy seed，并会进入跨进程 seed 锁。
    const cold = listZCodePlugins(options);
    expect(
      cold.plugins.some((plugin) => plugin.id === "skill-creator@zcode-plugins-official"),
    ).toBe(true);
    expect(
      existsSync(
        join(
          pluginStorageRoot,
          "cache",
          "zcode-plugins-official",
          "skill-creator",
          "0.1.0",
          ".zody-plugin-seed.json",
        ),
      ),
    ).toBe(true);
    expect(seedLockCalls.length).toBeGreaterThan(0);

    // 第二次读取是缓存命中：只允许读已提交状态，不得进入 seed 写锁。
    seedLockCalls.length = 0;
    const startedAt = performance.now();
    const warm = listZCodePlugins(options);
    const elapsedMs = performance.now() - startedAt;

    expect(
      warm.plugins.some((plugin) => plugin.id === "skill-creator@zcode-plugins-official"),
    ).toBe(true);
    expect(elapsedMs).toBeLessThan(500);
    expect(seedLockCalls).toEqual([]);
  });

  it("runs a read immediately while the write gate is held when no lazy write is needed", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-plugin-read-gate-"));
    temporaryRoots.push(root);
    const pluginStorageRoot = join(root, "plugins");
    let releaseGate = (): void => {};
    let markGateEntered = (): void => {};
    const gateEntered = new Promise<void>((resolve) => {
      markGateEntered = resolve;
    });
    const gate = withPluginStorageLock(pluginStorageRoot, async () => {
      markGateEntered();
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    });
    await gateEntered;

    try {
      // listZCodePlugins 是同步投影，本身不会加入 async promise 链；读快路径是否
      // 真正绕过写闸门由 needsWrite=false 分支证明。
      await expect(
        withPluginStorageWriteGateWhenNeeded(pluginStorageRoot, () => false, async () => "read"),
      ).resolves.toBe("read");
    } finally {
      releaseGate();
      await gate;
    }
  });

  it("queues a lazy write behind the in-flight write gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-plugin-write-gate-"));
    temporaryRoots.push(root);
    const pluginStorageRoot = join(root, "plugins");
    let releaseGate = (): void => {};
    let markGateEntered = (): void => {};
    const gateEntered = new Promise<void>((resolve) => {
      markGateEntered = resolve;
    });
    const gate = withPluginStorageLock(pluginStorageRoot, async () => {
      markGateEntered();
      await new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    });
    await gateEntered;

    let operationRan = false;
    const pending = withPluginStorageWriteGateWhenNeeded(
      pluginStorageRoot,
      () => true,
      async () => {
        operationRan = true;
        return "written";
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(operationRan).toBe(false);
    } finally {
      releaseGate();
      await gate;
    }
    await expect(pending).resolves.toBe("written");
    expect(operationRan).toBe(true);
  });
});
