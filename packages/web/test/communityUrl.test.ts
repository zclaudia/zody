import { describe, expect, it, vi } from "vitest";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "../src/communityUrl.js";
import localDefaultAppConfig from "../../../config/default.json" with { type: "json" };

const LOCAL_CONFIG = {
  community_urls: {
    "zh-CN": "https://local.example.com/feishu",
    "en-US": "https://local.example.com/discord",
  },
  feedback_url: "https://local.example.com/feedback",
};

describe("resolveWebCommunityUrl", () => {
  it("按语言取注入本地配置的社群入口", async () => {
    await expect(
      resolveWebCommunityUrl("zh-CN", { localConfig: LOCAL_CONFIG }),
    ).resolves.toBe("https://local.example.com/feishu");
    await expect(
      resolveWebCommunityUrl("en-US", { localConfig: LOCAL_CONFIG }),
    ).resolves.toBe("https://local.example.com/discord");
  });

  it("未注入配置时返回内置 config/default.json 的解析结果", async () => {
    await expect(resolveWebHelpConfig()).resolves.toEqual({
      community_urls: {
        "zh-CN": localDefaultAppConfig.community_urls["zh-CN"],
        "en-US": localDefaultAppConfig.community_urls["en-US"],
      },
      feedback_url: localDefaultAppConfig.feedback_url,
      feedback_use_external_form: localDefaultAppConfig.feedback_use_external_form,
    });
  });

  // fork（F2.7）：帮助与社群配置只读内置值；远端桩返回不同链接也不得被请求或采用。
  it("不再请求远端 /api/v1/client/configs，桩返回的不同链接不会被使用", async () => {
    const remoteStub = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        code: 0,
        data: {
          configs: {
            feedbackUrl: {
              feedback_url: "https://remote.example.com/feedback",
              community_urls: {
                "zh-CN": "https://remote.example.com/feishu",
                "en-US": "https://remote.example.com/discord",
              },
            },
          },
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = remoteStub;
    try {
      await expect(resolveWebCommunityUrl("zh-CN")).resolves.toBe(
        localDefaultAppConfig.community_urls["zh-CN"],
      );
      await expect(resolveWebCommunityUrl("en-US")).resolves.toBe(
        localDefaultAppConfig.community_urls["en-US"],
      );
      await expect(resolveWebHelpConfig().then((c) => c.feedback_url)).resolves.toBe(
        localDefaultAppConfig.feedback_url,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(remoteStub).not.toHaveBeenCalled();
  });
});
