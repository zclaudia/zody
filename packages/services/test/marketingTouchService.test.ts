import { describe, expect, it, vi } from "vitest";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";

// F2.8（fork 官方依赖移除）：营销触达停用——服务不再请求 {官方}/api/v1/marketing/touch，
// 未登录与已登录两态都必须零请求；query 恒返回空快照（UI 因此不出现横幅与弹窗），
// report 为空操作。营销触达代码与 UI 组件在 F4.4 统一删除。
function fixture(token: string | null) {
  const request = vi.fn(async () => {
    throw new Error("marketing touch must not issue requests");
  });
  const onSnapshot = vi.fn();
  const service = createMarketingTouchService({
    apiClient: { request },
    getToken: async () => token,
    getDeviceMid: () => "550e8400-e29b-41d4-a716-446655440000",
    baseUrl: "https://api.example.com",
    appVersion: "3.15.1",
    onSnapshot,
  });
  return { service, request, onSnapshot };
}

describe("MarketingTouchService（fork 营销触达停用）", () => {
  it.each([
    ["未登录", null],
    ["已登录", "first-token"],
  ])("%s时 query 不发出任何营销触达请求并返回空快照", async (_state, token) => {
    const f = fixture(token);
    const snapshot = await f.service.query({ locale: "en-US" });
    expect(snapshot.deliveries).toEqual([]);
    expect(snapshot.rejectedCount).toBe(0);
    expect(snapshot.language).toBe("en-US");
    expect(f.request).not.toHaveBeenCalled();
    // 空快照不投喂素材注册表，云内容也就没有任何营销素材可用。
    expect(f.onSnapshot).not.toHaveBeenCalled();
  });

  it("report 不再向官方上报动作", async () => {
    const f = fixture("first-token");
    const snapshot = await f.service.query({ locale: "zh-CN" });
    await expect(
      f.service.report({
        locale: "zh-CN",
        scope: snapshot.scope,
        campaignId: "193001",
        actionType: "confirm",
      }),
    ).resolves.toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("scope 在服务实例内保持稳定，跨实例不同", async () => {
    const f = fixture(null);
    const first = await f.service.query({ locale: "en-US" });
    const second = await f.service.query({ locale: "zh-CN" });
    expect(second.scope).toBe(first.scope);
    const other = fixture(null);
    const otherSnapshot = await other.service.query({ locale: "en-US" });
    expect(otherSnapshot.scope).not.toBe(first.scope);
  });
});
