import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zody/rpc";
import { describe, expect, it } from "vitest";
import { IZodyAgentService } from "#src/zody-agent/zodyAgent.js";
import {
  ZODY_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZodyAgentMcpStatusModeUnsupportedError,
} from "#src/zody-agent/zodyAgentErrors.js";

describe("ZCode Agent RPC errors", () => {
  it("preserves the MCP status-only unsupported code across ChannelClient RPC", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      IZodyAgentService.channelName,
      ProxyChannel.fromService({
        async listMcpServerStatuses() {
          throw new ZodyAgentMcpStatusModeUnsupportedError();
        },
      }),
    );
    const service = ProxyChannel.toService<IZodyAgentService>(
      client.getChannel(IZodyAgentService.channelName),
    );

    try {
      await expect(
        service.listMcpServerStatuses({
          mcpServers: [],
          mode: "status",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code: ZODY_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
        name: "ZCodeAgentMcpStatusModeUnsupportedError",
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
