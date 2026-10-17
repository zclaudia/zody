import { describe, expect, it } from "vitest";
import { resolveLocalHelpAppConfig } from "../src/helpAppConfig.js";

// fork（F2.7）：帮助与社群配置只读内置 config/default.json，
// 原远端拉取（buildHelpAppConfigUrl/createHelpAppConfigReader）已删除，不再有 fetch 路径可测。
describe("resolveLocalHelpAppConfig", () => {
  it("解析内置配置的反馈地址、外开开关与双语社群入口", () => {
    expect(
      resolveLocalHelpAppConfig({
        community_urls: { "zh-CN": "https://local.cn", "en-US": "https://local.en" },
        feedback_url: "https://local.feedback",
        feedback_use_external_form: true,
      }),
    ).toEqual({
      community_urls: { "zh-CN": "https://local.cn", "en-US": "https://local.en" },
      feedback_url: "https://local.feedback",
      feedback_use_external_form: true,
    });
  });

  it("缺失字段回落为 undefined/false，等价于内置缺省语义", () => {
    expect(resolveLocalHelpAppConfig({})).toEqual({
      community_urls: { "zh-CN": undefined, "en-US": undefined },
      feedback_url: undefined,
      feedback_use_external_form: false,
    });
  });

  it("配置整体缺失或字段类型非法时不抛错，逐字段降级", () => {
    const degraded = {
      community_urls: { "zh-CN": undefined, "en-US": undefined },
      feedback_url: undefined,
      feedback_use_external_form: false,
    };
    expect(resolveLocalHelpAppConfig(null)).toEqual(degraded);
    expect(
      resolveLocalHelpAppConfig({ community_urls: { "zh-CN": 42 }, feedback_url: 7 }),
    ).toEqual(degraded);
  });
});
