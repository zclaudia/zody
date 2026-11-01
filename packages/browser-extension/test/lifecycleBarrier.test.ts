import { describe, expect, it } from "vitest";
import { LifecycleBarrier } from "../src/lifecycleBarrier.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("LifecycleBarrier", () => {
  it("keeps create/attach behind a delayed cleanup and never lets cleanup see the new tab", async () => {
    const barrier = new LifecycleBarrier();
    const releaseCleanup = deferred();
    const chromeCalls: string[] = [];
    let cleanupSnapshot: string[] = [];

    const cleanup = barrier.begin(async () => {
      // 模拟旧 cleanup 的台账快照 + Chrome detach/close。
      cleanupSnapshot = ["old-agent-tab"];
      chromeCalls.push("cleanup:detach");
      await releaseCleanup.promise;
      chromeCalls.push("cleanup:close-agent");
    });

    // 清理未完成时，create/attach 只能等待，不能调用 Chrome API。
    const create = (async () => {
      await barrier.wait();
      chromeCalls.push("tabs.create");
    })();
    const attach = (async () => {
      await barrier.wait();
      chromeCalls.push("debugger.attach");
    })();
    await tick();
    expect(chromeCalls).toEqual(["cleanup:detach"]);
    expect(barrier.active).toBe(true);

    releaseCleanup.resolve();
    await Promise.all([cleanup, create, attach]);
    expect(chromeCalls).toEqual([
      "cleanup:detach",
      "cleanup:close-agent",
      "tabs.create",
      "debugger.attach",
    ]);
    // 新 create 不可能进入旧 cleanup 的快照。
    expect(cleanupSnapshot).toEqual(["old-agent-tab"]);
    expect(barrier.active).toBe(false);
  });

  it("coalesces concurrent cleanups into one flight and releases waiters even on failure", async () => {
    const barrier = new LifecycleBarrier();
    const release = deferred();
    let runs = 0;
    const first = barrier.begin(async () => {
      runs += 1;
      await release.promise;
      throw new Error("cleanup failed");
    });
    const second = barrier.begin(async () => {
      runs += 1;
    });
    await tick();
    expect(runs).toBe(1);
    const waiting = barrier.wait();

    release.resolve();
    await expect(first).rejects.toThrow("cleanup failed");
    await expect(second).rejects.toThrow("cleanup failed");
    await expect(waiting).rejects.toThrow("cleanup failed");
    expect(runs).toBe(1);
    expect(barrier.active).toBe(false);

    // 失败后 flight 被释放，后续命令仍可继续。
    await barrier.begin(async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });
});
