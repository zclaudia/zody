import { describe, expect, it, vi } from "vitest";

const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(() => undefined),
}));

vi.mock("../src/cua-runtime.js", () => ({
  captureComputerUseRuntimeFromEnvironment: captureMock,
}));

import { createNodeReplMcpRuntime } from "../src/node-repl-mcp-runtime.js";

describe("node_repl runtime CUA ownership", () => {
  it("never captures a producer from env for an explicitly borrowed runtime", async () => {
    captureMock.mockClear();
    const runtime = createNodeReplMcpRuntime({
      cuaRuntimeOwnership: "borrowed",
      executeJs: async () => ({ logs: "", result: "ok" }),
    });
    expect(captureMock).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it("keeps the default env capture for an unqualified runtime", async () => {
    captureMock.mockClear();
    const runtime = createNodeReplMcpRuntime({
      executeJs: async () => ({ logs: "", result: "ok" }),
    });
    expect(captureMock).toHaveBeenCalledOnce();
    await runtime.dispose();
  });
});
