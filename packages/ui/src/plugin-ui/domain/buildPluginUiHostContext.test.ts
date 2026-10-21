import { MCP_APPS_HOST_NAME } from "@zcode/shared/mcp-apps";
import { describe, expect, it } from "vitest";
import { buildPluginUiHostContext } from "./buildPluginUiHostContext.js";

describe("MCP Apps host identity", () => {
  it("uses the Zody product identity for host name and hostContext userAgent", () => {
    expect(MCP_APPS_HOST_NAME).toBe("zody");
    const context = buildPluginUiHostContext({
      theme: "light",
      locale: "en-US",
      displayMode: "inline",
      width: 320,
      timeZone: "UTC",
    });
    expect(context.userAgent).toBe("zody");
  });
});
