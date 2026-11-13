import { afterEach, expect, it, vi } from "vitest";
import { inspectR1LifecycleFailure } from "./e2e/helpers/cua-r1-receipt.js";
import { waitR1OldReferenceResult } from "./e2e/helpers/cua-r1-old-reference.js";

const fakeResult = {
  toolCallId: "old-3",
  isError: true,
  content: [
    "MCP tool returned an error:",
    JSON.stringify({
      code: "element_unavailable",
      message: "Computer use observation failed",
      action_sent: false,
      dispatch_status: "not_sent",
    }),
    "R1_LIFECYCLE:" +
      JSON.stringify({
        kind: "window_rejected",
        stage: 3,
        resultType: "object",
        code: "element_unavailable",
        ok: true,
        outcome: "returned",
      }),
    "R1_LIFECYCLE_DONE:3",
  ].join("\n"),
};
const dialog = (kind: "none" | "node" | "read", requestId: string | null = null) => ({
  kind,
  requestId,
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal("browser", {
    waitUntil: async (condition: () => Promise<boolean>) => {
      for (let i = 0; i < 4; i++) if (await condition()) return;
      throw new Error("timeout");
    },
  });
}
it("旧引用阶段仅允许一次 node 卡，再等待精确 call 的真实结果", async () => {
  setup();
  const read = vi
    .fn()
    .mockResolvedValueOnce(dialog("node"))
    .mockResolvedValueOnce(dialog("node"))
    .mockResolvedValueOnce(dialog("none"));
  const allow = vi.fn(async () => {});
  const latest = vi
    .fn()
    .mockReturnValueOnce(null)
    .mockReturnValueOnce(null)
    .mockReturnValueOnce(fakeResult);
  const result = await waitR1OldReferenceResult({
    callId: "old-3",
    seenReads: new Set(),
    readDialog: read,
    allowNode: allow,
    latestResult: latest,
  });
  expect(result).toEqual({ result: fakeResult, unexpectedRead: false });
  expect(
    inspectR1LifecycleFailure(
      result.result,
      {
        pid: 1,
        targetWindow: 2,
        siblingWindow: 3,
        targetMarker: "TARGET",
        siblingMarker: "SIBLING",
      },
      3,
    ).ok,
  ).toBe(true);
  expect(allow).toHaveBeenCalledTimes(1);
  expect(latest).toHaveBeenCalledWith("old-3");
});
it.each(["new-read", null])("新读卡（requestId=%s）立即失败且绝不允许读取", async (requestId) => {
  setup();
  const allow = vi.fn(async () => {});
  const result = await waitR1OldReferenceResult({
    callId: "old-3",
    seenReads: new Set(["old-read"]),
    readDialog: vi.fn().mockResolvedValue(dialog("read", requestId)),
    allowNode: allow,
    latestResult: () => null,
  });
  expect(result).toEqual({ result: null, unexpectedRead: true });
  expect(allow).not.toHaveBeenCalled();
});
it("无真实结果时超时，不能当成功", async () => {
  setup();
  await expect(
    waitR1OldReferenceResult({
      callId: "old-3",
      seenReads: new Set(),
      readDialog: vi.fn().mockResolvedValue(dialog("none")),
      allowNode: vi.fn(),
      latestResult: () => null,
    }),
  ).rejects.toThrow("timeout");
});

it("node 许可异常立即失败且不读取结果", async () => {
  setup();
  const allow = vi.fn().mockRejectedValue(new Error("private error"));
  const latest = vi.fn().mockReturnValue(fakeResult);
  const readDialog = vi.fn().mockResolvedValue(dialog("node"));
  await expect(
    waitR1OldReferenceResult({
      callId: "old-3",
      seenReads: new Set(),
      readDialog,
      allowNode: allow,
      latestResult: latest,
    }),
  ).rejects.toThrow("R1 old window node permission failed");
  expect(allow).toHaveBeenCalledTimes(1);
  expect(readDialog).toHaveBeenCalledTimes(1);
  expect(latest).not.toHaveBeenCalled();
});
