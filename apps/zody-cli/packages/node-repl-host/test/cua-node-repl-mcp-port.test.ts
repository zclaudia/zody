import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { MCP_TOOL_META_TIMEOUT_MAX_MS } from "@zody/contracts";
import type {
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpPort,
  McpToolCallResult,
} from "@zody/contracts";
import {
  createCuaNodeReplMcpPort,
  createCuaNodeReplMcpPortFactory,
} from "../src/cua-node-repl-mcp-port.js";
import { CUA_HELPER_CELL_DEFAULT_TIMEOUT_MS } from "../src/cell-helper-transport.js";
import type { CuaCaptureExpectation, CuaCaptureTarget } from "../src/cua-capture-runtime.js";

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY1J3QAAAABJRU5ErkJggg==";
let directory = "";
let serverPath = "";
let serverSnapshot = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "zcode-cua-node-repl-port-"));
  serverPath = join(directory, "server.mjs");
  await buildNodeReplHostBundle({ outfile: serverPath, cuaHelperBuildId: "" });
  serverSnapshot = await readFile(serverPath, "utf8");
}, 120_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function executeJs(port: McpPort, code = "1 + 1"): Promise<McpToolCallResult> {
  await port.connectConfiguredServers({ node_repl: { type: "stdio" } as never });
  return await port.callTool({
    serverName: "node_repl",
    toolName: "js",
    arguments: { code, title: "snapshot capture" },
  });
}
const REQUEST: McpCallToolRequest = {
  serverName: "node_repl",
  toolName: "js",
  arguments: {
    code:
      "const bridge = globalThis[Symbol.for('zcode.node-repl.computer-use-bridge')];\n" +
      "const captured = await bridge.call('screenshot', { target: { pid: 42, windowId: 99 } });\n" +
      "captured;",
    title: "读取可信桌面截图",
  },
  trace: {
    traceId: "trace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  },
  runtimeScope: "main",
  workspacePath: "/workspace",
  workspaceIdentity: "workspace-1",
  workspaceKey: "workspace-1",
  turnId: "turn-1",
  clientMode: "desktop-continuous",
  deliveryKind: "desktop-continuous",
};

interface DelegatedCall {
  request: McpCallToolRequest;
}

function fakeBasePort(options: { includeNodeReplTool?: boolean } = {}): {
  port: McpPort;
  calls: DelegatedCall[];
  closed: () => boolean;
  connectCalls: Array<Record<string, unknown>>;
} {
  const calls: DelegatedCall[] = [];
  const connectCalls: Array<Record<string, unknown>> = [];
  let closeCalled = false;
  const port: McpPort = {
    async connectConfiguredServers(servers): Promise<McpConnectionSnapshot> {
      connectCalls.push({ ...servers });
      return { statuses: {}, tools: [] };
    },
    async connectServer(name) {
      throw new Error(`unexpected connectServer: ${name}`);
    },
    async disconnectServer() {
      return undefined;
    },
    async status() {
      return {};
    },
    async listTools() {
      return options.includeNodeReplTool
        ? [{ serverName: "node_repl", toolName: "js", inputSchema: { type: "object" } }]
        : [];
    },
    async callTool(request): Promise<McpToolCallResult> {
      calls.push({ request });
      return { content: [{ type: "text", text: "delegated" }] };
    },
    async close() {
      closeCalled = true;
    },
  };
  return { port, calls, closed: () => closeCalled, connectCalls };
}

describe("createCuaNodeReplMcpPort", () => {
  it("executes the real node_repl js contract through a subprocess cell and returns the image", async () => {
    const base = fakeBasePort();
    const captures: Array<{ target: CuaCaptureTarget; expected: CuaCaptureExpectation }> = [];
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: true,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async (target, options) => {
        captures.push({ target, expected: options.expected });
        return { content: [{ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }] };
      },
    });

    try {
      const snapshot = await port.connectConfiguredServers({
        node_repl: { type: "stdio" } as never,
      });
      expect(base.connectCalls).toEqual([{}]);
      expect(snapshot.tools).toEqual([
        expect.objectContaining({ serverName: "node_repl", toolName: "js" }),
      ]);
      expect(snapshot.statuses.node_repl).toMatchObject({
        status: "connected",
        toolCount: 1,
      });

      const result = await port.callTool(REQUEST);
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "image", data: IMAGE_BASE64, mimeType: "image/png" }),
      );
      expect(captures).toEqual([
        {
          target: { pid: 42, windowId: 99 },
          expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
        },
      ]);
      expect(base.calls).toEqual([]);
    } finally {
      await port.close();
    }
    expect(base.closed()).toBe(true);
  }, 30_000);

  it("routes observations through the explicitly injected callback in a real cell", async () => {
    const base = fakeBasePort();
    const observed: unknown[] = [];
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => {
        throw new Error("unexpected screenshot");
      },
      observationOnce: async (request, options) => {
        observed.push({ request, expected: options.expected });
        return { content: [{ type: "text", text: "observed-apps" }] };
      },
    });
    try {
      await port.connectConfiguredServers({ node_repl: { type: "stdio" } as never });
      const result = await port.callTool({
        ...REQUEST,
        arguments: {
          code: "const bridge = globalThis[Symbol.for('zcode.node-repl.computer-use-bridge')]; await bridge.call('list_apps', {});",
          title: "读取应用",
        },
      });
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("observed-apps") }),
      );
      expect(observed).toEqual([
        {
          request: { method: "list_apps", arguments: {} },
          expected: { sessionId: "session-1", workspaceKey: "workspace-1", turnId: "turn-1" },
        },
      ]);
    } finally {
      await port.close();
    }
  }, 30_000);

  it("delegates non-node_repl tools and does not close a borrowed base port", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => {
        throw new Error("capture should not run");
      },
    });
    await port.connectConfiguredServers({});
    try {
      const request: McpCallToolRequest = { serverName: "other", toolName: "run" };
      await expect(port.callTool(request)).resolves.toEqual({
        content: [{ type: "text", text: "delegated" }],
      });
      expect(base.calls).toEqual([{ request }]);
    } finally {
      await port.close();
    }
    expect(base.closed()).toBe(false);
  });

  it("exposes the bounded server timeout on the local js descriptor", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    });
    try {
      const snapshot = await port.connectConfiguredServers({
        node_repl: { type: "stdio" } as never,
      });
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          serverName: "node_repl",
          toolName: "js",
          timeoutMs: 600_000,
        }),
      ]);
    } finally {
      await port.close();
    }
  });

  it("keeps the local tool default while covering the MCP maximum as the cell hard ceiling", () => {
    expect(CUA_HELPER_CELL_DEFAULT_TIMEOUT_MS).toBe(MCP_TOOL_META_TIMEOUT_MAX_MS);
    const factory = createCuaNodeReplMcpPortFactory({
      serverPath,
      sourceSnapshot: serverSnapshot,
    });
    expect(factory.localServerConfig.timeoutMs).toBe(600_000);
  });

  it("disconnect tears down local node_repl and revises the tool list", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    });
    await port.connectConfiguredServers({ node_repl: { type: "stdio" } as never });
    const before = port.toolListRevision?.() ?? 0;
    await expect(port.disconnectServer("node_repl")).resolves.toMatchObject({
      status: "disconnected",
    });
    expect(port.toolListRevision?.() ?? 0).toBeGreaterThan(before);
    // 已断开时不能再落到本地 runtime；委托 base（真实 base 会返回自身错误）。
    await expect(port.callTool({ serverName: "node_repl", toolName: "js" })).resolves.toMatchObject(
      { content: [{ type: "text", text: "delegated" }] },
    );
    expect(base.calls).toHaveLength(1);
    await port.close();
  });

  it("replace connect without node_repl removes local state and revises the list", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    });
    await port.connectConfiguredServers({ node_repl: { type: "stdio" } as never });
    const before = port.toolListRevision?.() ?? 0;
    await expect(port.connectConfiguredServers({})).resolves.toEqual({
      statuses: {},
      tools: [],
    });
    expect(port.toolListRevision?.() ?? 0).toBeGreaterThan(before);
    await expect(port.listTools()).resolves.toEqual([]);
    await port.close();
  });

  it("close waits for an in-flight local connect and leaves the port disposed", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: true,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    });
    const connecting = port.connectServer("node_repl", { type: "stdio" } as never);
    const closing = port.close();
    await Promise.allSettled([connecting, closing]);
    await expect(port.connectServer("node_repl", { type: "stdio" } as never)).rejects.toThrow(
      "disposed",
    );
    expect(base.closed()).toBe(true);
  });

  it("binds serverPath through the public native factory helper", async () => {
    const base = fakeBasePort();
    const factory = createCuaNodeReplMcpPortFactory({
      serverPath,
      sourceSnapshot: serverSnapshot,
      cellEndpoint: () => "/private/tmp/zody-cell.sock",
    });
    const port = factory({
      port: base.port,
      closePort: false,
      captureOnce: async () => ({ content: [] }),
    });
    await expect(port.listTools()).resolves.toEqual([]);
    await port.close();
  });

  it("constructs before native ready and fails closed without a cellEndpoint getter", async () => {
    const base = fakeBasePort();
    const factory = createCuaNodeReplMcpPortFactory({ serverPath, sourceSnapshot: serverSnapshot });
    const port = factory({
      port: base.port,
      closePort: false,
      captureOnce: async () => ({ content: [] }),
    });
    try {
      await expect(executeJs(port)).rejects.toThrow(/cell_endpoint_required/u);
    } finally {
      await port.close();
    }
  });

  it("fails closed when the CUA factory has no ready cellEndpoint and never path-spawns", async () => {
    const base = fakeBasePort();
    const factory = createCuaNodeReplMcpPortFactory({
      serverPath,
      sourceSnapshot: serverSnapshot,
      cellEndpoint: () => undefined,
    });
    const port = factory({
      port: base.port,
      closePort: false,
      captureOnce: async () => ({ content: [] }),
    });
    try {
      await expect(executeJs(port)).rejects.toThrow(/cell_endpoint_required/u);
    } finally {
      await port.close();
    }
  });

  it("requires a verified source snapshot and never falls back to the path", () => {
    expect(() => createCuaNodeReplMcpPortFactory({ serverPath } as never)).toThrow(
      /source_snapshot_required/u,
    );
    const base = fakeBasePort();
    expect(() =>
      createCuaNodeReplMcpPort({
        port: base.port,
        closePort: false,
        serverPath,
        captureOnce: async () => ({ content: [] }),
      } as never),
    ).toThrow(/source_snapshot_required/u);
  });

  it("rejects subprocess overrides that could replace the snapshot", () => {
    const base = fakeBasePort();
    expect(() =>
      createCuaNodeReplMcpPort({
        port: base.port,
        closePort: false,
        serverPath,
        sourceSnapshot: serverSnapshot,
        captureOnce: async () => ({ content: [] }),
        subprocess: { sourceSnapshot: "synthetic-replacement" } as never,
      }),
    ).toThrow(/override_forbidden:sourceSnapshot/u);
    expect(() =>
      createCuaNodeReplMcpPort({
        port: base.port,
        closePort: false,
        serverPath,
        sourceSnapshot: serverSnapshot,
        captureOnce: async () => ({ content: [] }),
        subprocess: { launch: { command: process.execPath, args: [] } } as never,
      }),
    ).toThrow(/override_forbidden:launch/u);
  });

  it("captures the factory snapshot before mutable options change", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    });
    try {
      const result = await executeJs(port);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "=> 2" }),
      );
    } finally {
      await port.close();
    }
  }, 30_000);

  it("captures the port snapshot before mutable input changes", async () => {
    const base = fakeBasePort();
    const options = {
      port: base.port,
      closePort: false,
      serverPath,
      sourceSnapshot: serverSnapshot,
      captureOnce: async () => ({ content: [] }),
    };
    const port = createCuaNodeReplMcpPort(options);
    options.sourceSnapshot = "";

    try {
      const result = await executeJs(port);
      expect(result.isError).not.toBe(true);
      expect(result.content).toContainEqual(
        expect.objectContaining({ type: "text", text: "=> 2" }),
      );
    } finally {
      await port.close();
    }
  }, 30_000);
});
