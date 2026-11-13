import { describe, expect, it, vi } from "vitest";
import { handleObservationFrame } from "../src/mcp/cua-native-authority-observation.js";
import type { CuaNativeAuthorityProtocolContext } from "../src/mcp/cua-native-authority-protocol.js";

const ref = {
  submissionLineageId: "l",
  appIncarnation: "a",
  hostInstanceId: "h",
  runtimeInstanceId: "r",
  sessionId: "s",
  workspaceKey: "w",
  authorizationRevision: 1,
};
const association = { ref, traceId: "t", producerIncarnation: "p", runId: "run", turnId: "turn" };
const target = {
  pid: 42,
  windowId: 8,
  layer: 0,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  ownerName: "app",
  windowName: "win",
};
function fixture() {
  const ctx = {
    scope: {
      ref,
      traceId: "t",
      runId: "run",
      turnId: "turn",
      producerPort: { resolve: async () => ({ status: "candidate", ref }) },
    },
    producerIncarnation: "p",
    requestTimeoutMs: 1000,
    state: {
      bootstrapped: true,
      invalidated: false,
      closed: false,
      observationResultStarted: false,
      confirmSeenGenerations: new Set(),
    },
    observation: {
      request: { method: "get_app_state", arguments: { app_ref: { pid: 42, window_id: 8 } } },
      accept: vi.fn(),
      onRejected: vi.fn(),
    },
    confirmReadRequest: vi.fn(async () => ({ allowed: true })),
    reject: vi.fn(),
    write: vi.fn(() => true),
    finish: vi.fn(),
  } as unknown as CuaNativeAuthorityProtocolContext;
  return ctx;
}
const frame = (method: string, payload: Record<string, unknown>) => ({
  requestId: "1",
  method,
  payload,
});
const result = (windowId: number) => ({
  content: [{ type: "text", text: "" }],
  structuredContent: {
    app: { pid: 42 },
    window: { pid: 42, window_id: windowId },
    state_id: "1",
    text: "",
    snapshot_mode: "full",
    truncated: false,
    elements: [],
  },
});
describe("native observation authority", () => {
  it("does not re-prompt with a fresh generation after a denied observation", async () => {
    const ctx = fixture();
    vi.mocked(ctx.confirmReadRequest!).mockResolvedValue({ allowed: false });
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 1, target }),
    );
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 2, target }),
    );
    expect(ctx.confirmReadRequest).toHaveBeenCalledOnce();
    expect(ctx.reject).toHaveBeenCalledWith("1", "confirmRead", "confirmation-invalid");
  });
  it("requires one exact confirmed window before accepting content", async () => {
    const ctx = fixture();
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 1, target }),
    );
    expect(ctx.confirmReadRequest).toHaveBeenCalledOnce();
    await handleObservationFrame(
      ctx,
      frame("observationResult", { ...association, result: result(9) }),
    );
    expect(ctx.reject).toHaveBeenCalledWith("1", "observationResult", "read-not-authorized");
    expect(ctx.observation?.accept).not.toHaveBeenCalled();
  });
  it("rejects mismatched explicit target before prompting", async () => {
    const ctx = fixture();
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 1, target: { ...target, windowId: 9 } }),
    );
    expect(ctx.confirmReadRequest).not.toHaveBeenCalled();
  });
  it("accepts an authorized exact target and rejects oversized results", async () => {
    const ctx = fixture();
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 1, target }),
    );
    await handleObservationFrame(
      ctx,
      frame("observationResult", { ...association, result: result(8) }),
    );
    expect(ctx.observation?.accept).toHaveBeenCalledOnce();
    const other = fixture();
    await handleObservationFrame(
      other,
      frame("observationResult", {
        ...association,
        result: { content: [{ type: "text", text: "x".repeat(13000) }] },
      }),
    );
    expect(other.reject).toHaveBeenCalledWith("1", "observationResult", "observation-invalid");
  });
  it("rejects a metadata preview containing window content", async () => {
    const ctx = fixture();
    (ctx.observation!.request as { method: string }).method = "list_windows";
    const row = {
      pid: 42,
      window_id: 8,
      title: "win",
      text_preview: "secret",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      main: null,
      focused: null,
      onscreen: true,
    };
    await handleObservationFrame(
      ctx,
      frame("observationResult", {
        ...association,
        result: { content: [{ type: "text", text: JSON.stringify([row]) }] },
      }),
    );
    expect(ctx.reject).toHaveBeenCalledWith("1", "observationResult", "observation-invalid");
  });
  it("normalizes error messages so they cannot smuggle content", async () => {
    const ctx = fixture();
    await handleObservationFrame(
      ctx,
      frame("observationResult", {
        ...association,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ code: "permission_denied", message: "secret" }),
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(vi.mocked(ctx.observation!.accept).mock.calls)).not.toContain("secret");
    expect(ctx.observation!.accept).toHaveBeenCalledOnce();
  });
  it("rejects extra confirmation fields and accepts all defined errors", async () => {
    for (const extra of [{ extra: true }, { target: { ...target, extra: true } }]) {
      const ctx = fixture();
      await handleObservationFrame(
        ctx,
        frame("confirmRead", { ...association, generation: 1, target, ...extra }),
      );
      expect(ctx.confirmReadRequest).not.toHaveBeenCalled();
    }
    for (const code of [
      "stale_state",
      "structured_state_unavailable",
      "action_unavailable",
      "timeout",
      "broker_unavailable",
    ]) {
      const ctx = fixture();
      await handleObservationFrame(
        ctx,
        frame("observationResult", {
          ...association,
          result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code }) }] },
        }),
      );
      expect(ctx.observation!.accept).toHaveBeenCalledOnce();
    }
  });
});
