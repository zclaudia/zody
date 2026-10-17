import { describe, expect, it, vi } from "vitest";
import {
  buildZCodeSourceHeadersFromContext,
  ZCODE_SOURCE_HEADERS,
  ZCODE_SOURCE_REFERER_URL,
  ZCODE_SOURCE_TITLE,
} from "../src/zcode-source-headers.js";

describe("buildZCodeSourceHeadersFromContext", () => {
  it("默认只发基础上下文头，停发来源标识与设备标识（F2.10：D5 未决取中性值）", () => {
    expect(
      buildZCodeSourceHeadersFromContext({
        appVersion: " 2.14.0 ",
        arch: "arm64",
        clientLanguage: "zh-CN",
        clientTimezone: "Asia/Shanghai",
        osVersion: "Darwin 25.0.0",
        platform: "darwin",
        releaseChannel: "test",
        sourceTitle: "cli",
      }),
    ).toEqual({
      ...ZCODE_SOURCE_HEADERS,
      "User-Agent": "ZCode/2.14.0",
      "X-ZCode-App-Version": "2.14.0",
      "X-Platform": "darwin-arm64",
      "X-Release-Channel": "test",
      "X-Client-Language": "zh-CN",
      "X-Client-Timezone": "Asia/Shanghai",
      "X-Os-Category": "macos",
      "X-Os-Version": "Darwin 25.0.0",
    });
  });

  it("drops invalid optional values without emitting malformed headers", () => {
    const headers = buildZCodeSourceHeadersFromContext({
      appVersion: "bad\nversion",
      clientLanguage: "\n",
      clientTimezone: "",
      platform: "win32",
      sourceTitle: "electron",
    });

    expect(headers).toMatchObject({
      "User-Agent": "ZCode/unknown",
      "X-Client-Language": "unknown",
      "X-Client-Timezone": "unknown",
      "X-Os-Category": "windows",
    });
    expect(headers).not.toHaveProperty("X-Device-Mid");
    expect(headers).not.toHaveProperty("X-ZCode-App-Version");
    expect(headers).not.toHaveProperty("HTTP-Referer");
    expect(headers).not.toHaveProperty("X-Title");
  });

  it("未注入构建期 define 时来源标识常量为空，即默认不发", () => {
    expect(ZCODE_SOURCE_HEADERS).toEqual({ "User-Agent": "ZCode/unknown" });
    expect(ZCODE_SOURCE_REFERER_URL).toBe("");
    expect(ZCODE_SOURCE_TITLE).toBe("");
  });

  it("构建期注入来源标识后才发送 HTTP-Referer 与 X-Title", async () => {
    vi.stubGlobal("__ZCODE_SOURCE_REFERER_URL__", "https://fork.example.dev");
    vi.stubGlobal("__ZCODE_SOURCE_TITLE__", "ForkCode");
    try {
      // 带 query 强制 vitest 重新执行模块，模拟 bundler define 注入后的构建产物。
      const injected = await import("../src/zcode-source-headers.js?build-time-injected");
      const headers = injected.buildZCodeSourceHeadersFromContext({
        appVersion: "2.14.0",
        platform: "darwin",
        sourceTitle: "cli",
      });
      expect(headers["HTTP-Referer"]).toBe("https://fork.example.dev");
      expect(headers["X-Title"]).toBe("ForkCode@cli");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
