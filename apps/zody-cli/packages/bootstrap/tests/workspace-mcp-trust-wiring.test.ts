// fork（F23④，上游 a60ba6a7 workspace-mcp-trust 的 bootstrap 组装接线测试）：
// 覆盖 spec docs/specs/workspace-mcp-trust.md 的跨层验收——
// - 未信任 workspace 声明：连接准入被拒（guard 包整个 lease）、工具数 0
//   （app 级断言在 mcp-project-config.test.ts，本文件覆盖 decide/撤销/digest 全链）；
// - decide 后：allows 通过、新会话连接可用；
// - digest 变更：原授权失配、旧摘要 decide 被拒（workspace_mcp_declaration_changed）；
// - 撤销：新建会话准入被拒（授权作用于未来）；
// - 双横幅数据链：admission 事件 → ProductProjection → snapshot.workspaceMcpAdmission；
// - workspace/mcp/trust handler：落盘 + 按 workspace 通知活跃会话 reload。
// 反例形态（接线前失败）：guard 未安装时 connectConfiguredServers 收到全部 server
// （mcp-project-config.test.ts 已断言该形态）；方法未注册时 workspace/mcp/trust 无应答；
// 投影 case 缺失时 snapshot.workspaceMcpAdmission 恒为 null。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zody/adapters/storage";
import { SessionEventType, type McpPort, type McpServerConfig } from "@zody/contracts";
import type { SessionEvent } from "@zody/contracts";
import { createAppWorkspaceMcpTrust } from "../src/app/runtime-config.js";
import { setWorkspaceMcpTrust } from "../src/zody-protocol/mcp.js";
import type { ZodyProtocolAgentServerContext } from "../src/zody-protocol/server-types.js";
import { createRegistryBackedTestApp as createZodyApp } from "./helpers/registry-backed-test-app.js";

async function createTrustWorkspace(prefix: string): Promise<{
  root: string;
  cwd: string;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(join(root, ".git"));
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(cwd, "zcode.json"),
    JSON.stringify({
      mcp: {
        servers: {
          gated: {
            type: "stdio",
            command: "node",
            args: ["mcp-server.js"],
          },
        },
      },
    }),
  );
  return {
    root,
    cwd,
    home,
    cleanup: async () => {
      await rm(root, { force: true, recursive: true });
    },
  };
}

function createRecordingMcpPort(
  connectedServerSets: string[][],
  connectedServers: string[] = [],
  connectedConfigs: Record<string, McpServerConfig>[] = [],
): McpPort {
  return {
    async callTool() {
      return { content: [] };
    },
    async close() {},
    async connectConfiguredServers(servers) {
      connectedServerSets.push(Object.keys(servers));
      connectedConfigs.push(servers);
      return { statuses: {}, tools: [] };
    },
    async connectServer(name, config) {
      // guard 对过审 workspace 声明走逐 server connectServer（过审集合与 workspace
      // 集合分开连接，spec §7.2）；单独记录以便区分两条连接路径。
      connectedServers.push(name);
      return {
        status: "connected",
        transport: config.type,
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnectServer(_name) {
      return undefined;
    },
    async listTools() {
      return [];
    },
    async status() {
      return {};
    },
  };
}

function createStopModelExecutor() {
  return {
    setModelIoFullRetentionEnabled() {},
    async generateText() {
      return {
        finishReason: "stop",
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText() {
      yield {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never;
}

async function collectAdmissionEvents(
  app: Awaited<ReturnType<typeof createZodyApp>>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const unsubscribe = app.runtime.subscribeEvents({
    onSessionEvent: (event: SessionEvent) => {
      if (event.type === SessionEventType.WorkspaceMcpAdmissionUpdated) events.push(event);
    },
  });
  await app.reloadWorkspaceMcpTrust();
  unsubscribe();
  return events;
}

describe("workspace MCP trust bootstrap wiring", () => {
  it("connects a workspace declaration in a new session only after decide(trusted)", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-decide-");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const connectedBefore: string[][] = [];
    const connectedBeforeServers: string[] = [];
    const connectedAfter: string[][] = [];
    const connectedAfterServers: string[] = [];
    try {
      const authority = createAppWorkspaceMcpTrust({
        workingDirectory: workspace.cwd,
        homeDir: workspace.home,
        env: {},
        skipUserConfig: true,
      });
      const review = (await authority.inspect()).gated;
      expect(review?.trusted).toBe(false);

      const before = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedBefore, connectedBeforeServers),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: { workingDirectory: workspace.cwd },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });
      await before.submitPrompt("hello");
      // 接线前反例形态：旧世界此处为 [["gated","node_repl"]]（默认信任自动连接）。
      expect(connectedBefore).toEqual([["node_repl"]]);
      expect(connectedBeforeServers).toEqual([]);
      await before.close();

      await authority.decide("gated", review!.declarationDigest, true);

      const after = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedAfter, connectedAfterServers),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: { workingDirectory: workspace.cwd },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });
      await after.submitPrompt("hello");
      // 信任后：过审 workspace 声明经逐 server connectServer 连接（spec §7.2 分开连接）。
      expect(connectedAfter).toEqual([["node_repl"]]);
      expect(connectedAfterServers).toEqual(["gated"]);
      const statuses = await after.listMcpServers();
      expect(statuses.gated?.status).not.toBe("pending_trust");
      await after.close();
    } finally {
      sessionStore.close();
      await workspace.cleanup();
    }
  });

  it("requires re-trust after the declaration digest changes and rejects the stale digest", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-digest-");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const connectedAfterChange: string[][] = [];
    try {
      const authority = createAppWorkspaceMcpTrust({
        workingDirectory: workspace.cwd,
        homeDir: workspace.home,
        env: {},
        skipUserConfig: true,
      });
      const original = (await authority.inspect()).gated!;
      await authority.decide("gated", original.declarationDigest, true);

      // 声明变更：args 追加一项 ⇒ digest 变化（S2）。
      await writeFile(
        join(workspace.cwd, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              gated: { type: "stdio", command: "node", args: ["mcp-server.js", "--changed"] },
            },
          },
        }),
      );

      const changed = (await authority.inspect()).gated!;
      expect(changed.declarationDigest).not.toBe(original.declarationDigest);
      expect(changed.trusted).toBe(false);

      // 旧摘要 decide 被拒：审核 A 落盘 B（spec §3.3 规则 9）。
      const context = {
        deps: { env: {} },
        sessions: new Map(),
      } as unknown as ZodyProtocolAgentServerContext;
      const rejected = await setWorkspaceMcpTrust(context, {
        workspace: {
          workspacePath: workspace.cwd,
          workspaceKey: workspace.cwd,
        },
        serverName: "gated",
        declarationDigest: original.declarationDigest,
        trusted: true,
      });
      expect(rejected).toEqual({
        accepted: false,
        reasonCode: "workspace_mcp_declaration_changed",
      });

      const app = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedAfterChange),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: { workingDirectory: workspace.cwd },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });
      await app.submitPrompt("hello");
      // 原授权失配：变更后回到 default-deny。
      expect(connectedAfterChange).toEqual([["node_repl"]]);
      const statuses = await app.listMcpServers();
      expect(statuses.gated?.status).toBe("pending_trust");
      await app.close();
    } finally {
      sessionStore.close();
      await workspace.cleanup();
    }
  });

  it("denies admission in new sessions after revocation", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-revoke-");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const connectedAfterRevoke: string[][] = [];
    try {
      const authority = createAppWorkspaceMcpTrust({
        workingDirectory: workspace.cwd,
        homeDir: workspace.home,
        env: {},
        skipUserConfig: true,
      });
      const review = (await authority.inspect()).gated!;
      await authority.decide("gated", review.declarationDigest, true);
      expect((await authority.inspect()).gated?.trusted).toBe(true);

      // 撤销：删除精确记录；授权作用于未来——新建会话准入被拒（A1）。
      await authority.decide("gated", review.declarationDigest, false);
      expect((await authority.inspect()).gated?.trusted).toBe(false);

      const app = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedAfterRevoke),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: { workingDirectory: workspace.cwd },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });
      await app.submitPrompt("hello");
      expect(connectedAfterRevoke).toEqual([["node_repl"]]);
      const statuses = await app.listMcpServers();
      expect(statuses.gated?.status).toBe("pending_trust");
      await app.close();
    } finally {
      sessionStore.close();
      await workspace.cleanup();
    }
  });

  it("publishes WorkspaceMcpAdmissionUpdated through reloadWorkspaceMcpTrust (banner data chain)", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-admission-");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const app = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort([]),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: { workingDirectory: workspace.cwd },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });

      // 未信任：admission 事件携带 pendingCount 1（横幅 A 数据源）。
      const pending = await collectAdmissionEvents(app);
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toMatchObject({ pendingCount: 1 });
      expect((pending[0].payload as { bundleDigest: string }).bundleDigest).toMatch(
        /^[a-f0-9]{64}$/,
      );

      // 信任后：清零事件（pendingCount 0 → 投影置 null）。
      const authority = createAppWorkspaceMcpTrust({
        workingDirectory: workspace.cwd,
        homeDir: workspace.home,
        env: {},
        skipUserConfig: true,
      });
      const review = (await authority.inspect()).gated!;
      await authority.decide("gated", review.declarationDigest, true);
      const cleared = await collectAdmissionEvents(app);
      expect(cleared).toHaveLength(1);
      expect(cleared[0].payload).toMatchObject({ pendingCount: 0 });
      await app.close();
    } finally {
      sessionStore.close();
      await workspace.cleanup();
    }
  });

  it("setWorkspaceMcpTrust handler notifies only matching-workspace live sessions", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-handler-");
    try {
      const authority = createAppWorkspaceMcpTrust({
        workingDirectory: workspace.cwd,
        homeDir: workspace.home,
        env: {},
        skipUserConfig: true,
      });
      const review = (await authority.inspect()).gated!;
      const matchingReload = vi.fn(async () => undefined);
      const otherReload = vi.fn(async () => undefined);
      const sessions = new Map(
        [
          [
            "s1",
            {
              workspace: { workspaceKey: workspace.cwd },
              app: { reloadWorkspaceMcpTrust: matchingReload },
            },
          ],
          [
            "s2",
            {
              workspace: { workspaceKey: "/other/workspace" },
              app: { reloadWorkspaceMcpTrust: otherReload },
            },
          ],
        ].map(([id, record]) => [id, record as never]),
      );
      const context = {
        deps: { env: {} },
        sessions,
      } as unknown as ZodyProtocolAgentServerContext;
      // 测试注入隔离 HOME 的 authority（生产 dispatch 不传，落真实 ~/.zody/security）。
      const createAuthority = (params: Parameters<typeof createAppWorkspaceMcpTrust>[0]) =>
        createAppWorkspaceMcpTrust({ ...params, homeDir: workspace.home });

      const accepted = await setWorkspaceMcpTrust(
        context,
        {
          workspace: { workspacePath: workspace.cwd, workspaceKey: workspace.cwd },
          serverName: "gated",
          declarationDigest: review.declarationDigest,
          trusted: true,
        },
        { createAuthority },
      );
      expect(accepted).toEqual({ accepted: true });
      // 决策已落盘（同一 store 可见）且只通知匹配 workspace 的活跃会话。
      expect((await authority.inspect()).gated?.trusted).toBe(true);
      expect(matchingReload).toHaveBeenCalledOnce();
      expect(otherReload).not.toHaveBeenCalled();

      // 未声明/未知 serverName 的 decide 被拒：锁内重读无该声明 ⇒ 摘要不匹配
      // （workspace_mcp_declaration_changed；unavailable 分支保留给 store IO 故障）。
      const unknown = await setWorkspaceMcpTrust(
        context,
        {
          workspace: { workspacePath: workspace.cwd, workspaceKey: workspace.cwd },
          serverName: "missing",
          declarationDigest: "c".repeat(64),
          trusted: true,
        },
        { createAuthority },
      );
      expect(unknown.accepted).toBe(false);
      expect(unknown.reasonCode).toBe("workspace_mcp_declaration_changed");
    } finally {
      await workspace.cleanup();
    }
  });

  it("keeps explicitly delivered MCP exempt from the gate (source豁免 A6)", async () => {
    const workspace = await createTrustWorkspace("zody-mcp-wiring-exempt-");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const connected: string[][] = [];
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    try {
      const app = await createZodyApp({
        env: {},
        mcpPort: createRecordingMcpPort(connected, [], connectedConfigs),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: workspace.cwd,
          // 显式下发的 MCP（协议 session/create 通道）不是 workspace 可达文件声明：
          // 与 workspace zcode.json 声明走不同摘要判定，不得被误拦截（spec §5.1 豁免）。
          mcp: {
            servers: {
              delivered: { type: "stdio", command: "node", args: ["delivered.js"] },
            },
          },
        },
        sessionStore,
        skipUserConfig: true,
        workspaceMcpTrustHomeDir: workspace.home,
      });
      await app.submitPrompt("hello");
      expect(connected[0]).toContain("delivered");
      expect(connected[0]).toContain("node_repl");
      expect(connected[0]).not.toContain("gated");
      expect(connectedConfigs[0]?.delivered).toMatchObject({ command: "node" });
      await app.close();
    } finally {
      sessionStore.close();
      await workspace.cleanup();
    }
  });
});
