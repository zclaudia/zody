// cuaComposerEntryState 五层可见性门与 isCuaBuildCapability 形状守卫的纯函数测试。
// 组件/hook 不在此覆盖——组合编排在 useCuaComposerEntry，交给组件级测试验证。
import { describe, expect, it } from "vitest";
import { isCuaBuildCapability } from "../src/settings/computerUseAvailability.js";
import {
  resolveCuaComposerEntryView,
  type CuaComposerEntryInputs,
} from "../src/lib/cuaComposerEntryState.js";

function baseInputs(overrides: Partial<CuaComposerEntryInputs> = {}): CuaComposerEntryInputs {
  return {
    buildCapabilityAvailable: true,
    macLocalDesktop: true,
    windowsLocalDesktop: false,
    hiddenBySettings: false,
    permissionServiceAvailable: true,
    pluginEnabled: true,
    pluginToggling: false,
    pluginError: false,
    permissionStatus: null,
    sessionBusy: false,
    ...overrides,
  };
}

describe("resolveCuaComposerEntryView 构建门", () => {
  it("其余门全开时，占位构建整体不渲染入口", () => {
    expect(resolveCuaComposerEntryView(baseInputs({ buildCapabilityAvailable: false })).visible).toBe(
      false,
    );
  });

  it("占位构建优先级高于插件切换中：toggling 也不渲染", () => {
    const view = resolveCuaComposerEntryView(
      baseInputs({ buildCapabilityAvailable: false, pluginToggling: true }),
    );
    expect(view.visible).toBe(false);
  });

  it("即使插件被手工启用，占位构建仍不渲染", () => {
    const view = resolveCuaComposerEntryView(
      baseInputs({ buildCapabilityAvailable: false, pluginEnabled: true }),
    );
    expect(view.visible).toBe(false);
  });

  it("narrow 构建且其余门通过时入口可见（mac 中性 idle 态）", () => {
    const view = resolveCuaComposerEntryView(baseInputs());
    expect(view.visible).toBe(true);
    if (view.visible) {
      expect(view.uiState).toBe("idle");
      expect(view.clickAction).toBe("open-settings");
    }
  });
});

describe("isCuaBuildCapability 形状守卫", () => {
  it("接受 placeholder 与带字符串数组的 narrow", () => {
    expect(isCuaBuildCapability({ kind: "placeholder" })).toBe(true);
    expect(isCuaBuildCapability({ kind: "narrow", capabilities: ["screenshot.single-window"] })).toBe(
      true,
    );
  });

  it("拒绝畸形形状：narrow 缺 capabilities、非字符串元素、未知 kind、非对象", () => {
    expect(isCuaBuildCapability({ kind: "narrow" })).toBe(false);
    expect(isCuaBuildCapability({ kind: "narrow", capabilities: ["ok", 1] })).toBe(false);
    expect(isCuaBuildCapability({ kind: "full" })).toBe(false);
    expect(isCuaBuildCapability(null)).toBe(false);
    expect(isCuaBuildCapability(undefined)).toBe(false);
    expect(isCuaBuildCapability("placeholder")).toBe(false);
  });
});
