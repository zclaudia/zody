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
  it.each(["invalidated", "closed"] as const)(
    "latches %s during the accepted ACK before delivery",
    async (flag) => {
      const ctx = fixture();
      await handleObservationFrame(
        ctx,
        frame("confirmRead", { ...association, generation: 1, target }),
      );
      vi.mocked(ctx.write).mockImplementation(() => {
        ctx.state[flag] = true;
        return true;
      });
      await handleObservationFrame(
        ctx,
        frame("observationResult", { ...association, result: result(8) }),
      );
      expect(ctx.observation?.accept).not.toHaveBeenCalled();
      expect(ctx.finish).not.toHaveBeenCalledWith("adapter-close", true);
    },
  );
  it.each(["invalidated", "closed"] as const)(
    "rejects a late candidate after %s without reviving delivery",
    async (flag) => {
      const ctx = fixture();
      await handleObservationFrame(
        ctx,
        frame("confirmRead", { ...association, generation: 1, target }),
      );
      let release!: (value: { status: "candidate"; ref: typeof ref }) => void;
      vi.spyOn(ctx.scope.producerPort, "resolve").mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = handleObservationFrame(
        ctx,
        frame("observationResult", { ...association, result: result(8) }),
      );
      ctx.state[flag] = true;
      release({ status: "candidate", ref });
      await pending;
      expect(ctx.observation?.accept).not.toHaveBeenCalled();
      expect(ctx.reject).toHaveBeenCalledWith("1", "observationResult", "scope_invalidated");
    },
  );
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

describe("native control authority", () => {
  it("requires independent control authorization and preserves a sent error receipt", async () => {
    const ctx = fixture();
    Object.assign(ctx.observation!.request, {
      method: "left_click",
      arguments: {
        app_ref: { pid: 42, window_id: 8 },
        target: { type: "element", index: 0 },
        state_id: "frozen",
      },
    });
    Object.assign(ctx, { confirmControlRequest: vi.fn(async () => ({ allowed: true })) });
    await handleObservationFrame(
      ctx,
      frame("confirmControl", { ...association, generation: 1, target }),
    );
    expect(ctx.confirmControlRequest).toHaveBeenCalledOnce();
    const receipt = {
      code: "timeout",
      action_sent: true,
      dispatch_status: "possibly_sent",
      state_sync_status: "failed",
    };
    await handleObservationFrame(
      ctx,
      frame("controlResult", {
        ...association,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(receipt) }] },
      }),
    );
    expect(ctx.observation!.accept).toHaveBeenCalledWith(
      expect.objectContaining({ content: [{ type: "text", text: JSON.stringify(receipt) }] }),
    );
  });
  it("rejects control results without control authorization", async () => {
    const ctx = fixture();
    Object.assign(ctx.observation!.request, {
      method: "left_click",
      arguments: {
        app_ref: { pid: 42, window_id: 8 },
        target: { type: "element", index: 0 },
        state_id: "frozen",
      },
    });
    await handleObservationFrame(
      ctx,
      frame("controlResult", {
        ...association,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action_sent: true,
                dispatch_status: "sent",
                state_sync_status: "not_requested",
              }),
            },
          ],
        },
      }),
    );
    expect(ctx.observation!.accept).not.toHaveBeenCalled();
  });
});

describe("control admission guards", () => {
  it("requires read confirmation before control when returning state", async () => {
    const ctx = fixture();
    Object.assign(ctx.observation!.request, {
      method: "left_click",
      arguments: {
        app_ref: { pid: 42, window_id: 8 },
        target: { type: "element", index: 0 },
        state_id: "frozen",
        return_state: "compact",
      },
    });
    Object.assign(ctx, { confirmControlRequest: vi.fn(async () => ({ allowed: true })) });
    await handleObservationFrame(
      ctx,
      frame("confirmControl", { ...association, generation: 1, target }),
    );
    expect(ctx.confirmControlRequest).not.toHaveBeenCalled();
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, generation: 2, target }),
    );
    await handleObservationFrame(
      ctx,
      frame("confirmControl", { ...association, generation: 1, target }),
    );
    expect(ctx.confirmControlRequest).toHaveBeenCalledOnce();
  });
  it("does not ask for authorization for an unsupported mouse combination", async () => {
    const ctx = fixture();
    Object.assign(ctx.observation!.request, {
      method: "left_click",
      arguments: {
        target: { type: "element", index: 0 },
        state_id: "frozen",
        mouse_button: "right",
      },
    });
    Object.assign(ctx, { confirmControlRequest: vi.fn(async () => ({ allowed: true })) });
    await handleObservationFrame(
      ctx,
      frame("confirmControl", { ...association, generation: 1, target }),
    );
    expect(ctx.confirmControlRequest).not.toHaveBeenCalled();
  });
});

it("retains the authorized lease watcher after acknowledging its result", async () => {
  const ctx = fixture();
  Object.assign(ctx.observation!.request, {
    method: "left_click",
    arguments: { target: { type: "element", index: 0 }, state_id: "frozen" },
  });
  Object.assign(ctx, { confirmControlRequest: vi.fn(async () => ({ allowed: true })) });
  const onLeaseWatch = vi.fn();
  Object.assign(ctx.observation!, { onLeaseWatch });
  await handleObservationFrame(
    ctx,
    frame("confirmControl", { ...association, generation: 1, target }),
  );
  await handleObservationFrame(
    ctx,
    frame("controlResult", {
      ...association,
      lease_watch: true,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action_sent: true,
              dispatch_status: "sent",
              state_sync_status: "not_requested",
            }),
          },
        ],
      },
    }),
  );
  expect(onLeaseWatch).toHaveBeenCalledOnce();
  expect(ctx.observation!.accept).toHaveBeenCalledOnce();
  expect(ctx.finish).not.toHaveBeenCalled();
  expect(ctx.write).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: { ok: true, accepted: true, lease_watch: true } }),
  );
});

describe("native observation remote association", () => {
  it.each([
    {},
    { workspaceIdentity: "remote-wrong", remoteSessionId: "remote-1" },
    { workspaceIdentity: "remote-workspace", remoteSessionId: "remote-wrong" },
  ])("rejects missing or mismatched remote identity %j", async (remote) => {
    const ctx = fixture();
    Object.assign(ctx.observation!, {
      association: { workspaceIdentity: "remote-workspace", remoteSessionId: "remote-1" },
    });
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, ...remote, generation: 1, target }),
    );
    expect(ctx.confirmReadRequest).not.toHaveBeenCalled();
    expect(ctx.reject).toHaveBeenCalled();
  });
  it("preserves complete remote identity during read confirmation", async () => {
    const ctx = fixture(),
      remote = { workspaceIdentity: "remote-workspace", remoteSessionId: "remote-1" };
    Object.assign(ctx.observation!, { association: remote });
    await handleObservationFrame(
      ctx,
      frame("confirmRead", { ...association, ...remote, generation: 1, target }),
    );
    expect(ctx.confirmReadRequest).toHaveBeenCalledOnce();
    expect(ctx.write).toHaveBeenCalled();
  });
});

it("preserves controller_busy as definitely not sent", async () => {
  const ctx = fixture();
  Object.assign(ctx.observation!.request, {
    method: "left_click",
    arguments: {
      app_ref: { pid: 42, window_id: 8 },
      target: { type: "element", index: 0 },
      state_id: "frozen",
    },
  });
  const receipt = {
    code: "controller_busy",
    message: "Computer use control failed",
    action_sent: false,
    dispatch_status: "not_sent",
    state_sync_status: "not_requested",
  };
  await handleObservationFrame(
    ctx,
    frame("controlResult", {
      ...association,
      result: { isError: true, content: [{ type: "text", text: JSON.stringify(receipt) }] },
    }),
  );
  expect(ctx.observation!.accept).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
  expect(ctx.reject).not.toHaveBeenCalled();
});
it("rejects contradictory possibly_sent receipt", async () => {
  const ctx = fixture();
  Object.assign(ctx.observation!.request, {
    method: "left_click",
    arguments: { target: { type: "element", index: 0 }, state_id: "frozen" },
  });
  Object.assign(ctx.state, { controlTarget: { pid: 42, windowId: 8 } });
  await handleObservationFrame(
    ctx,
    frame("controlResult", {
      ...association,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action_sent: false,
              dispatch_status: "possibly_sent",
              state_sync_status: "failed",
            }),
          },
        ],
      },
    }),
  );
  expect(ctx.observation!.accept).not.toHaveBeenCalled();
  expect(ctx.reject).toHaveBeenCalled();
});

it("accepts internal commit_state receipt without body or another read", async () => {
  const ctx = fixture();
  Object.assign(ctx.observation!.request, {
    method: "commit_state",
    arguments: { app_ref: { pid: 42, window_id: 8 }, state_id: "frozen" },
  });
  await handleObservationFrame(
    ctx,
    frame("observationResult", {
      ...association,
      result: {
        content: [{ type: "text", text: JSON.stringify({ committed: true, state_id: "frozen" }) }],
      },
    }),
  );
  expect(ctx.observation!.accept).toHaveBeenCalledOnce();
  expect(ctx.confirmReadRequest).not.toHaveBeenCalled();
});
it.each([
  { committed: true, state_id: "wrong" },
  { committed: true, state_id: "frozen", body: "secret" },
])("rejects invalid commit_state receipt %j", async (receipt) => {
  const ctx = fixture();
  Object.assign(ctx.observation!.request, {
    method: "commit_state",
    arguments: { app_ref: { pid: 42, window_id: 8 }, state_id: "frozen" },
  });
  await handleObservationFrame(
    ctx,
    frame("observationResult", {
      ...association,
      result: { content: [{ type: "text", text: JSON.stringify(receipt) }] },
    }),
  );
  expect(ctx.observation!.accept).not.toHaveBeenCalled();
});
