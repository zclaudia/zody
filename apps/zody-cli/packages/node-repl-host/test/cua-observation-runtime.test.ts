import { describe, expect, it, vi } from "vitest";
import { createCuaObservationRuntime } from "../src/cua-observation-runtime.js";

const context = {
  runtimeScope: "main" as const,
  sessionId: "s",
  workspaceKey: "w",
  turnId: "t",
  clientMode: "desktop-continuous" as const,
  deliveryKind: "desktop-continuous" as const,
};
const state = {
  content: [{ type: "text", text: "tree" }],
  structuredContent: { state_id: "1", app: { pid: 10 }, window: { window_id: 20 }, elements: [] },
};

describe("sealed observation runtime", () => {
  it("refuses overlapping calls instead of sharing and closing another consumer's scope", async () => {
    const pending = Promise.withResolvers<typeof state>();
    const observationOnce = vi.fn(() => pending.promise);
    const captureOnce = vi.fn();
    const runtime = createCuaObservationRuntime({ observationOnce, captureOnce });
    const first = runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 } },
      context,
    });
    const second = await runtime.execute({
      toolName: "screenshot",
      arguments: { target: { pid: 10, windowId: 20 } },
      context,
    });
    expect(second).toMatchObject({ isError: true });
    expect(captureOnce).not.toHaveBeenCalled();
    pending.resolve(state);
    await expect(first).resolves.toEqual(state);
  });
  it("returns an explicit zero-dispatch receipt for a supported write rejected by active consumer",async()=>{
    const pending=Promise.withResolvers<typeof state>();
    const observationOnce=vi.fn().mockResolvedValueOnce(state).mockReturnValueOnce(pending.promise);
    const runtime=createCuaObservationRuntime({observationOnce,captureOnce:vi.fn()});
    await runtime.execute({toolName:"get_app_state",arguments:{app_ref:{pid:10}},context});
    const active=runtime.execute({toolName:"get_app_state",arguments:{app_ref:{pid:10}},context});
    const busy=await runtime.execute({toolName:"left_click",arguments:{target:{type:"element",index:0},return_state:"none"},context});
    expect(JSON.parse(busy.content[0]!.text!)).toMatchObject({code:"controller_busy",action_sent:false,dispatch_status:"not_sent",state_sync_status:"not_requested"});
    expect(observationOnce).toHaveBeenCalledTimes(2);
    pending.resolve(state);await active;
  });
  it("drops a result arriving after runtime disposal", async () => {
    const pending = Promise.withResolvers<typeof state>();
    const runtime = createCuaObservationRuntime({
      observationOnce: () => pending.promise,
      captureOnce: vi.fn(),
    });
    const call = runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 } },
      context,
    });
    const assertion = expect(call).rejects.toThrow("disposed");
    await runtime.dispose();
    pending.resolve(state);
    await assertion;
  });
  it("forwards strict observations using trusted scope and disables native screenshots", async () => {
    const observationOnce = vi.fn(async () => state);
    const captureOnce = vi.fn(async () => ({
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    }));
    const runtime = createCuaObservationRuntime({
      observationOnce,
      captureOnce,
      verifyObservationScope: () => true,
    });
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 }, include_screenshot: true, tree_shown_to_model: false },
      context,
    });
    expect(observationOnce).toHaveBeenCalledWith(
      {
        method: "get_app_state",
        arguments: {
          app_ref: { pid: 10 },
          include_screenshot: false,
          tree_shown_to_model: false,
          disable_diffing: true,
        },
      },
      { expected: { sessionId: "s", workspaceKey: "w", turnId: "t" } },
    );
    expect(captureOnce).toHaveBeenCalledWith(
      { pid: 10, windowId: 20 },
      { expected: { sessionId: "s", workspaceKey: "w", turnId: "t" } },
    );
    expect(result).toMatchObject({
      structuredContent: state.structuredContent,
      content: [{ type: "text" }, { type: "image" }],
    });
  });
  it("rejects unknown and malformed nested arguments and never observes writes", async () => {
    const observationOnce = vi.fn(async () => state);
    const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
    for (const [toolName, args] of [
      ["list_apps", { extra: true }],
      ["list_windows", { app_ref: { pid: 1, extra: true } }],
      ["get_app_state", { app_ref: { pid: 1 }, tree_shown_to_model: "yes" }],
    ] as const) {
      await expect(runtime.execute({ toolName, arguments: args, context })).rejects.toThrow();
    }
    await expect(
      runtime.execute({ toolName: "left_click", arguments: {}, context }),
    ).resolves.toMatchObject({ isError: true });
    expect(observationOnce).not.toHaveBeenCalled();
  });
  it("does not capture error or malformed state and rejects untrusted contexts", async () => {
    const observationOnce = vi.fn(async () => ({
      content: [{ type: "text", text: "denied" }],
      isError: true,
    }));
    const captureOnce = vi.fn();
    const runtime = createCuaObservationRuntime({
      observationOnce,
      captureOnce,
      verifyObservationScope: () => true,
    });
    await expect(
      runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 1 }, include_screenshot: true },
        context,
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      runtime.execute({
        toolName: "list_apps",
        arguments: {},
        context: { ...context, runtimeScope: "subagent" },
      }),
    ).rejects.toThrow();
    expect(captureOnce).not.toHaveBeenCalled();
  });
});

it("fails before capture without a verifier and drops stale or aborted combined results", async () => {
  const observationOnce = vi.fn(async () => state);
  const captureOnce = vi.fn(async () => ({
    content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
  }));
  const args = {
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10 }, include_screenshot: true },
    context,
  };
  const missing = createCuaObservationRuntime({ observationOnce, captureOnce });
  await expect(missing.execute(args)).rejects.toThrow("verifier_required");
  expect(observationOnce).not.toHaveBeenCalled();
  const stale = createCuaObservationRuntime({
    observationOnce,
    captureOnce,
    verifyObservationScope: () => false,
  });
  await expect(stale.execute(args)).rejects.toThrow("scope_invalid");
  const controller = new AbortController();
  const aborted = createCuaObservationRuntime({
    observationOnce,
    captureOnce: async () => {
      controller.abort();
      return { content: [{ type: "image", data: "eA==", mimeType: "image/png" }] };
    },
    verifyObservationScope: () => true,
  });
  await expect(aborted.execute({ ...args, signal: controller.signal })).rejects.toThrow();
});

it("rejects every write and prototype-named methods without native observation", async () => {
  const observationOnce = vi.fn(async () => state);
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  for (const toolName of [
    "left_click",
    "left_click_drag",
    "scroll",
    "type",
    "set_value",
    "select_text",
    "key",
    "paste",
    "perform_action",
    "toString",
    "__proto__",
  ]) {
    await expect(runtime.execute({ toolName, arguments: {}, context })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("action_unavailable") }],
    });
  }
  await expect(
    runtime.execute({ toolName: "list_apps", arguments: null, context }),
  ).rejects.toThrow();
  expect(observationOnce).not.toHaveBeenCalled();
});

it("returns a typed error instead of treating missing structured state as success", async () => {
  const captureOnce = vi.fn();
  const runtime = createCuaObservationRuntime({
    observationOnce: async () => ({ content: [{ type: "text", text: "tree" }] }),
    captureOnce,
    verifyObservationScope: () => true,
  });
  await expect(
    runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 }, include_screenshot: true },
      context,
    }),
  ).resolves.toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("structured_state_unavailable") }],
  });
  expect(captureOnce).not.toHaveBeenCalled();
});

it("binds supported writes to the delivered state and rejects unsupported inputs before native", async () => {
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state"
      ? state
      : {
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
  );
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  const target = { type: "element", index: 0 };
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10, window_id: 20 } },
    context,
  });
  await runtime.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 10, window_id: 20 }, target },
    context,
  });
  expect(observationOnce).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: "left_click",
      arguments: expect.objectContaining({ state_id: "1", target }),
    }),
    expect.anything(),
  );
  const calls = observationOnce.mock.calls.length;
  const unsupported = await runtime.execute({
    toolName: "left_click",
    arguments: { app_ref: { pid: 10, window_id: 20 }, target, strategy: "event" },
    context,
  });
  expect(unsupported).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(calls);
});

it("never replays a write after a lost connection and reports an uncertain dispatch", async () => {
  const observationOnce = vi.fn(async (request: { method: string }) => {
    if (request.method === "get_app_state") return state;
    throw new Error("connection closed");
  });
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10 } },
    context,
  });
  const result = await runtime.execute({
    toolName: "set_value",
    arguments: {
      app_ref: { pid: 10 },
      target: { type: "element", index: 0 },
      value: "x",
      return_state: "full",
    },
    context,
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
    action_sent: true,
    dispatch_status: "possibly_sent",
    state_sync_status: "failed",
  });
  expect(observationOnce).toHaveBeenCalledTimes(2);
});

it("does not bind a silent observation or a state from a different turn", async () => {
  const observationOnce = vi.fn(async () => state);
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  const args = { app_ref: { pid: 10 }, target: { type: "element", index: 0 } };
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: args.app_ref, tree_shown_to_model: false },
    context,
  });
  expect(await runtime.execute({ toolName: "left_click", arguments: args, context })).toMatchObject(
    { isError: true },
  );
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: args.app_ref },
    context,
  });
  expect(
    await runtime.execute({
      toolName: "left_click",
      arguments: args,
      context: { ...context, turnId: "new" },
    }),
  ).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(2);
});

it("carries workspace identity and remote session in the trusted observation expectation", async () => {
  const observationOnce = vi.fn(async () => state);
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10 } },
    context: { ...context, workspaceIdentity: "remote:fixture", remoteSessionId: "remote-session" },
  });
  expect(observationOnce).toHaveBeenCalledWith(expect.anything(), {
    expected: expect.objectContaining({
      workspaceIdentity: "remote:fixture",
      remoteSessionId: "remote-session",
    }),
  });
});

it.each([
  ["left_click", { modifiers: "" }],
  ["perform_action", { action: "AXPress" }],
  ["set_value", { value: "hello" }],
] as const)(
  "binds omitted app_ref for %s to the observed window and normalizes modifiers",
  async (method, extra) => {
    const observationOnce = vi.fn(async (request: { method: string }) =>
      request.method === "get_app_state" ? state : { content: [{ type: "text", text: "{}" }] },
    );
    const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: "Fixture" },
      context,
    });
    await runtime.execute({
      toolName: method,
      arguments: { target: { type: "element", index: 0 }, ...extra },
      context,
    });
    expect(observationOnce).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method,
        arguments: expect.objectContaining({
          app_ref: { pid: 10, window_id: 20 },
          state_id: "1",
          ...(method === "left_click" ? { modifiers: [] } : {}),
        }),
      }),
      expect.anything(),
    );
  },
);

it("uses the observed window for an explicit app reference and rejects a different reference", async () => {
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state" ? state : { content: [{ type: "text", text: "{}" }] },
  );
  const runtime = createCuaObservationRuntime({ observationOnce, captureOnce: vi.fn() });
  await runtime.execute({ toolName: "get_app_state", arguments: { app_ref: "Fixture" }, context });
  const target = { type: "element", index: 0 };
  await runtime.execute({
    toolName: "left_click",
    arguments: { app_ref: "Fixture", target },
    context,
  });
  expect(observationOnce).toHaveBeenLastCalledWith(
    expect.objectContaining({
      arguments: expect.objectContaining({ app_ref: { pid: 10, window_id: 20 } }),
    }),
    expect.anything(),
  );
  expect(
    await runtime.execute({
      toolName: "left_click",
      arguments: { app_ref: "Other", target },
      context,
    }),
  ).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(2);
});

it("commits a combined screenshot observation before allowing its frozen element to be used", async () => {
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state"
      ? state
      : { content: [{ type: "text", text: JSON.stringify({ committed: true, state_id: "1" }) }] },
  );
  const runtime = createCuaObservationRuntime({
    observationOnce,
    captureOnce: vi.fn(async () => ({
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    })),
    verifyObservationScope: () => true,
  });
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10 }, include_screenshot: true },
    context,
  });
  expect(observationOnce).toHaveBeenLastCalledWith(
    { method: "commit_state", arguments: { state_id: "1", app_ref: { pid: 10, window_id: 20 } } },
    expect.anything(),
  );
  await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 } },
    context,
  });
  expect(observationOnce).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: "left_click",
      arguments: expect.objectContaining({ state_id: "1", app_ref: { pid: 10, window_id: 20 } }),
    }),
    expect.anything(),
  );
});

it("does not expose or bind a combined observation when commit fails", async () => {
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state"
      ? state
      : { isError: true, content: [{ type: "text", text: "denied" }] },
  );
  const runtime = createCuaObservationRuntime({
    observationOnce,
    captureOnce: vi.fn(async () => ({
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    })),
    verifyObservationScope: () => true,
  });
  const result = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { pid: 10 }, include_screenshot: true },
    context,
  });
  expect(result).toMatchObject({ isError: true });
  const calls = observationOnce.mock.calls.length;
  expect(
    await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 } },
      context,
    }),
  ).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(calls);
});

it.each([
  { committed: true, state_id: "other" },
  { committed: true, state_id: "1", extra: "body" },
  { committed: false, state_id: "1" },
])("rejects an invalid commit receipt %# before exposing the tree", async (receipt) => {
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state"
      ? state
      : { content: [{ type: "text", text: JSON.stringify(receipt) }] },
  );
  const runtime = createCuaObservationRuntime({
    observationOnce,
    captureOnce: vi.fn(async () => ({
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    })),
    verifyObservationScope: () => true,
  });
  expect(
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 }, include_screenshot: true },
      context,
    }),
  ).toMatchObject({ isError: true });
  expect(
    await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 } },
      context,
    }),
  ).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(2);
});

it("does not deliver a committed screenshot tree if the scope changes before delivery", async () => {
  const verifyObservationScope = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
  const observationOnce = vi.fn(async (request: { method: string }) =>
    request.method === "get_app_state"
      ? state
      : { content: [{ type: "text", text: JSON.stringify({ committed: true, state_id: "1" }) }] },
  );
  const runtime = createCuaObservationRuntime({
    observationOnce,
    captureOnce: vi.fn(async () => ({
      content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
    })),
    verifyObservationScope,
  });
  await expect(
    runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 }, include_screenshot: true },
      context,
    }),
  ).rejects.toThrow("scope_invalid");
  expect(
    await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 0 } },
      context,
    }),
  ).toMatchObject({ isError: true });
  expect(observationOnce).toHaveBeenCalledTimes(2);
});
