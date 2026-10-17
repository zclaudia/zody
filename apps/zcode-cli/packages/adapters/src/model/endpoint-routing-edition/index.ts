import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import type { ProviderEndpointRoutingFactoryOptions } from "../provider-endpoint-routing-options.js";

/**
 * fork 改动：BYOK（用户自带 key）访问 z.ai/BigModel 时，请求必须直连用户配置的地址，
 * key 与对话内容不得改写经官方网关（zcode.z.ai）转发，因此本 edition 恒不改写。
 * 原官方网关改写实现保留在 official-coding-plan-gateway.ts 及其单测中，由后续任务统一删除。
 */
export function createProviderEndpointRoutingPort(
  _options: ProviderEndpointRoutingFactoryOptions,
): ProviderEndpointRoutingPort {
  return {
    async resolve(requestUrl) {
      return { routed: false, url: requestUrl };
    },
  };
}
