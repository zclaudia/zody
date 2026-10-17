import { randomUUID } from "node:crypto";
import type { ApiClient, MarketingTouchSnapshot } from "@zcode/shared";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";

// F2.8（fork 官方依赖移除，阶段 2 细则盘点 #7）：营销触达属「外露」官方依赖——UI 挂载后即请求
// {官方}/api/v1/marketing/touch（携带 X-Device-Mid，登录后附带 Bearer），官方可在 fork 内弹窗、
// 展示横幅。fork 决策关闭该能力：本服务不再发出任何网络请求，query 恒返回空快照（无投放，
// UI 因此不出现横幅与弹窗），report 为空操作（不再向官方发送设备标识与动作）。
// 营销触达代码与 UI 组件按任务拆分在 F4.4 统一删除；在此之前保留工厂签名与类型契约，
// node.ts 的装配无需改动（options 仅原远端实现消费，现已不读取）。
export function createMarketingTouchService(_options: {
  apiClient: ApiClient;
  getToken: () => Promise<string | null | undefined>;
  getDeviceMid: () => string | undefined;
  baseUrl: string;
  appVersion: string;
  onSnapshot?: (snapshot: MarketingTouchSnapshot) => void;
}): IMarketingTouchService {
  // scope 保留「一次服务实例一个上下文」的原语义，供 UI 控制器做事件上下文隔离；
  // 不再随账号凭据变化，因为已没有需要凭据隔离的上报。
  const scope = randomUUID();
  return {
    async query({ locale }) {
      return {
        serverTime: Date.now(),
        language: locale,
        deliveries: [],
        rejectedCount: 0,
        scope,
      };
    },
    async report() {
      // 无营销内容，也停止向官方上报动作；保留空实现以免 UI 调用点悬空（F4.4 一并删除）。
    },
  };
}
