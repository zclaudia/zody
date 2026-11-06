import { describe, expect, it } from "vitest";
import type { PluginUiPresentation } from "../contract.js";
import { buildPluginUiToolResult } from "./pluginUiToolFeed.js";

const presentation = (patch: Partial<PluginUiPresentation> = {}): PluginUiPresentation => ({
  serverName: "server",
  pluginId: "plugin",
  resourceUri: "ui://app",
  ...patch,
});
const toolCall = { status: "completed", input: {}, output: "ok" };

describe("MCP Apps tool-result 出站 _meta（R52）", () => {
  // R52：同一份规范值产生登记的两种表示，两个键必须引用同一对象（禁止两次独立序列化产生分叉）。
  it("超限结果同时写 canonical 与 legacy 两种表示，且引用同一对象", () => {
    const result = buildPluginUiToolResult(
      toolCall,
      presentation({ truncated: true, truncatedBytes: 2048 }),
    );
    const meta = result?._meta as Record<string, unknown>;
    expect(meta["zody/truncated"]).toEqual({ bytes: 2048 });
    expect(meta["zcode/truncated"]).toBe(meta["zody/truncated"]);
  });

  it("缺省字节数按 0 记录，两键仍同源", () => {
    const result = buildPluginUiToolResult(toolCall, presentation({ truncated: true }));
    const meta = result?._meta as Record<string, unknown>;
    expect(meta["zody/truncated"]).toEqual({ bytes: 0 });
    expect(meta["zcode/truncated"]).toBe(meta["zody/truncated"]);
  });

  it("与 widgetMeta 合并时保留既有键，不因双表示覆盖其他元数据", () => {
    const result = buildPluginUiToolResult(
      toolCall,
      presentation({
        widgetMeta: JSON.stringify({ "ui/other": 1, "openai/outputTemplate": "ui://app" }),
        truncated: true,
        truncatedBytes: 7,
      }),
    );
    const meta = result?._meta as Record<string, unknown>;
    expect(meta["ui/other"]).toBe(1);
    expect(meta["openai/outputTemplate"]).toBe("ui://app");
    expect(meta["zody/truncated"]).toBe(meta["zcode/truncated"]);
  });

  it("未超限且没有 baseMeta 时不产空 _meta 对象", () => {
    const result = buildPluginUiToolResult(toolCall, presentation());
    expect(result).toBeDefined();
    expect(result).not.toHaveProperty("_meta");
  });

  it("未超限时不写入任何 truncated 表示", () => {
    const result = buildPluginUiToolResult(
      toolCall,
      presentation({ widgetMeta: JSON.stringify({ "ui/other": 1 }) }),
    );
    expect(result?._meta).toEqual({ "ui/other": 1 });
  });
});
