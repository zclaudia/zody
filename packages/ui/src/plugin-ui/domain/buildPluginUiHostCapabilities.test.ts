import { describe, expect, it } from "vitest";
import {
  buildPluginUiHostCapabilities,
  type PluginUiHostCapabilityInput,
} from "./buildPluginUiHostCapabilities.js";

const allCapabilities: PluginUiHostCapabilityInput = {
  canSample: true,
  canSendFollowUpMessage: true,
  canUpdateModelContext: true,
  canSetWidgetState: true,
  canSubscribeResources: true,
  canDownloadFile: true,
  surfaceId: "panel-1",
};

describe("MCP Apps host capabilities 双宣告（R52）", () => {
  it("每个可用扩展能力同时宣告 canonical 与 legacy 两键（4×2），surface 两键引用同一对象", () => {
    const capabilities = buildPluginUiHostCapabilities(allCapabilities);
    const experimental = capabilities.experimental as Record<string, unknown>;
    expect(Object.keys(experimental).sort()).toEqual(
      [
        "zcode/csp",
        "zcode/resourceSubscribe",
        "zcode/surface",
        "zcode/widgetState",
        "zody/csp",
        "zody/resourceSubscribe",
        "zody/surface",
        "zody/widgetState",
      ].sort(),
    );
    expect(experimental["zody/widgetState"]).toBe(experimental["zcode/widgetState"]);
    expect(experimental["zody/resourceSubscribe"]).toBe(experimental["zcode/resourceSubscribe"]);
    expect(experimental["zody/surface"]).toBe(experimental["zcode/surface"]);
    expect(experimental["zody/surface"]).toEqual({ id: "panel-1" });
    expect(experimental["zody/csp"]).toEqual({ flags: ["unsafeEval", "wasmUnsafeEval"] });
  });

  it("不可用的能力成对缺席，只保留 csp 双键", () => {
    const capabilities = buildPluginUiHostCapabilities({
      canSendFollowUpMessage: false,
      canUpdateModelContext: false,
      canSetWidgetState: false,
      canSubscribeResources: false,
      canDownloadFile: false,
    });
    expect(Object.keys(capabilities.experimental ?? {}).sort()).toEqual(["zcode/csp", "zody/csp"]);
    expect(capabilities.serverResources).toEqual({});
    expect(capabilities).not.toHaveProperty("message");
    expect(capabilities).not.toHaveProperty("downloadFile");
  });

  it("仅面板实例宣告 surface 对；标准能力位保持既有形状", () => {
    const capabilities = buildPluginUiHostCapabilities({
      canSendFollowUpMessage: true,
      canUpdateModelContext: false,
      canSetWidgetState: false,
      canSubscribeResources: true,
      canDownloadFile: false,
      surfaceId: "panel-2",
    });
    expect(Object.keys(capabilities.experimental ?? {}).sort()).toEqual([
      "zcode/csp",
      "zcode/resourceSubscribe",
      "zcode/surface",
      "zody/csp",
      "zody/resourceSubscribe",
      "zody/surface",
    ]);
    expect(capabilities.serverResources).toEqual({ listChanged: true });
    expect(capabilities.message).toEqual({ text: {}, image: {} });
    expect(capabilities).not.toHaveProperty("updateModelContext");
  });
});
