import { describe, expect, it, vi } from "vitest";
import type { HttpClientPort } from "@zcode/contracts";
import { createProviderEndpointRoutingPort } from "../src/model/endpoint-routing-edition/index.js";
import { createProviderEndpointRoutingFetch } from "../src/model/provider-endpoint-routing-fetch.js";
import type { ProviderEndpointRoutingFactoryOptions } from "../src/model/provider-endpoint-routing-options.js";

const GATEWAY_ORIGIN = "https://gateway.example.test";

/**
 * fork 任务 F2.1：BYOK（用户自带 key）访问 z.ai/BigModel 的请求必须直连用户配置的地址，
 * 不得改写到官方网关。本文件断言 edition 入口对官方 BYOK messages 地址恒返回 routed:false。
 */
function createFactoryOptions(): ProviderEndpointRoutingFactoryOptions {
  const httpClient: HttpClientPort = {
    request: vi.fn(async () => {
      throw new Error("unexpected configuration request");
    }),
  };
  return {
    endpointOrigin: GATEWAY_ORIGIN,
    httpClient,
  };
}

describe("provider endpoint routing edition (BYOK no rewrite)", () => {
  it.each([
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://api.z.ai:443/api/anthropic/v1/messages/",
    "https://API.Z.AI/api/anthropic/v1/messages?stream=true",
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
    "https://open.bigmodel.cn:443/api/anthropic/v1/messages/",
    "https://OPEN.BIGMODEL.CN/api/anthropic/v1/messages?id=a%2Bb",
  ])("keeps %s untouched with routed:false", async (url) => {
    const port = createProviderEndpointRoutingPort(createFactoryOptions());
    await expect(port.resolve(url)).resolves.toEqual({ routed: false, url });
  });

  it.each([
    "https://api.z.ai/api/anthropic/v1/messages",
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
  ])("sends %s directly without gateway rewrite or configuration IO", async (sourceUrl) => {
    const options = createFactoryOptions();
    let captured: Request | undefined;
    const fetch = createProviderEndpointRoutingFetch({
      fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
        captured = new Request(input, init);
        return new Response("data: ok\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
      routingPort: createProviderEndpointRoutingPort(options),
    });

    const response = await fetch(`${sourceUrl}?stream=true`, {
      method: "POST",
      body: "request-body",
      headers: { Authorization: "Bearer byok-key", "x-api-key": "byok-key" },
    });

    await expect(response.text()).resolves.toBe("data: ok\n\n");
    expect(captured?.url).toBe(`${sourceUrl}?stream=true`);
    expect(new URL(captured!.url).host).not.toBe(new URL(GATEWAY_ORIGIN).host);
    expect(captured?.headers.get("authorization")).toBe("Bearer byok-key");
    expect(captured?.headers.get("x-api-key")).toBe("byok-key");
    await expect(captured?.text()).resolves.toBe("request-body");
    expect(options.httpClient.request).not.toHaveBeenCalled();
  });
});
