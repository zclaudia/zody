import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { McpPort, McpToolCallResult } from "@zcode/contracts";
import { createRootTraceContext } from "@zcode/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createCuaNodeReplMcpPortFactory } from "../../node-repl-host/src/cua-node-repl-mcp-port.js";
import type { CuaNodeReplMcpPortFactoryInput } from "../src/app/cua-runtime-native-capture.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeMcpPort(): { port: McpPort; closed: () => boolean } {
  let closeCalled = false;
  return {
    closed: () => closeCalled,
    port: {
      async connectConfiguredServers() {
        return { statuses: {}, tools: [] };
      },
      async connectServer() {
        throw new Error("unexpected connectServer");
      },
      async disconnectServer() {
        return undefined;
      },
      async status() {
        return {};
      },
      async listTools() {
        return [];
      },
      async callTool(): Promise<McpToolCallResult> {
        return { content: [] };
      },
      async close() {
        closeCalled = true;
      },
    },
  };
}

describe("createZCodeApp cua node_repl composition", () => {
  it("wraps the real app base McpPort only with explicit capture and factory", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-node-repl-wiring-"));
    roots.push(root);
    const base = fakeMcpPort();
    const seen: CuaNodeReplMcpPortFactoryInput[] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      cuaNativeCapture: {
        connect: async () => {
          throw new Error("capture connect must not run during startup");
        },
        producerIncarnation: "producer-wiring",
        captureRoot: root,
      },
      cuaNodeReplMcpPortFactory: (input) => {
        seen.push(input);
        return input.port;
      },
      cwd: root,
      env: {},
      mcpPort: base.port,
      runtimeConfig: { mcp: { enabled: false }, workingDirectory: root },
      sessionStore,
      skipUserConfig: true,
    });
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.port).toBe(base.port);
      expect(seen[0]?.closePort).toBe(false);
      expect(seen[0]?.captureOnce).toBeTypeOf("function");
      expect(app.captureCuaOnce).toBeTypeOf("function");
    } finally {
      await app.close?.();
      sessionStore.close();
    }
    // 注入的 port 由宿主拥有，wrapper 不得误关。
    expect(base.closed()).toBe(false);
  });

  it("registers the real local node_repl tool through default MCP initialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-node-repl-default-"));
    roots.push(root);
    const userConfigPath = join(root, "user-config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "browser-use@zcode-plugins-official": false,
            "computer-use@zcode-plugins-official": false,
          },
        },
      }),
    );
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      cuaNativeCapture: {
        connect: async () => {
          throw new Error("capture connect must not run during tool discovery");
        },
        producerIncarnation: "producer-default-composition",
        captureRoot: root,
      },
      cuaNodeReplMcpPortFactory: createCuaNodeReplMcpPortFactory({
        serverPath: resolve(import.meta.dirname, "../../node-repl-host/dist/mcp/server.js"),
      }),
      cwd: root,
      env: { HOME: root, ZCODE_STORAGE_DIR: root },
      runtimeConfig: { workingDirectory: root },
      sessionStore,
      skipUserConfig: false,
      userConfigPath,
    });
    try {
      const traceContext = createRootTraceContext({ sessionId: app.sessionId });
      await (
        app.runtime as unknown as {
          initializeMcp(trace: typeof traceContext): Promise<void>;
        }
      ).initializeMcp(traceContext);

      expect(app.runtime.getToolRegistry().get("mcp__node_repl__js")).toBeDefined();
      expect(app.runtime.getTools().map((tool) => tool.name)).toContain("mcp__node_repl__js");
    } finally {
      await app.close?.();
      sessionStore.close();
    }
  });

  it("keeps node_repl unregistered when the candidate has no native capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-node-repl-factory-only-"));
    roots.push(root);
    const userConfigPath = join(root, "user-config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "browser-use@zcode-plugins-official": false,
            "computer-use@zcode-plugins-official": false,
          },
        },
      }),
    );
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      cuaNodeReplMcpPortFactory: createCuaNodeReplMcpPortFactory({
        serverPath: resolve(import.meta.dirname, "../../node-repl-host/dist/mcp/server.js"),
      }),
      cwd: root,
      env: { HOME: root, ZCODE_STORAGE_DIR: root },
      runtimeConfig: { workingDirectory: root },
      sessionStore,
      skipUserConfig: false,
      userConfigPath,
    });
    try {
      const traceContext = createRootTraceContext({ sessionId: app.sessionId });
      await (
        app.runtime as unknown as {
          initializeMcp(trace: typeof traceContext): Promise<void>;
        }
      ).initializeMcp(traceContext);

      // 仅凭 factory 不能把真实 node_repl 塞给 base 端口；必须同时有 native capture wrapper。
      expect(app.runtime.getToolRegistry().get("mcp__node_repl__js")).toBeUndefined();
    } finally {
      await app.close?.();
      sessionStore.close();
    }
  });

  it("keeps node_repl unregistered when MCP is explicitly disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-cua-node-repl-mcp-disabled-"));
    roots.push(root);
    const userConfigPath = join(root, "user-config.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        plugins: {
          enabledPlugins: {
            "browser-use@zcode-plugins-official": false,
            "computer-use@zcode-plugins-official": false,
          },
        },
      }),
    );
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createRegistryBackedTestApp({
      cuaNativeCapture: {
        connect: async () => {
          throw new Error("capture connect must not run while MCP is disabled");
        },
        producerIncarnation: "producer-mcp-disabled",
        captureRoot: root,
      },
      cuaNodeReplMcpPortFactory: createCuaNodeReplMcpPortFactory({
        serverPath: resolve(import.meta.dirname, "../../node-repl-host/dist/mcp/server.js"),
      }),
      cwd: root,
      env: { HOME: root, ZCODE_STORAGE_DIR: root },
      runtimeConfig: { mcp: { enabled: false }, workingDirectory: root },
      sessionStore,
      skipUserConfig: false,
      userConfigPath,
    });
    try {
      const traceContext = createRootTraceContext({ sessionId: app.sessionId });
      await (
        app.runtime as unknown as {
          initializeMcp(trace: typeof traceContext): Promise<void>;
        }
      ).initializeMcp(traceContext);

      expect(app.runtime.getToolRegistry().get("mcp__node_repl__js")).toBeUndefined();
    } finally {
      await app.close?.();
      sessionStore.close();
    }
  });
});
