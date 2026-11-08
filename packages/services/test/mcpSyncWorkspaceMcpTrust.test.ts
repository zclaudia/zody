// fork（F23④，上游 a60ba6a7）：mcp-sync setWorkspaceMcpTrust 转发的 services 侧测试
// （spec docs/specs/workspace-mcp-trust.md §6/§11）。UI 注入接缝
// WorkspaceMcpTrustService（packages/ui/src/settings/workspaceMcpTrustActions.ts）经
// IMcpSyncService.setWorkspaceMcpTrust → zodyAgentService.setWorkspaceMcpTrust →
// 协议 workspace/mcp/trust 到达 Agent。反例形态：接线前 IMcpSyncService 无该方法
// （编译期失败）；未注入执行面的构造必须显式拒绝而不是静默成功。
import { describe, expect, it, vi } from "vitest";
import type { ZodyWorkspaceMcpTrustResult } from "@zody/shared";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

describe("mcpSyncService.setWorkspaceMcpTrust", () => {
  it("forwards trust decisions to the injected agent executor unchanged", async () => {
    const setWorkspaceMcpTrust = vi.fn(
      async (): Promise<ZodyWorkspaceMcpTrustResult> => ({
        accepted: true,
      }),
    );
    const service = createMcpSyncService({ setWorkspaceMcpTrust });
    const params = {
      workspacePath: "/tmp/workspace",
      workspaceIdentity: "local:/tmp/workspace",
      serverName: "gated",
      declarationDigest: "a".repeat(64),
      trusted: true,
    };
    await expect(service.setWorkspaceMcpTrust(params)).resolves.toEqual({ accepted: true });
    expect(setWorkspaceMcpTrust).toHaveBeenCalledOnce();
    expect(setWorkspaceMcpTrust).toHaveBeenCalledWith(params);
  });

  it("rejects explicitly when the runtime has no agent executor (remote read-only face)", async () => {
    const service = createMcpSyncService({});
    await expect(
      service.setWorkspaceMcpTrust({
        workspacePath: "/tmp/workspace",
        serverName: "gated",
        declarationDigest: "a".repeat(64),
        trusted: false,
      }),
    ).rejects.toThrow(/unavailable/i);
  });
});
