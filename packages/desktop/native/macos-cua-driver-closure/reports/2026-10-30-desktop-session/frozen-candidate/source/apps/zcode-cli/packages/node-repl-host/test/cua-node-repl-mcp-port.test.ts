import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpPort,
  McpToolCallResult,
} from "@zcode/contracts";
import {
  createCuaNodeReplMcpPort,
  createCuaNodeReplMcpPortFactory,
} from "../src/cua-node-repl-mcp-port.js";
import type { CuaCaptureExpectation, CuaCaptureTarget } from "../src/cua-capture-runtime.js";

const IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lY1J3QAAAABJRU5ErkJggg==";
const SERVER_PATH = resolve(import.meta.dirname, "../dist/mcp/server.js");
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
      serverPath: SERVER_PATH,
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

  it("delegates non-node_repl tools and does not close a borrowed base port", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath: SERVER_PATH,
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
      serverPath: SERVER_PATH,
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

  it("disconnect tears down local node_repl and revises the tool list", async () => {
    const base = fakeBasePort();
    const port = createCuaNodeReplMcpPort({
      port: base.port,
      closePort: false,
      serverPath: SERVER_PATH,
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
      serverPath: SERVER_PATH,
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
      serverPath: SERVER_PATH,
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
      serverPath: SERVER_PATH,
    });
    const port = factory({
      port: base.port,
      closePort: false,
      captureOnce: async () => ({ content: [] }),
    });
    await expect(port.listTools()).resolves.toEqual([]);
    await port.close();
  });
});
