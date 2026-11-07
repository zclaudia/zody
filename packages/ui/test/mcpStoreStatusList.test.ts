import { describe, expect, it } from "vitest";
import type { ZodyMcpServer } from "@zody/shared";
import { mergeMcpServerStatusSnapshots } from "../src/store/mcpStoreStatusList.js";

const server: ZodyMcpServer = {
  config: { command: "node" },
  enabled: true,
  id: "zcodeagentmcp:demo",
  name: "demo",
  scope: "user",
  source: "zcodeagentmcp",
  status: "connecting",
};

describe("MCP store status diagnostics", () => {
  it("preserves structured diagnostics from the runtime snapshot", () => {
    expect(
      mergeMcpServerStatusSnapshots([server], {
        demo: {
          error: "raw english error",
          failureKind: "server_unavailable",
          serverRequestId: "req-1000",
          status: "failed",
          toolCount: 0,
          transport: "http",
          updatedAt: "2026-08-22T00:00:00.000Z",
        },
      })[0],
    ).toMatchObject({
      error: "raw english error",
      failureKind: "server_unavailable",
      serverRequestId: "req-1000",
      status: "error",
    });
  });

  it("uses status_unavailable without inventing a request id for a missing row", () => {
    expect(mergeMcpServerStatusSnapshots([server], {})[0]).toMatchObject({
      failureKind: "status_unavailable",
      status: "error",
    });
    expect(mergeMcpServerStatusSnapshots([server], {})[0]).not.toHaveProperty("serverRequestId");
  });

  it("clears stale diagnostics when a later snapshot is connected", () => {
    const failedServer: ZodyMcpServer = {
      ...server,
      error: "old error",
      failureKind: "server_unavailable",
      serverRequestId: "old-request",
      status: "error",
    };
    expect(
      mergeMcpServerStatusSnapshots([failedServer], {
        demo: {
          status: "connected",
          toolCount: 2,
          transport: "http",
          updatedAt: "2026-08-22T00:01:00.000Z",
        },
      })[0],
    ).toMatchObject({ status: "connected", toolCount: 2 });
    expect(
      mergeMcpServerStatusSnapshots([failedServer], {
        demo: {
          status: "connected",
          toolCount: 2,
          transport: "http",
          updatedAt: "2026-08-22T00:01:00.000Z",
        },
      })[0],
    ).not.toHaveProperty("serverRequestId", "old-request");
  });

  // fork（F23，上游 a60ba6a7）：workspace MCP 信任门 pending_trust（裁决 2
  // new-state 独立枚举）必须映射为带安全说明的非成功配置态，且不改动既有
  // untrusted 映射（spec docs/specs/workspace-mcp-trust.md §8.2/A9）。
  it("maps pending_trust to a non-success state without disturbing untrusted", () => {
    const rows = mergeMcpServerStatusSnapshots(
      [server, { ...server, id: "zcodeagentmcp:legacy", name: "legacy" }],
      {
        demo: {
          status: "pending_trust",
          toolCount: 0,
          transport: "stdio",
          updatedAt: "2026-11-07T00:00:00.000Z",
        },
        legacy: {
          status: "untrusted",
          toolCount: 0,
          transport: "stdio",
          updatedAt: "2026-11-07T00:00:00.000Z",
        },
      },
    );
    expect(rows[0]).toMatchObject({
      status: "unknown",
      error: "Workspace MCP server is pending trust review.",
      failureKind: "status_unavailable",
    });
    // untrusted 槽位（官方 origin 信任校验的历史语义）保持原有文案不动。
    expect(rows[1]).toMatchObject({
      status: "unknown",
      error: "Project MCP server requires explicit connection before use.",
    });
  });
});
