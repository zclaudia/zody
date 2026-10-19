import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_MARKETPLACES, isPublicStoreMarketplaceId } from "../src/index.js";

describe("DEFAULT_PLUGIN_MARKETPLACES", () => {
  // fork（F6.2，D4b 方案 ii）：默认列表只保留 GitHub 源。官方 CDN 市场改由随包
  // seed 登记为本地 file 源，任何官方远端地址都不应再出现在默认列表里。
  it("contains only the GitHub source and no official remote marketplace", () => {
    expect(DEFAULT_PLUGIN_MARKETPLACES).toEqual([
      expect.objectContaining({
        id: "claude-plugins-official",
        name: "claude-plugins-official",
        pluginCount: 0,
        source: "anthropics/claude-plugins-official",
      }),
    ]);
    expect(DEFAULT_PLUGIN_MARKETPLACES.some((item) => item.id === "zcode-plugins-official")).toBe(
      false,
    );
    expect(DEFAULT_PLUGIN_MARKETPLACES.some((item) => /^https?:\/\//u.test(item.source))).toBe(
      false,
    );
  });

  it("keeps the Claude marketplace as the only default GitHub source", () => {
    expect(DEFAULT_PLUGIN_MARKETPLACES).toHaveLength(1);
    expect(DEFAULT_PLUGIN_MARKETPLACES[0]?.source).toBe("anthropics/claude-plugins-official");
    expect(DEFAULT_PLUGIN_MARKETPLACES[0]?.source.includes("://")).toBe(false);
  });

  it("classifies only the ZCode-operated channels as public store marketplaces", () => {
    expect(isPublicStoreMarketplaceId("zcode-plugins-official")).toBe(true);
    expect(isPublicStoreMarketplaceId("zcode-plugins")).toBe(false);
    // Claude 官方市场受信但不属于「公开」分段（归个人），见 CONTEXT.md 术语表。
    expect(isPublicStoreMarketplaceId("claude-plugins-official")).toBe(false);
    expect(isPublicStoreMarketplaceId("inline")).toBe(false);
  });
});
