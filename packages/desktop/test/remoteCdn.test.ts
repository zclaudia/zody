import { describe, expect, it } from "vitest";
import { resolveRemoteCdnBaseUrls } from "../src/main/remoteCdn.js";

describe("remoteCdn", () => {
  it("未注入构建期 CDN 根时不回落到上游 CDN 默认地址", () => {
    for (const locale of ["zh-CN", "en-US"]) {
      expect(
        resolveRemoteCdnBaseUrls({
          env: "production",
          locale,
          timeZone: "Asia/Shanghai",
          version: "0.0.0-test",
        }),
      ).toEqual([]);
    }
  });

  it("测试产品环境应固定使用内网 SSH remote assets 根目录", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        locale: "zh-CN",
        timeZone: "Asia/Shanghai",
        version: "0.0.0-test",
      }),
    ).toEqual(["http://intranet.example.invalid:12345/ssh-remote-assets/0.0.0-test"]);
  });

  it("显式覆盖 CDN 基址时不再按产品环境选择默认值", () => {
    expect(
      resolveRemoteCdnBaseUrls({
        env: "test",
        overrideBaseUrl: "https://cdn.example.com/releases///",
        version: "0.0.0-test",
      }),
    ).toEqual(["https://cdn.example.com/releases"]);
  });
});
