import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolDescriptor,
  WorkspaceMcpAdmissionUpdatedPayload,
} from "@zody/contracts";
import type { WorkspaceMcpTrustRecord } from "@zody/shared";
import {
  buildWorkspaceMcpTrustDisplay,
  computeWorkspaceMcpAdmissionBundleDigest,
  computeWorkspaceMcpDeclarationDigest,
  createWorkspaceMcpTrust,
  type WorkspaceMcpTrustDeclarationInput,
  type WorkspaceMcpTrustStorePort,
} from "../src/mcp/workspace-mcp-trust.js";

// F23（上游 a60ba6a7）：workspace MCP 信任门域测试。
// spec：docs/specs/workspace-mcp-trust.md §7/§9（guard 状态机、S1/S2/A1–A7/A10）。

/** 串行互斥 store（promise-chain 锁）：验证「锁内重读+原子写 ⇒ 并发不丢记录」的契约。 */
class MemoryStore implements WorkspaceMcpTrustStorePort {
  records: WorkspaceMcpTrustRecord[] = [];
  failRead = false;
  lockCount = 0;
  private tail: Promise<unknown> = Promise.resolve();

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    this.lockCount += 1;
    return next;
  }

  async readRecords(): Promise<WorkspaceMcpTrustRecord[]> {
    if (this.failRead) throw new Error("store unreadable");
    return structuredClone(this.records);
  }

  async writeRecords(records: readonly WorkspaceMcpTrustRecord[]): Promise<void> {
    this.records = structuredClone([...records]);
  }
}

function stdioConfig(overrides: Partial<Extract<McpServerConfig, { type: "stdio" }>> = {}) {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    ...overrides,
  } satisfies McpServerConfig;
}

function createAuthority(input: {
  declarations: Record<string, WorkspaceMcpTrustDeclarationInput>;
  store: MemoryStore;
  workingDirectory?: string;
  workspaceIdentity?: string;
  onAdmissionChanged?: (state: WorkspaceMcpAdmissionUpdatedPayload) => Promise<void>;
}) {
  return createWorkspaceMcpTrust({
    workingDirectory: input.workingDirectory ?? "/ws",
    workspaceIdentity: input.workspaceIdentity,
    discovery: { discover: async () => structuredClone(input.declarations) },
    store: input.store,
    onAdmissionChanged: input.onAdmissionChanged,
    now: () => new Date("2026-11-07T00:00:00.000Z"),
  });
}

/** 非真实连接的 fake port：记录调用面，供 guard 语义断言。 */
function createFakePort() {
  const connected = new Map<string, McpServerConfig>();
  const calls: string[] = [];
  const port: McpPort = {
    async connectServer(name, config) {
      calls.push(`connect:${name}`);
      connected.set(name, config);
      return connectedStatus(name, config);
    },
    async connectConfiguredServers(servers) {
      for (const [name, config] of Object.entries(servers)) {
        calls.push(`connect:${name}`);
        connected.set(name, config);
      }
      return snapshot();
    },
    async disconnectServer(name) {
      calls.push(`disconnect:${name}`);
      connected.delete(name);
      return undefined;
    },
    async status() {
      return Object.fromEntries(
        [...connected].map(([name, config]) => [name, connectedStatus(name, config)]),
      );
    },
    async listTools() {
      return [...connected.keys()].flatMap((serverName) => [
        { serverName, toolName: "probe", name: "probe", inputSchema: { type: "object" } },
      ]) as McpToolDescriptor[];
    },
    async callTool(request) {
      calls.push(`call:${request.serverName}`);
      return {
        content: [{ type: "text", text: `ok:${request.serverName}` }],
      } as Awaited<ReturnType<McpPort["callTool"]>>;
    },
    async pingServer(name) {
      return connected.has(name);
    },
    appConnectionSnapshot(name) {
      return connected.has(name) ? { identity: name, generation: 1 } : null;
    },
    async waitForAppConnection(name) {
      return connected.has(name) ? { identity: name, generation: 1 } : null;
    },
    async unsubscribeResourcesBySubscriber() {
      calls.push("unsubscribeBySubscriber");
      return 0;
    },
    async close() {
      calls.push("close");
      connected.clear();
    },
  };
  function connectedStatus(name: string, config: McpServerConfig): McpServerStatus {
    return {
      status: "connected",
      transport: config.type,
      toolCount: 1,
      updatedAt: "2026-11-07T00:00:00.000Z",
    };
  }
  function snapshot(): McpConnectionSnapshot {
    return {
      statuses: Object.fromEntries(
        [...connected].map(([name, config]) => [name, connectedStatus(name, config)]),
      ),
      tools: [...connected.keys()].flatMap((serverName) => [
        { serverName, toolName: "probe", name: "probe", inputSchema: { type: "object" } },
      ]) as McpToolDescriptor[],
    };
  }
  return { port, calls, connected };
}

describe("inspect / decide / allows（spec §7.1）", () => {
  it("inspect 不连接且不产生任何 MCP 调用（A2）", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    authority.guard(fake.port);
    const reviews = await authority.inspect();
    expect(reviews.probe?.trusted).toBe(false);
    expect(reviews.probe?.configuredEnabled).toBe(true);
    expect(reviews.probe?.transport).toBe("stdio");
    expect(fake.calls).toEqual([]);
  });

  it("decide 落盘精确记录并使 inspect 翻转为 trusted", async () => {
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    const digest = (await authority.inspect()).probe!.declarationDigest;
    await authority.decide("probe", digest, true);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]).toMatchObject({
      workspaceIdentity: "/ws",
      serverName: "probe",
      declarationDigest: digest,
    });
    expect((await authority.inspect()).probe?.trusted).toBe(true);
  });

  it("decide 锁内重读：摘要陈旧（声明已变）时拒绝落盘（A3/S2）", async () => {
    const store = new MemoryStore();
    let args = ["-e", "process.exit(0)"];
    const authority = createWorkspaceMcpTrust({
      workingDirectory: "/ws",
      discovery: {
        discover: async () => ({
          probe: { config: stdioConfig({ args }), sourcePaths: ["/ws/zcode.json"] },
        }),
      },
      store,
      now: () => new Date("2026-11-07T00:00:00.000Z"),
    });
    const staleDigest = (await authority.inspect()).probe!.declarationDigest;
    args = ["-e", "process.exit(1)"]; // 审核期间声明被改（args 预置进摘要）
    await expect(authority.decide("probe", staleDigest, true)).rejects.toThrow(
      "workspace_mcp_declaration_changed",
    );
    expect(store.records).toHaveLength(0);
  });

  it("并发 decide 不同 workspace 记录不丢失（锁内读改写，A3）", async () => {
    const store = new MemoryStore();
    const a = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/wsA/zcode.json"] } },
      store,
      workingDirectory: "/wsA",
    });
    const b = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/wsB/zcode.json"] } },
      store,
      workingDirectory: "/wsB",
    });
    const digestA = (await a.inspect()).probe!.declarationDigest;
    const digestB = (await b.inspect()).probe!.declarationDigest;
    await Promise.all([a.decide("probe", digestA, true), b.decide("probe", digestB, true)]);
    expect(store.records).toHaveLength(2);
    expect(store.lockCount).toBe(2);
  });

  it("损坏 store：inspect 全部 pending、allows 拒绝、decide 拒绝落盘（A4 default-deny）", async () => {
    const store = new MemoryStore();
    store.failRead = true;
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    const digest = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: "/ws",
      workingDirectory: "/ws",
      serverName: "probe",
      sourcePaths: ["/ws/zcode.json"],
      config: stdioConfig(),
    });
    expect((await authority.inspect()).probe?.trusted).toBe(false);
    await expect(authority.allows("probe", stdioConfig())).resolves.toBe(false);
    await expect(authority.decide("probe", digest, true)).rejects.toThrow("store unreadable");
  });

  it("跨 workspaceIdentity 不继承授权（A5）", async () => {
    const store = new MemoryStore();
    const wsA = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/wsA/zcode.json"] } },
      store,
      workingDirectory: "/wsA",
    });
    await wsA.decide("probe", (await wsA.inspect()).probe!.declarationDigest, true);
    // 同 serverName、不同身份（不同目录）的另一个工作区必须重新审核。
    const wsB = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/wsB/zcode.json"] } },
      store,
      workingDirectory: "/wsB",
    });
    expect((await wsB.inspect()).probe?.trusted).toBe(false);
    await expect(wsB.allows("probe", stdioConfig({ cwd: "/wsB" }))).resolves.toBe(false);
  });

  it("来源豁免：plugin/builtin 与无 workspace 声明的 server 不被拦截（A6）", async () => {
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    await expect(
      authority.allows("probe", { ...stdioConfig(), source: { kind: "plugin" } }),
    ).resolves.toBe(true);
    await expect(
      authority.allows("probe", { ...stdioConfig(), source: { kind: "builtin" } }),
    ).resolves.toBe(true);
    // 用户作用域（无 workspace 声明条目）保持既有准入语义。
    await expect(authority.allows("personal", stdioConfig())).resolves.toBe(true);
  });

  it("allows 重验：配置 args 与声明不一致（摘要失配）时拒绝新连接（S2）", async () => {
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    await authority.decide("probe", (await authority.inspect()).probe!.declarationDigest, true);
    await expect(authority.allows("probe", stdioConfig())).resolves.toBe(true);
    await expect(
      authority.allows("probe", stdioConfig({ args: ["-e", "process.exit(1)"] })),
    ).resolves.toBe(false);
    // 声明整体停用（enabled=false）时拒绝连接（disabled 优先，spec §2.3）。
    const disabled = createAuthority({
      declarations: {
        probe: { config: stdioConfig({ enabled: false }), sourcePaths: ["/ws/zcode.json"] },
      },
      store: new MemoryStore(),
    });
    await expect(disabled.allows("probe", stdioConfig())).resolves.toBe(false);
    expect((await disabled.inspect()).probe?.configuredEnabled).toBe(false);
  });
});

describe("digest：args 预置与稳定性（spec §2.1/§5.2，S2）", () => {
  const base = {
    workspaceIdentity: "/ws",
    workingDirectory: "/ws",
    serverName: "probe",
    sourcePaths: ["/ws/zcode.json"],
  };

  it("args/env/cwd/url/headers 任一变更都改变摘要；enabled/source 不进摘要", () => {
    const digestOf = (config: McpServerConfig) =>
      computeWorkspaceMcpDeclarationDigest({ ...base, config });
    const original = digestOf(stdioConfig());
    expect(digestOf(stdioConfig({ args: ["-e", "process.exit(1)"] }))).not.toBe(original);
    expect(digestOf(stdioConfig({ env: { TOKEN: "v" } }))).not.toBe(original);
    expect(digestOf(stdioConfig({ cwd: "/ws/sub" }))).not.toBe(original);
    // enabled 与 source 不是执行身份：不扩大也不清除授权。
    expect(digestOf(stdioConfig({ enabled: false }))).toBe(original);
    expect(digestOf({ ...stdioConfig(), source: { kind: "builtin" } })).toBe(original);
    const http: McpServerConfig = {
      type: "http",
      url: "https://mcp.example/a",
      headers: { authorization: "Bearer x" },
    };
    const httpOriginal = digestOf(http);
    expect(digestOf({ ...http, url: "https://mcp.example/b" })).not.toBe(httpOriginal);
    expect(digestOf({ ...http, headers: { authorization: "Bearer y" } })).not.toBe(httpOriginal);
    expect(
      digestOf({
        ...http,
        oauth: { type: "client_credentials", clientId: "c", clientSecret: "s" },
      }),
    ).not.toBe(httpOriginal);
  });

  it("Windows cmd /c 拆包进摘要：外壳与内核命令是同一执行身份（S2 评审补充，上游 a60ba6a7）", () => {
    // fork（F23③ 安全评审）：锁定 normalizeWorkspaceMcpStdioCommand 的 win32 拆包
    // 语义——授权必须绑定内核命令（cmd /c 只是外壳，不构成安全边界），防止
    // 「批准 cmd /c npx、执行 npx」或反向被误判为两种声明。
    const digestOf = (config: McpServerConfig) =>
      computeWorkspaceMcpDeclarationDigest({ ...base, config });
    const originalPlatform = process.platform;
    let navigatorPlatformDescriptor: PropertyDescriptor | undefined;
    const navigatorLike = globalThis.navigator as { platform?: string } | undefined;
    if (navigatorLike) {
      navigatorPlatformDescriptor = Object.getOwnPropertyDescriptor(navigatorLike, "platform");
    }
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      if (navigatorLike && navigatorPlatformDescriptor) {
        Object.defineProperty(navigatorLike, "platform", {
          value: "MacIntel",
          configurable: true,
        });
      }
      const wrapped = digestOf({
        type: "stdio",
        command: "cmd.exe",
        args: ["/c", "npx", "-y", "some-mcp"],
      });
      const kernel = digestOf({
        type: "stdio",
        command: "npx",
        args: ["-y", "some-mcp"],
      });
      // 同一执行身份：批准外壳 = 批准内核（display 同样展示内核命令行）。
      expect(wrapped).toBe(kernel);
      // 拆包后内核参数仍全部参与摘要（args 预置不因拆包丢失）。
      expect(digestOf({ type: "stdio", command: "npx", args: ["-y", "other-mcp"] })).not.toBe(
        kernel,
      );
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      if (navigatorLike && navigatorPlatformDescriptor) {
        Object.defineProperty(navigatorLike, navigatorPlatformDescriptor);
      }
    }
  });

  it("键序不同的同语义配置摘要一致；sourcePaths/身份参与摘要", () => {
    const a = stdioConfig({ env: { A: "1", B: "2" } });
    const b: McpServerConfig = {
      type: "stdio",
      env: { B: "2", A: "1" },
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    };
    expect(computeWorkspaceMcpDeclarationDigest({ ...base, config: b })).toBe(
      computeWorkspaceMcpDeclarationDigest({ ...base, config: a }),
    );
    expect(
      computeWorkspaceMcpDeclarationDigest({ ...base, sourcePaths: ["/ws/other.json"], config: a }),
    ).not.toBe(computeWorkspaceMcpDeclarationDigest({ ...base, config: a }));
    expect(
      computeWorkspaceMcpDeclarationDigest({ ...base, serverName: "other", config: a }),
    ).not.toBe(computeWorkspaceMcpDeclarationDigest({ ...base, config: a }));
  });
});

describe("guard：准入包住整个 lease（spec §7.2）", () => {
  it("未信任 workspace 声明拒连：pending_trust、零工具、不触碰 raw port（S1）", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    const guarded = authority.guard(fake.port);
    const result = await guarded.connectConfiguredServers({
      probe: stdioConfig(),
      // personal 不在 discovery 声明中：用户作用域保持既有准入（A6）。
      personal: stdioConfig(),
    });
    expect(result.statuses.probe?.status).toBe("pending_trust");
    expect(result.statuses.probe?.toolCount).toBe(0);
    expect(result.statuses.personal?.status).toBe("connected");
    expect(result.tools.map((tool) => tool.serverName)).toEqual(["personal"]);
    expect(fake.calls).not.toContain("connect:probe");
    expect(fake.calls).toContain("connect:personal");
    expect((await guarded.status()).probe?.status).toBe("pending_trust");
    expect((await guarded.listTools()).map((tool) => tool.serverName)).toEqual(["personal"]);
    await expect(guarded.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
    // enabled=false 的连接请求返回 disabled（disabled 优先于待信任）。
    const disabledStatus = await guarded.connectServer("probe", stdioConfig({ enabled: false }));
    expect(disabledStatus.status).toBe("disabled");
  });

  it("反例（旧行为）：未经 guard 的 raw port 直接连接同一声明并暴露工具", async () => {
    const fake = createFakePort();
    const result = await fake.port.connectConfiguredServers({ probe: stdioConfig() });
    // 这是 fork 旧世界（workspace MCP 开箱即用）的行为基线：连接成功、工具可见。
    expect(result.statuses.probe?.status).toBe("connected");
    expect(result.tools.map((tool) => tool.serverName)).toEqual(["probe"]);
  });

  it("信任后连接准入通过；同输入重复连接稳定（幂等）", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    await authority.decide("probe", (await authority.inspect()).probe!.declarationDigest, true);
    const guarded = authority.guard(fake.port);
    const first = await guarded.connectConfiguredServers({ probe: stdioConfig() });
    expect(first.statuses.probe?.status).toBe("connected");
    const second = await guarded.connectConfiguredServers({ probe: stdioConfig() });
    expect(second.statuses.probe?.status).toBe("connected");
    await expect(guarded.pingServer("probe")).resolves.toBe(true);
  });

  it("撤销：会话内复用内存准入，新 guard（新会话）与显式断开立即拒绝（A1）", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    await authority.decide("probe", (await authority.inspect()).probe!.declarationDigest, true);
    const session = authority.guard(fake.port);
    await session.connectConfiguredServers({ probe: stdioConfig() });
    // 撤销作用于未来：授权变化允许延迟到下一次连接准入（spec §3.2 规则 6）。
    await authority.decide(
      "probe",
      computeWorkspaceMcpDeclarationDigest({
        workspaceIdentity: "/ws",
        workingDirectory: "/ws",
        serverName: "probe",
        sourcePaths: ["/ws/zcode.json"],
        config: stdioConfig(),
      }),
      false,
    );
    await expect(
      session.callTool({ serverName: "probe", toolName: "probe" }),
    ).resolves.toMatchObject({ content: [{ text: "ok:probe" }] });
    // 新建/重启会话：新 guard 的连接准入被拒。
    const restarted = authority.guard(fake.port);
    const result = await restarted.connectConfiguredServers({ probe: stdioConfig() });
    expect(result.statuses.probe?.status).toBe("pending_trust");
    expect(result.tools).toHaveLength(0);
    // 显式断开后本会话也立即拒绝（不回滚已提交副作用，只阻断后续使用）。
    await session.disconnectServer("probe");
    await expect(session.callTool({ serverName: "probe", toolName: "probe" })).rejects.toThrow(
      "workspace_mcp_pending_trust",
    );
  });

  it("连接使用审核时的私有副本：调用方改原对象不改变准入（A7 竞态防线）", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    await authority.decide("probe", (await authority.inspect()).probe!.declarationDigest, true);
    const guarded = authority.guard(fake.port);
    const config = stdioConfig();
    const connectPromise = guarded.connectServer("probe", config);
    config.args = ["-e", "process.exit(1)"]; // 审核后篡改原对象
    expect((await connectPromise).status).toBe("connected");
    await expect(
      guarded.callTool({ serverName: "probe", toolName: "probe" }),
    ).resolves.toMatchObject({});
  });

  it("close/AbortSignal 只失效本 gate，不重复关闭共享 raw port；订阅释放不受授权拦截", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    const controller = new AbortController();
    const guarded = authority.guard(fake.port, controller.signal);
    controller.abort();
    await expect(guarded.connectServer("probe", stdioConfig())).rejects.toThrow(
      "MCP port is closed",
    );
    // 订阅释放直接透传（MCP App 生命周期收尾不被授权失败卡死）。
    await expect(guarded.unsubscribeResourcesBySubscriber?.("subscriber:1")).resolves.toBe(0);
    expect(fake.calls).not.toContain("close");

    const closed = authority.guard(fake.port);
    await closed.close();
    expect(fake.calls).toContain("close");
  });

  it("appConnectionSnapshot/waitForAppConnection 对 blocked server 返回 null", async () => {
    const fake = createFakePort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
    });
    const guarded = authority.guard(fake.port);
    await guarded.connectConfiguredServers({ probe: stdioConfig() });
    expect(guarded.appConnectionSnapshot?.("probe")).toBeNull();
    await expect(guarded.waitForAppConnection?.("probe")).resolves.toBeNull();
  });
});

describe("admission 事件（spec §6 条目 7/§7.2 refresh 面）", () => {
  it("首次无待审不发事件；出现待审、清零按序发布且内容去重（A7 串行发布）", async () => {
    // 首发规则：从未发布过且无待审项时不发事件（旧快照默认 null，无需清零）。
    const emptyStore = new MemoryStore();
    const emptyEvents: WorkspaceMcpAdmissionUpdatedPayload[] = [];
    const emptyAuthority = createAuthority({
      declarations: {},
      store: emptyStore,
      onAdmissionChanged: async (state) => {
        emptyEvents.push(state);
      },
    });
    await emptyAuthority.guard(createFakePort().port).refreshWorkspaceTrustAdmission();
    expect(emptyEvents).toHaveLength(0);

    const store = new MemoryStore();
    const events: WorkspaceMcpAdmissionUpdatedPayload[] = [];
    const authority = createAuthority({
      declarations: { probe: { config: stdioConfig(), sourcePaths: ["/ws/zcode.json"] } },
      store,
      onAdmissionChanged: async (state) => {
        events.push(state);
      },
    });
    const guarded = authority.guard(createFakePort().port);
    const digest = (await authority.inspect()).probe!.declarationDigest;
    // 首次发布：pending=1，bundleDigest 为有序集合摘要。
    await guarded.refreshWorkspaceTrustAdmission();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      pendingCount: 1,
      bundleDigest: computeWorkspaceMcpAdmissionBundleDigest([["probe", digest]]),
      workspaceIdentity: "/ws",
    });
    // 相同状态重复 refresh：去重，不重复发布。
    await guarded.refreshWorkspaceTrustAdmission();
    expect(events).toHaveLength(1);
    // 授权后清零：发布 pending=0。
    await authority.decide("probe", digest, true);
    await guarded.refreshWorkspaceTrustAdmission();
    expect(events).toHaveLength(2);
    expect(events[1]?.pendingCount).toBe(0);
  });
});

describe("display 脱敏（spec §3.1 规则 3，A10）", () => {
  it("stdio 只展示命令行、cwd 与 env 键名；http/sse 剥离 URL 凭据与 header 值", () => {
    const stdio = buildWorkspaceMcpTrustDisplay(
      stdioConfig({ env: { TOKEN: "super-secret", PATH_INFO: "x" }, cwd: "/ws" }),
      "/ws",
    );
    expect(stdio).toContain("PATH_INFO");
    expect(stdio).not.toContain("super-secret");
    const http = buildWorkspaceMcpTrustDisplay(
      {
        type: "http",
        url: "https://user:pass@mcp.example/a?token=secret#frag",
        headers: { authorization: "Bearer abc" },
        oauth: { type: "client_credentials", clientId: "cid", clientSecret: "cs" },
      } satisfies McpServerConfig,
      "/ws",
    );
    expect(http).toContain("https://mcp.example/a");
    expect(http).not.toContain("user:pass");
    expect(http).not.toContain("token=secret");
    expect(http).toContain("authorization");
    expect(http).not.toContain("Bearer abc");
    expect(http).toContain("client_credentials");
    expect(http).not.toContain("clientSecret");
  });
});

describe("S1 真实进程探针：未信任零 spawn", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zody-mcp-trust-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** 真实 spawn 的最小 port：连接即启动子进程并让子进程写 marker 文件。 */
  function createSpawningPort() {
    const spawned: string[] = [];
    const connectServer = async (
      name: string,
      config: McpServerConfig,
    ): Promise<McpServerStatus> => {
      if (config.type !== "stdio") throw new Error("test port supports stdio only");
      const marker = join(dir, `${name}.started`);
      const child = spawn(config.command, [...(config.args ?? [])], {
        cwd: config.cwd,
        env: { ...config.env, __ZODY_TRUST_TEST_MARKER: marker },
        stdio: "ignore",
      });
      child.unref();
      spawned.push(name);
      return {
        status: "connected",
        transport: "stdio",
        toolCount: 1,
        updatedAt: "2026-11-07T00:00:00.000Z",
      };
    };
    const port: McpPort = {
      connectServer,
      async connectConfiguredServers(servers) {
        const statuses: Record<string, McpServerStatus> = {};
        for (const [name, config] of Object.entries(servers)) {
          statuses[name] = await connectServer(name, config);
        }
        return {
          statuses,
          tools: spawned.map((serverName) => ({
            serverName,
            toolName: "probe",
            name: "probe",
            inputSchema: { type: "object" },
          })) as McpToolDescriptor[],
        };
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
      async callTool() {
        throw new Error("not connected");
      },
      async close() {},
    };
    return { port, spawned };
  }

  const markerServerConfig = (): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(process.env.__ZODY_TRUST_TEST_MARKER, "started")`,
    ],
    env: {},
  });

  it("未信任声明经 guard 连接：子进程从未启动（marker 不出现）", async () => {
    const { port, spawned } = createSpawningPort();
    const store = new MemoryStore();
    const authority = createAuthority({
      declarations: {
        evil: { config: markerServerConfig(), sourcePaths: ["/ws/zcode.json"] },
      },
      store,
    });
    const guarded = authority.guard(port);
    const result = await guarded.connectConfiguredServers({ evil: markerServerConfig() });
    expect(result.statuses.evil?.status).toBe("pending_trust");
    expect(result.statuses.evil?.toolCount).toBe(0);
    // 给潜在泄漏的子进程留出写 marker 的窗口。
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawned).toEqual([]);
    expect(existsSync(join(dir, "evil.started"))).toBe(false);
  });

  it("对照（旧行为）：raw port 直接连接会真实启动子进程并写 marker", async () => {
    const { port, spawned } = createSpawningPort();
    await port.connectServer("evil", markerServerConfig());
    await new Promise((resolve) => setTimeout(resolve, 300));
    // fork 旧行为基线：未加信任门时 workspace 声明被直接执行。
    expect(spawned).toEqual(["evil"]);
    expect(existsSync(join(dir, "evil.started"))).toBe(true);
  });
});
