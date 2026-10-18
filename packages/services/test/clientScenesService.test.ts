import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@zcode/shared";

const TEST_ZCODE_ORIGIN = "https://scenes.example.test";

describe("ClientScenesService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("通过统一 ApiClient 读取 client scenes envelope", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("ZCODE_BASE_URL", TEST_ZCODE_ORIGIN);
    vi.resetModules();
    const { ZCODE_CLIENT_SCENES_URL } = await import("../src/providers/api/apiEndpoints.js");
    const { createClientScenesService } =
      await import("../src/client-scenes/clientScenesService.js");
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "",
            data: [
              {
                namespace: "zcode",
                scene: "ai-slides",
                options: {
                  template: {
                    id: "template",
                    type: "template",
                    contents: { en: "Template", cn: "模板" },
                    prompts: { en: "Create slides", cn: "制作幻灯片" },
                    items: [
                      {
                        id: "business",
                        type: "template",
                        contents: { en: "Business", cn: "商务" },
                        descs: { en: "Business deck", cn: "商务演示" },
                        labels: { en: "Recommended", cn: "推荐" },
                        on_finish: "open_presentation",
                        img: null,
                        imgs: { cn: "https://example.com/cn.png" },
                        share_urls: {},
                      },
                    ],
                    refer: "",
                    cascades: {},
                  },
                },
                created_at: 1,
                updated_at: 2,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const service = createClientScenesService({
      apiClient: { request } as ApiClient,
    });

    await expect(service.list()).resolves.toEqual({
      code: 0,
      msg: "",
      data: [
        expect.objectContaining({
          namespace: "zcode",
          scene: "ai-slides",
          created_at: 1,
          updated_at: 2,
        }),
      ],
    });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(ZCODE_CLIENT_SCENES_URL, {
      method: "GET",
    });
  });

  it("fork（F3.1）：未配置端点时关闭动态 scenes 并返回空数据", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    vi.stubEnv("ZCODE_BASE_URL", "");
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "");
    vi.stubEnv("ZCODE_PRODUCTION_BASE_URL", "");
    vi.stubEnv("ZCODE_TEST_BASE_URL", "");
    vi.resetModules();
    const { createClientScenesService } =
      await import("../src/client-scenes/clientScenesService.js");
    const request = vi.fn();

    const service = createClientScenesService({
      apiClient: { request } as unknown as ApiClient,
    });

    await expect(service.list()).resolves.toEqual({ code: 0, msg: "", data: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
