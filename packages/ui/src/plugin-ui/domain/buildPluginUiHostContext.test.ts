import { MCP_APPS_HOST_NAME, buildMcpAppsWidgetStateContextEntries } from "@zody/shared/mcp-apps";
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

  // R52：hostContext 初值的两种表示来自同一份宿主快照（控制器按此组合下发），
  // 基础构造本身不预先写任何 widgetState 键，避免出现第二条投影路径。
  it("composes the widget state initial value as one snapshot under both registered keys", () => {
    const base = buildPluginUiHostContext({
      theme: "dark",
      locale: "zh-CN",
      displayMode: "inline",
      width: 480,
      timeZone: "Asia/Shanghai",
    });
    const state = Object.freeze({ draft: "hello" });
    const context = { ...base, ...buildMcpAppsWidgetStateContextEntries(state) };
    expect(context["zody/widgetState"]).toBe(state);
    expect(context["zcode/widgetState"]).toBe(state);
    expect(context.theme).toBe("dark");
    expect(base).not.toHaveProperty("zody/widgetState");
    expect(base).not.toHaveProperty("zcode/widgetState");
  });
});
