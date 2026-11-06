import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@zody/rpc";
import { describe, expect, it } from "vitest";
import { ZODY_AGENT_PROVIDER_NOT_READY_CODE } from "@zody/shared";
import { ZODY_AGENT_RUNTIME_UNAVAILABLE_CODE } from "#src/zody-agent/zodyAgent.js";
import { IZodyAgentService } from "#src/zody-agent/zodyAgent.js";
import {
  ZODY_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZodyAgentMcpStatusModeUnsupportedError,
  isZodyAgentMcpStatusModeUnsupportedError,
} from "#src/zody-agent/zodyAgentErrors.js";

describe("ZCode Agent RPC errors", () => {
  it("uses the current unsupported code without recognizing the old live code", () => {
    expect(new ZodyAgentMcpStatusModeUnsupportedError().code).toBe(
      "ZODY_AGENT_MCP_STATUS_MODE_UNSUPPORTED",
    );
    expect(
      isZodyAgentMcpStatusModeUnsupportedError({ code: "ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED" }),
    ).toBe(false);
  });

  it.each([
    [ZODY_AGENT_PROVIDER_NOT_READY_CODE, "ZODY_AGENT_PROVIDER_NOT_READY"],
    [ZODY_AGENT_RUNTIME_UNAVAILABLE_CODE, "ZODY_AGENT_RUNTIME_UNAVAILABLE"],
    ["ZCODE_AGENT_PROVIDER_NOT_READY", "ZCODE_AGENT_PROVIDER_NOT_READY"],
  ])(
    "passes code %s and reason through a real channel without aliasing",
    async (code, expected) => {
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "test");
      const client = new ChannelClient(clientProtocol);
      server.registerChannel(
        "errors",
        ProxyChannel.fromService({
          async fail() {
            throw Object.assign(new Error("failure"), {
              code,
              data: { reason: "provider_not_ready" },
            });
          },
        }),
      );
      const service = ProxyChannel.toService<{ fail(): Promise<void> }>(
        client.getChannel("errors"),
      );
      try {
        await expect(service.fail()).rejects.toMatchObject({
          code: expected,
          data: { reason: "provider_not_ready" },
        });
      } finally {
        client.dispose();
        server.dispose();
      }
    },
  );

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
