import { describe, expect, it, vi } from "vitest";
import { readBackgroundBashOutput } from "../src/runtime/methods/background-bash-output.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

describe("background Bash execution owner routing", () => {
  it.each([undefined, "child"])(
    "passes the actual owning session to the execution boundary (%s)",
    async (sessionId) => {
      const read = vi.fn().mockResolvedValue({ kind: "unavailable", workId: "work" });
      const runtime = {
        sessionId: "root",
        executionPort: { readBackgroundBashOutput: read },
      } as unknown as AgentRuntimeInternal;
      expect(await readBackgroundBashOutput.call(runtime, "work", sessionId)).toEqual({
        kind: "unavailable",
        workId: "work",
      });
      expect(read).toHaveBeenCalledExactlyOnceWith("work", sessionId ?? "root");
    },
  );
  it("reports unsupported without creating an execution port", async () => {
    const runtime = { sessionId: "root" } as unknown as AgentRuntimeInternal;
    expect(await readBackgroundBashOutput.call(runtime, "work")).toEqual({
      kind: "unsupported",
      workId: "work",
    });
  });

  it("passes through the adapter file path without re-deriving it", async () => {
    // I16：路径由 execution adapter 唯一生成；runtime 只转发结果。旧 workId 的
    // unavailable/read_failed 也必须原样返回，不能在这里冷恢复或回退到其它路径。
    const outputPath = "/tmp/zody-cli-exec/session/tool-call/stdout.log";
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "output",
        workId: "work",
        status: "completed",
        output: "tail",
        truncated: false,
        outputPath,
      })
      .mockResolvedValueOnce({ kind: "read_failed", workId: "work", code: "ENOENT" })
      .mockResolvedValueOnce({ kind: "unavailable", workId: "work" });
    const getBackgroundTask = vi.fn(() => {
      throw new Error("runtime must not query task snapshots for output");
    });
    const runtime = {
      sessionId: "session",
      executionPort: { readBackgroundBashOutput: read, getBackgroundTask },
    } as unknown as AgentRuntimeInternal;

    await expect(readBackgroundBashOutput.call(runtime, "work", "session")).resolves.toMatchObject({
      kind: "output",
      outputPath,
    });
    await expect(readBackgroundBashOutput.call(runtime, "work", "session")).resolves.toEqual({
      kind: "read_failed",
      workId: "work",
      code: "ENOENT",
    });
    await expect(readBackgroundBashOutput.call(runtime, "work", "session")).resolves.toEqual({
      kind: "unavailable",
      workId: "work",
    });
    expect(read.mock.calls).toEqual([
      ["work", "session"],
      ["work", "session"],
      ["work", "session"],
    ]);
    expect(getBackgroundTask).not.toHaveBeenCalled();
  });
});
