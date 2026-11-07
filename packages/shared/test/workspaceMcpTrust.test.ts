import { describe, expect, it } from "vitest";
import { zodyProtocolMethods } from "../src/zody-protocol/index.js";
import {
  zodyMcpServerStatusKindSchema,
  zodyMcpServerStatusSnapshotSchema,
  zodyWorkspaceMcpTrustParamsSchema,
  zodyWorkspaceMcpTrustResultSchema,
} from "../src/zody-protocol/index.js";
import { conversationSnapshotSchema } from "../src/zody-protocol-v4/snapshot.js";
import { statePatchSchema } from "../src/zody-protocol-v4/delta.js";
import {
  parseWorkspaceMcpTrustStoreContent,
  workspaceMcpTrustStoreFileSchema,
} from "../src/workspace-mcp-trust-store-file.js";

// F23（上游 a60ba6a7）：workspace MCP 信任门协议与 store schema 契约测试。
// spec：docs/specs/workspace-mcp-trust.md §6（协议面）与 §2.2（store 单源）。

const DIGEST = "a".repeat(64);

describe("workspace/mcp/trust 协议 schema", () => {
  it("pending_trust 是合法状态枚举值（裁决 2 new-state，不占用 untrusted 槽位）", () => {
    expect(zodyMcpServerStatusKindSchema.parse("pending_trust")).toBe("pending_trust");
    // untrusted 槽位保留不动（历史语义属于官方 origin 信任校验）。
    expect(zodyMcpServerStatusKindSchema.parse("untrusted")).toBe("untrusted");
    expect(zodyMcpServerStatusKindSchema.safeParse("pending").success).toBe(false);
  });

  it("状态快照携带 workspaceTrust 审核摘要；缺省不受影响", () => {
    const base = {
      status: "pending_trust",
      transport: "stdio",
      toolCount: 0,
      updatedAt: "2026-11-07T00:00:00.000Z",
    };
    const withReview = zodyMcpServerStatusSnapshotSchema.parse({
      ...base,
      workspaceTrust: {
        declarationDigest: DIGEST,
        sourcePaths: ["/ws/.zody/config.json"],
        display: "{}",
        trusted: false,
        configuredEnabled: true,
        transport: "stdio",
      },
    });
    expect(withReview.workspaceTrust?.declarationDigest).toBe(DIGEST);
    expect(zodyMcpServerStatusSnapshotSchema.parse(base).workspaceTrust).toBeUndefined();
    // strict：多余字段拒绝，防止发送端夹带未审计内容。
    expect(
      zodyMcpServerStatusSnapshotSchema.safeParse({
        ...base,
        workspaceTrust: { declarationDigest: "not-a-digest" },
      }).success,
    ).toBe(false);
  });

  it("workspace/mcp/trust 方法注册与 params/result 校验", () => {
    expect(zodyProtocolMethods.workspaceMcpTrust).toBe("workspace/mcp/trust");
    const workspace = { workspaceKey: "/ws", workspacePath: "/ws" };
    expect(
      zodyWorkspaceMcpTrustParamsSchema.parse({
        workspace,
        serverName: "probe",
        declarationDigest: DIGEST,
        trusted: true,
      }),
    ).toEqual({ workspace, serverName: "probe", declarationDigest: DIGEST, trusted: true });
    // 非法摘要与多余字段都必须拒绝（运行时校验 fail-closed）。
    expect(
      zodyWorkspaceMcpTrustParamsSchema.safeParse({
        workspace,
        serverName: "probe",
        declarationDigest: "zzz",
        trusted: true,
      }).success,
    ).toBe(false);
    expect(
      zodyWorkspaceMcpTrustResultSchema.parse({
        accepted: false,
        reasonCode: "workspace_mcp_declaration_changed",
      }),
    ).toEqual({ accepted: false, reasonCode: "workspace_mcp_declaration_changed" });
    expect(
      zodyWorkspaceMcpTrustResultSchema.safeParse({
        accepted: false,
        reasonCode: "unknown_reason",
      }).success,
    ).toBe(false);
  });
});

describe("workspace MCP trust store 文件 schema（单源，fail-closed）", () => {
  const record = {
    workspaceIdentity: "/ws",
    serverName: "probe",
    declarationDigest: DIGEST,
    grantedAt: "2026-11-07T00:00:00.000Z",
  };

  it("合法文件解析成功", () => {
    const content = JSON.stringify({ schemaVersion: 1, records: [record] });
    const parsed = parseWorkspaceMcpTrustStoreContent(content);
    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok") expect(parsed.file.records).toHaveLength(1);
  });

  it("JSON 语法错误与 schema 失败统一 invalid，不返回部分结果", () => {
    expect(parseWorkspaceMcpTrustStoreContent("{not json").status).toBe("invalid");
    expect(
      parseWorkspaceMcpTrustStoreContent(
        JSON.stringify({ schemaVersion: 1, records: [{ ...record, declarationDigest: "x" }] }),
      ).status,
    ).toBe("invalid");
    expect(
      parseWorkspaceMcpTrustStoreContent(JSON.stringify({ schemaVersion: 2, records: [record] }))
        .status,
    ).toBe("invalid");
    expect(
      parseWorkspaceMcpTrustStoreContent(
        JSON.stringify({ schemaVersion: 1, records: [{ ...record, extra: 1 }] }),
      ).status,
    ).toBe("invalid");
  });

  it("同 workspaceIdentity + serverName 的重复记录拒绝（记录键唯一）", () => {
    expect(
      workspaceMcpTrustStoreFileSchema.safeParse({
        schemaVersion: 1,
        records: [record, { ...record, declarationDigest: "b".repeat(64) }],
      }).success,
    ).toBe(false);
    // 不同 workspace 或不同 server 不算重复。
    expect(
      workspaceMcpTrustStoreFileSchema.safeParse({
        schemaVersion: 1,
        records: [record, { ...record, workspaceIdentity: "/other" }],
      }).success,
    ).toBe(true);
  });
});

describe("v4 snapshot/delta workspaceMcpAdmission（additive + default null）", () => {
  function baseSnapshot() {
    return {
      protocolVersion: 1,
      sessionId: "session-1",
      logEpoch: "epoch-1",
      seq: 1,
      revision: 1,
      control: {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [{ kind: "primaryTurn", startedAt: 1 }],
        lastError: null,
        apiRetry: null,
      },
      availability: {
        fork: { allowed: true },
        compact: { allowed: true },
        switchModelConfig: { allowed: true },
        setFollowupMode: { allowed: true },
        queueEdit: { allowed: true },
        sendQueuedNow: { allowed: true },
        pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
        resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
      },
      inputRouting: { mode: "enqueue" },
      meta: { title: "workspace", titleSource: "custom" },
      config: {
        provider: "glm",
        model: "glm-5",
        thought: "medium",
        thoughtLevels: [],
        followupMode: "queue",
        mode: "build",
      },
      modelTransition: null,
      usage: {
        contextWindow: { usedTokens: 0, maxTokens: 200_000, autoCompactThresholdTokens: null },
        cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      queue: { items: [], autoDrain: true },
      pendingInteractions: [],
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      rows: { window: [], totalCount: 0, firstRowId: null },
    };
  }

  it("旧快照（无 workspaceMcpAdmission 字段）解析得 null", () => {
    const parsed = conversationSnapshotSchema.parse(baseSnapshot());
    expect(parsed.workspaceMcpAdmission).toBeNull();
  });

  it("携带 workspaceMcpAdmission 解析通过；非法 bundleDigest 拒绝", () => {
    const parsed = conversationSnapshotSchema.parse({
      ...baseSnapshot(),
      workspaceMcpAdmission: {
        pendingCount: 2,
        bundleDigest: DIGEST,
        workspaceIdentity: "/ws",
      },
    });
    expect(parsed.workspaceMcpAdmission?.pendingCount).toBe(2);
    expect(
      conversationSnapshotSchema.safeParse({
        ...baseSnapshot(),
        workspaceMcpAdmission: { pendingCount: 1, bundleDigest: "not-sha" },
      }).success,
    ).toBe(false);
  });

  it("StatePatch 支持可选 workspaceMcpAdmission（null = 清零）", () => {
    expect(
      statePatchSchema.parse({ workspaceMcpAdmission: null }).workspaceMcpAdmission,
    ).toBeNull();
    expect(
      statePatchSchema.parse({ workspaceMcpAdmission: { pendingCount: 1, bundleDigest: DIGEST } })
        .workspaceMcpAdmission?.pendingCount,
    ).toBe(1);
    expect(statePatchSchema.parse({}).workspaceMcpAdmission).toBeUndefined();
  });
});
