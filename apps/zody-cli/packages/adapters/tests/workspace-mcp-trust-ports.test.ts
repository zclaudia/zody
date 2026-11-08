// fork（F23④，上游 a60ba6a7 workspace-mcp-trust 模块 store/discover 接线的适配层测试）：
// 覆盖 spec docs/specs/workspace-mcp-trust.md 的 S2（digest 输入来源）、A3（锁内原子写）、
// A4（default-deny：损坏 store fail-closed）与 §5（发现范围：project 作用域 + `.agents/mcp.json`
// fallback、坏邻项不得拖垮列表也不得放行）。反例形态：接线前本文件两个 port 符号不存在
// （编译期即失败）；旧世界（默认信任空集）下无任何发现/存储判定可测。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileWorkspaceMcpTrustStorePort,
  resolveWorkspaceMcpTrustStorePath,
} from "../src/storage/workspace-mcp-trust-store.js";
import { resolveWorkspaceHookTrustStorePath } from "../src/storage/workspace-hook-trust-store.js";
import { createWorkspaceMcpTrustDiscoveryPort } from "../src/config/workspace-mcp-trust-discovery.js";

describe("workspace MCP trust store port", () => {
  it("resolves the store path in the same security directory as the hook trust store", async () => {
    const home = await mkdtemp(join(tmpdir(), "zody-mcp-trust-home-"));
    try {
      const hookPath = await resolveWorkspaceHookTrustStorePath({ homeDir: home });
      const mcpPath = await resolveWorkspaceMcpTrustStorePath({ homeDir: home });
      expect(mcpPath).toBe(join(join(hookPath, ".."), "workspace-mcp-trust-v1.json"));
      expect(mcpPath.startsWith(home)).toBe(true);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("returns no records for a missing store and roundtrips writes through the schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-store-"));
    const filePath = join(root, "workspace-mcp-trust-v1.json");
    const port = createFileWorkspaceMcpTrustStorePort({ filePath });
    try {
      await expect(port.readRecords()).resolves.toEqual([]);
      const grantedAt = new Date("2026-11-08T00:00:00Z").toISOString();
      await port.writeRecords([
        {
          workspaceIdentity: "/tmp/ws-a",
          serverName: "grep",
          declarationDigest: "a".repeat(64),
          grantedAt,
        },
      ]);
      await expect(port.readRecords()).resolves.toEqual([
        {
          workspaceIdentity: "/tmp/ws-a",
          serverName: "grep",
          declarationDigest: "a".repeat(64),
          grantedAt,
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed on a corrupt store instead of returning partial records", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-corrupt-"));
    const filePath = join(root, "workspace-mcp-trust-v1.json");
    const port = createFileWorkspaceMcpTrustStorePort({ filePath });
    try {
      await writeFile(filePath, "{ not json", "utf8");
      await expect(port.readRecords()).rejects.toThrow(/invalid/i);
      // 缺字段/坏摘要同样按损坏处理（shared schema 单源 strict 校验）。
      await writeFile(
        filePath,
        JSON.stringify({ schemaVersion: 1, records: [{ nope: 1 }] }),
        "utf8",
      );
      await expect(port.readRecords()).rejects.toThrow(/invalid/i);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("serializes concurrent locked read-modify-write across port instances without losing records", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-lock-"));
    const filePath = join(root, "workspace-mcp-trust-v1.json");
    const grantedAt = new Date().toISOString();
    try {
      // 两个独立 port 实例（模拟并发进程/多会话）各锁内重读 + 追加各自 workspace 的记录。
      await Promise.all(
        ["/tmp/ws-a", "/tmp/ws-b"].map(async (workspaceIdentity) => {
          const port = createFileWorkspaceMcpTrustStorePort({ filePath });
          await port.withLock(async () => {
            const current = await port.readRecords();
            await port.writeRecords([
              ...current,
              {
                workspaceIdentity,
                serverName: "grep",
                declarationDigest: "b".repeat(64),
                grantedAt,
              },
            ]);
          });
        }),
      );
      const final = await createFileWorkspaceMcpTrustStorePort({ filePath }).readRecords();
      expect(final.map((record) => record.workspaceIdentity).sort()).toEqual([
        "/tmp/ws-a",
        "/tmp/ws-b",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("workspace MCP trust discovery port", () => {
  it("discovers project-scope declarations with source paths and skips user-scope names", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-discovery-"));
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "cli", "config.json");
    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspace, { recursive: true });
      await mkdir(join(root, "home", "cli"), { recursive: true });
      // project 作用域：workspace 根 zcode.json。
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: { project: { type: "stdio", command: "node", args: ["mcp-server.js"] } },
          },
        }),
      );
      // 用户作用域同名覆盖 + 独有用户条目：均不得进入 workspace 声明。
      await writeFile(
        userConfigPath,
        JSON.stringify({
          mcp: {
            servers: {
              project: { type: "stdio", command: "user-server" },
              userOnly: { type: "stdio", command: "user-only-server" },
            },
          },
        }),
      );

      const declarations = await createWorkspaceMcpTrustDiscoveryPort({
        env: {},
        workingDirectory: workspace,
        userConfigPath,
      }).discover();

      // 用户覆盖后 serverSources["project"] === "user"：同名条目不再是 workspace 声明。
      expect(Object.keys(declarations).sort()).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps a project-only declaration when no user override claims the name", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-discovery-project-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(join(root, ".git"));
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: { project: { type: "stdio", command: "node", args: ["mcp-server.js"] } },
          },
        }),
      );
      const declarations = await createWorkspaceMcpTrustDiscoveryPort({
        env: {},
        workingDirectory: workspace,
        skipUserConfig: true,
      }).discover();
      expect(declarations.project).toMatchObject({
        config: { type: "stdio", command: "node", args: ["mcp-server.js"] },
      });
      expect(declarations.project?.sourcePaths.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to workspace .agents/mcp.json only when project config declares no MCP entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-agents-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(workspace, ".agents"), { recursive: true });
      await writeFile(
        join(workspace, ".agents", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            agentsOnly: { type: "stdio", command: "node", args: ["agents-server.js"] },
          },
        }),
      );

      const declarations = await createWorkspaceMcpTrustDiscoveryPort({
        env: {},
        workingDirectory: workspace,
        skipUserConfig: true,
      }).discover();
      expect(declarations.agentsOnly).toMatchObject({
        config: { type: "stdio", command: "node" },
        sourcePaths: [join(workspace, ".agents", "mcp.json")],
      });

      // project 配置出现 MCP 条目后 fallback 不再接管（上游条件原样保留）。
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: { servers: { project: { type: "stdio", command: "node" } } },
        }),
      );
      const next = await createWorkspaceMcpTrustDiscoveryPort({
        env: {},
        workingDirectory: workspace,
        skipUserConfig: true,
      }).discover();
      expect(next.agentsOnly).toBeUndefined();
      expect(next.project).toBeDefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps an invalid .agents neighbor deny-closed without breaking the rest of the list", async () => {
    const root = await mkdtemp(join(tmpdir(), "zody-mcp-trust-invalid-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(join(root, ".git"));
      await mkdir(join(workspace, ".agents"), { recursive: true });
      await writeFile(
        join(workspace, ".agents", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            good: { type: "stdio", command: "node", args: ["good.js"] },
            // command 缺失：条目级校验失败。
            bad: { type: "stdio", args: ["bad.js"] },
          },
        }),
      );
      const declarations = await createWorkspaceMcpTrustDiscoveryPort({
        env: {},
        workingDirectory: workspace,
        skipUserConfig: true,
      }).discover();
      expect(declarations.good).toBeDefined();
      // 坏邻项占位声明（enabled:false）：core allows 一律拒绝、不计入 admission pending
      // ——校验失败的 workspace 声明不能退化为「未知来源 = 放行」。
      expect(declarations.bad).toMatchObject({ config: { enabled: false } });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
