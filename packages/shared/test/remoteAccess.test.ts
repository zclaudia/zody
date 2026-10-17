import { describe, expect, it } from "vitest";
import {
  DEFAULT_REMOTE_ACCESS_NAMESPACE,
  normalizeRemoteAccessGatewayUrl,
  remoteAccessSettingsPatchSchema,
  remoteAccessSettingsSchema,
  tryNormalizeRemoteAccessGatewayUrl,
} from "../src/remoteAccess.js";

describe("normalizeRemoteAccessGatewayUrl", () => {
  it("去掉尾部斜杠并推导 ws/wss 基地址", () => {
    expect(normalizeRemoteAccessGatewayUrl("https://gateway.example.com/")).toEqual({
      baseUrl: "https://gateway.example.com",
      wsBaseUrl: "wss://gateway.example.com",
    });
    expect(normalizeRemoteAccessGatewayUrl("  https://gateway.example.com:8443/zcode//  ")).toEqual(
      {
        baseUrl: "https://gateway.example.com:8443/zcode",
        wsBaseUrl: "wss://gateway.example.com:8443/zcode",
      },
    );
  });

  it("允许直接粘贴 gateway 的 ws 地址，并统一成 http(s) 形式", () => {
    expect(normalizeRemoteAccessGatewayUrl("wss://gateway.example.com/").baseUrl).toBe(
      "https://gateway.example.com",
    );
    expect(
      normalizeRemoteAccessGatewayUrl("ws://127.0.0.1:3200", { allowInsecureTransport: true }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:3200",
      wsBaseUrl: "ws://127.0.0.1:3200",
    });
  });

  it("release 构建（默认）要求 https，本地开发才允许 http", () => {
    expect(() => normalizeRemoteAccessGatewayUrl("http://127.0.0.1:3200")).toThrow(/https/);
    expect(tryNormalizeRemoteAccessGatewayUrl("http://127.0.0.1:3200")).toBeUndefined();
    expect(
      tryNormalizeRemoteAccessGatewayUrl("http://127.0.0.1:3200", { allowInsecureTransport: true }),
    ).toBeDefined();
    // https 在任何运行形态下都接受。
    expect(
      tryNormalizeRemoteAccessGatewayUrl("https://gateway.example.com", {
        allowInsecureTransport: false,
      }),
    ).toEqual({
      baseUrl: "https://gateway.example.com",
      wsBaseUrl: "wss://gateway.example.com",
    });
  });

  it("拒绝空值、相对地址、非 http(s) 协议、带凭据或查询串的地址", () => {
    for (const value of [
      "",
      "   ",
      "gateway.example.com",
      "ftp://gateway.example.com",
      "https://user:secret@gateway.example.com",
      "https://gateway.example.com/?token=secret",
      "https://gateway.example.com/#frag",
    ]) {
      expect(tryNormalizeRemoteAccessGatewayUrl(value, { allowInsecureTransport: true })).toBe(
        undefined,
      );
      expect(() =>
        normalizeRemoteAccessGatewayUrl(value, { allowInsecureTransport: true }),
      ).toThrow();
    }
  });
});

describe("remoteAccess settings schema", () => {
  it("缺省时给出关闭 + 未配置 + 默认 namespace", () => {
    expect(remoteAccessSettingsSchema.parse({})).toEqual({
      enabled: false,
      gatewayUrl: "",
      namespace: DEFAULT_REMOTE_ACCESS_NAMESPACE,
    });
    expect(remoteAccessSettingsSchema.parse({ namespace: "  " }).namespace).toBe(
      DEFAULT_REMOTE_ACCESS_NAMESPACE,
    );
  });

  it("读取时归一化地址，坏值按「未配置」处理而不是让整份设置读坏", () => {
    expect(
      remoteAccessSettingsSchema.parse({ gatewayUrl: " https://gateway.example.com/ " }).gatewayUrl,
    ).toBe("https://gateway.example.com");
    expect(remoteAccessSettingsSchema.parse({ gatewayUrl: "not-a-url" }).gatewayUrl).toBe("");
    expect(remoteAccessSettingsSchema.parse({ enabled: "yes" }).enabled).toBe(false);
  });

  it("丢弃字段之外的键：凭证不能藏进 settings", () => {
    const parsed = remoteAccessSettingsSchema.parse({
      enabled: true,
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
      gatewayCredential: "zgb_secret",
    });
    expect(parsed).toEqual({
      enabled: true,
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
    });
    expect(JSON.stringify(parsed)).not.toContain("zgb_secret");
  });

  it("patch 要求三个字段一次给全，并拒绝非法地址与多余字段", () => {
    expect(
      remoteAccessSettingsPatchSchema.parse({
        enabled: true,
        gatewayUrl: "https://gateway.example.com/",
        namespace: "zcode",
      }),
    ).toEqual({
      enabled: true,
      gatewayUrl: "https://gateway.example.com",
      namespace: "zcode",
    });
    // settings 更新是浅合并，少传字段会把已有地址/namespace 悄悄清空，因此必须直接拒绝。
    expect(remoteAccessSettingsPatchSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      remoteAccessSettingsPatchSchema.safeParse({
        enabled: true,
        gatewayUrl: "gateway.example.com",
        namespace: "zcode",
      }).success,
    ).toBe(false);
    expect(
      remoteAccessSettingsPatchSchema.safeParse({
        enabled: true,
        gatewayUrl: "",
        namespace: "zcode",
        credential: "zgb_secret",
      }).success,
    ).toBe(false);
    // 空串是「未配置」的合法写法（清空地址后开关仍然可以关掉）。
    expect(
      remoteAccessSettingsPatchSchema.parse({ enabled: false, gatewayUrl: "", namespace: "" }),
    ).toEqual({ enabled: false, gatewayUrl: "", namespace: DEFAULT_REMOTE_ACCESS_NAMESPACE });
  });
});
