import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpPort } from "@zody/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  zcodeMcpListResultSchema,
  zcodeMcpListParamsSchema,
  zcodeProtocolMethods,
  zcodeProtocolSessionMethodContracts,
} from "@zody/shared";
import { listMcpServers } from "../src/zody-protocol/mcp.js";
import { mcpUiInstances } from "../src/zody-protocol/mcp-ui/instances.js";
import { openMcpUiInstance } from "../src/zody-protocol/mcp-ui/protocol.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zody-protocol/server-types.js";

describe("mcp protocol contracts", () => {
  it("registers mcp/list", () => {
    expect(zcodeProtocolMethods.mcpList).toBe("mcp/list");
    expect(zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.mcpList]).toBeDefined();
  });

  it("parses an MCP status snapshot", () => {
    const parsed = zcodeMcpListResultSchema.parse({
      statuses: {
        filesystem: {
          status: "disconnected",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-06-23T00:00:00.000Z",
        },
      },
    });

    expect(parsed.statuses.filesystem?.status).toBe("disconnected");
  });

  it("defaults mcp/list mode to connect and accepts status-only mode", () => {
    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
      }).mode,
    ).toBe("connect");

    expect(
      zcodeMcpListParamsSchema.parse({
        workspace: {
          workspaceKey: "/tmp/project",
          workspacePath: "/tmp/project",
        },
        mode: "status",
      }).mode,
    ).toBe("status");
  });

  it("rejects invalid MCP status values", () => {
    expect(() =>
      zcodeMcpListResultSchema.parse({
        statuses: {
          broken: {
            status: "unknown",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-06-23T00:00:00.000Z",
          },
        },
      }),
    ).toThrow();
  });

  it("parses HTTP MCP OAuth client credentials in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "protected",
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: [],
          oauth: {
            type: "client_credentials",
            clientId: "zcode-client",
            clientSecret: "secret",
            scope: "mcp:tools",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "protected",
      oauth: {
        type: "client_credentials",
        clientId: "zcode-client",
      },
    });
  });

  it("parses HTTP MCP OAuth authorization code in protocol params", () => {
    const parsed = zcodeMcpListParamsSchema.parse({
      workspace: {
        workspaceKey: "/tmp/project",
        workspacePath: "/tmp/project",
      },
      mcpServers: [
        {
          name: "figma",
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: [],
          oauth: {
            type: "authorization_code",
            clientName: "ZCode",
            redirectPath: "/oauth/callback/mcp/figma",
            scope: "mcp:connect",
          },
        },
      ],
    });

    expect(parsed.mcpServers?.[0]).toMatchObject({
      name: "figma",
      oauth: {
        type: "authorization_code",
        clientName: "ZCode",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });
});

// Bugfix 回归：设置页刷新的 mcp/list 必须带 revalidate，否则进程级 `protocol-settings` lease
// 会命中连接池里的旧 entry 并回放陈旧快照（见 adapters/src/mcp/pool.ts revalidateEntry）。
describe("mcp/list connection revalidation", () => {
  it("asks the pool to revalidate on the default connect mode and skips it for status mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-list-revalidate-"));
    const previousStorageDir = process.env.ZCODE_STORAGE_DIR;
    process.env.ZCODE_STORAGE_DIR = join(root, "cli");
    const connectConfiguredServers = vi.fn(async () => ({ statuses: {}, tools: [] }));
    const status = vi.fn(async () => ({}));
    const mcpPort = {
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
      connectConfiguredServers,
      connectServer: vi.fn(),
      disconnectServer: vi.fn(),
      listTools: vi.fn(async () => []),
      status,
    } as unknown as McpPort;
    const context = {
      deps: { env: process.env, mcpPort },
    } as unknown as ZCodeProtocolAgentServerContext;
    const params = {
      mcpServers: [],
      workspace: { workspaceKey: root, workspacePath: root },
    };

    try {
      await listMcpServers(context, params);
      expect(connectConfiguredServers).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revalidate: true }),
      );

      connectConfiguredServers.mockClear();
      await listMcpServers(context, { ...params, mode: "status" });
      expect(connectConfiguredServers).not.toHaveBeenCalled();
    } finally {
      if (previousStorageDir === undefined) delete process.env.ZCODE_STORAGE_DIR;
      else process.env.ZCODE_STORAGE_DIR = previousStorageDir;
      await rm(root, { force: true, recursive: true });
    }
  });
});

interface OpenInstanceAppMock {
  getMcpAppConnectionSnapshot: () => { identity: string; generation: number } | null;
  /** 首开只允许等待既有连接；重连入口被调用即失败（见下）。 */
  connectMcpServer: (serverName: string) => Promise<unknown>;
  waitForMcpAppConnection: (
    serverName: string,
  ) => Promise<{ identity: string; generation: number } | null>;
  onMcpAppConnectionInvalidated: (serverName: string, listener: () => void) => () => void;
  unsubscribeMcpResourcesForUi: (prefix: string) => Promise<number>;
}

let openPageSequence = 0;
function createOpenPage() {
  openPageSequence += 1;
  const params = {
    workspace: {
      workspaceKey: `/workspace-${openPageSequence}`,
      workspacePath: `/workspace-${openPageSequence}`,
    },
    sessionId: `session-${openPageSequence}`,
    pluginId: `plugin-${openPageSequence}`,
    serverName: `server-${openPageSequence}`,
    scopeId: `scope-${openPageSequence}`,
    resourceUri: `ui://app-${openPageSequence}`,
    ownerWebContentsId: 1,
  };
  const app: OpenInstanceAppMock = {
    getMcpAppConnectionSnapshot: () => null,
    connectMcpServer: vi.fn(async () => {
      throw new Error("mcp/uiOpenInstance must not start a new connection");
    }),
    waitForMcpAppConnection: vi.fn(async () => null),
    onMcpAppConnectionInvalidated: vi.fn(() => () => {}),
    unsubscribeMcpResourcesForUi: vi.fn(async () => 0),
  };
  const sessions = new Map<string, { app: OpenInstanceAppMock }>([[params.sessionId, { app }]]);
  const context = { deps: {}, sessions } as unknown as ZCodeProtocolAgentServerContext;
  return { app, context, params, sessions };
}

/** 只接只读等待入口；connectMcpServer 保持抛错，重连实现会直接暴露。 */
function deferConnection(
  page: ReturnType<typeof createOpenPage>,
  wait: () => Promise<{ identity: string; generation: number } | null>,
) {
  const waitFor = vi.fn(wait);
  page.app.waitForMcpAppConnection = waitFor;
  return waitFor;
}

function trackSettled(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

async function nextTask() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 首开屏障：initialize 尚未完成时 mcp/uiOpenInstance 必须等待既有连接任务，
// 放行后重新校验会话与代际再签发页面（见 docs/plugin-ui-connection-readiness.md）。
describe("mcp/uiOpenInstance connection readiness", () => {
  it("waits for the existing connection and opens without a retry", async () => {
    const page = createOpenPage();
    const gate = Promise.withResolvers<void>();
    let source: { identity: string; generation: number } | null = null;
    page.app.getMcpAppConnectionSnapshot = () => source;
    deferConnection(page, async () => {
      await gate.promise;
      source = { identity: "ready-source", generation: 1 };
      return source;
    });

    const opening = openMcpUiInstance(page.context, page.params);
    const state = trackSettled(opening);
    await nextTask();
    expect(state.settled).toBe(false);

    gate.resolve();
    const lease = await opening;
    expect(lease.generation).toBe(1);
    expect(mcpUiInstances.find(lease.token)?.source).toEqual({
      identity: "ready-source",
      generation: 1,
    });
    expect(page.app.onMcpAppConnectionInvalidated).toHaveBeenCalledTimes(1);
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
  });

  it("rejects without a lease when the session is released during the wait", async () => {
    const page = createOpenPage();
    const gate = Promise.withResolvers<void>();
    deferConnection(page, async () => {
      await gate.promise;
      return { identity: "ready-source", generation: 1 };
    });

    const opening = openMcpUiInstance(page.context, page.params);
    const state = trackSettled(opening);
    const outcome = opening.then(
      () => null,
      (error: { code?: number }) => error,
    );
    await nextTask();
    expect(state.settled).toBe(false);
    page.sessions.delete(page.params.sessionId);

    gate.resolve();
    expect(await outcome).toMatchObject({ code: -32004 });
    expect(page.app.onMcpAppConnectionInvalidated).not.toHaveBeenCalled();
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
  });

  it("binds the page to the connection generation observed after the wait", async () => {
    const page = createOpenPage();
    const gate = Promise.withResolvers<void>();
    let source: { identity: string; generation: number } | null = null;
    page.app.getMcpAppConnectionSnapshot = () => source;
    deferConnection(page, async () => {
      await gate.promise;
      source = { identity: "replacement-source", generation: 4 };
      return source;
    });

    const opening = openMcpUiInstance(page.context, page.params);
    const state = trackSettled(opening);
    await nextTask();
    expect(state.settled).toBe(false);

    gate.resolve();
    const lease = await opening;
    expect(mcpUiInstances.find(lease.token)?.source).toEqual({
      identity: "replacement-source",
      generation: 4,
    });
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
  });

  it("shares one instance between concurrent first opens of the same page", async () => {
    const page = createOpenPage();
    const gate = Promise.withResolvers<void>();
    let source: { identity: string; generation: number } | null = null;
    page.app.getMcpAppConnectionSnapshot = () => source;
    deferConnection(page, async () => {
      await gate.promise;
      source = { identity: "shared-source", generation: 2 };
      return source;
    });

    const first = openMcpUiInstance(page.context, page.params);
    const second = openMcpUiInstance(page.context, page.params);
    const firstState = trackSettled(first);
    const secondState = trackSettled(second);
    await nextTask();
    expect(firstState.settled).toBe(false);
    expect(secondState.settled).toBe(false);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(b.token).toBe(a.token);
    expect(b.generation).toBe(a.generation);
    expect(page.app.onMcpAppConnectionInvalidated).toHaveBeenCalledTimes(1);
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
  });

  it("turns a failed connection into a terminal error without a lease", async () => {
    const page = createOpenPage();
    const gate = Promise.withResolvers<void>();
    deferConnection(page, async () => {
      await gate.promise;
      throw new Error("initialize failed");
    });

    const opening = openMcpUiInstance(page.context, page.params);
    const state = trackSettled(opening);
    const outcome = opening.then(
      () => null,
      (error: { code?: number }) => error,
    );
    await nextTask();
    expect(state.settled).toBe(false);
    gate.resolve();

    expect(await outcome).toMatchObject({ code: -32001 });
    expect(page.app.onMcpAppConnectionInvalidated).not.toHaveBeenCalled();
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
  });

  it("does not start a new connection when no existing task is available", async () => {
    const page = createOpenPage();
    // 既未租用也没有既有连接任务：立即终态，不能借 open 触发新的 initialize。
    await expect(openMcpUiInstance(page.context, page.params)).rejects.toMatchObject({
      code: -32001,
    });
    expect(page.app.connectMcpServer).not.toHaveBeenCalled();
    expect(page.app.onMcpAppConnectionInvalidated).not.toHaveBeenCalled();
  });
});
