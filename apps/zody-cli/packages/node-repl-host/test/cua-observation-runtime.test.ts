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
