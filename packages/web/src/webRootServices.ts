import type { Root } from "@zcode/ui";

/**
 * Root 组件要求的服务集合契约（T1.2）。
 * 桌面 Web 客户端的 `/remote*` 路由与手机入口（mobile.html）都按这份契约拼装服务，
 * 避免两条入口各写一份类型后漂移。
 */
export type RootServices = Parameters<typeof Root>[0]["services"];

/** 空实现服务的 handler 签名。 */
export type ServiceMethod = (...args: any[]) => unknown;
