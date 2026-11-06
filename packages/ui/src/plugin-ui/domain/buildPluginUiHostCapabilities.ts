import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildMcpAppsExperimentalCapabilities } from "@zody/shared/mcp-apps";

/** 宿主实例真实可用的交互；缺省项对应的能力不声明，插件据此降级。 */
export interface PluginUiHostCapabilityInput {
  canSample?: boolean;
  canSendFollowUpMessage: boolean;
  canUpdateModelContext: boolean;
  canSetWidgetState: boolean;
  /** 宿主能代理 resources/subscribe 并把 server 通知路由回本实例。 */
  canSubscribeResources: boolean;
  /** 平台有 saveFile（桌面）才声明 downloadFile。 */
  canDownloadFile: boolean;
  /** 常驻面板实例：宣告 `experimental["zody/surface"]: { id }`，页面据此判断自己运行在面板里。 */
  surfaceId?: string;
}

/**
 * hostCapabilities 的唯一构造点。声明与 handler 一一对应：没有会话动作绑定就不声明 message，没有 composer 就不声明
 * updateModelContext。ZCode 扩展（widgetState、resourceSubscribe、surface、csp 放宽）一律放 `experimental`，
 * 由 shared 的 `buildMcpAppsExperimentalCapabilities` 从同一份输入同时生成 canonical (`zody/*`) 与
 * legacy (`zcode/*`) 两种表示（过渡期双宣告，旧插件靠旧键 feature detect）。
 */
export function buildPluginUiHostCapabilities(
  input: PluginUiHostCapabilityInput,
): McpUiHostCapabilities {
  return {
    openLinks: {},
    serverTools: {},
    serverResources: input.canSubscribeResources ? { listChanged: true } : {},
    logging: {},
    ...(input.canSample ? { sampling: {} } : {}),
    ...(input.canDownloadFile ? { downloadFile: {} } : {}),
    // image 随 text 一起声明（png / jpeg / webp，单张 ≤ 4 MiB）。
    ...(input.canSendFollowUpMessage ? { message: { text: {}, image: {} } } : {}),
    ...(input.canUpdateModelContext
      ? { updateModelContext: { text: {}, structuredContent: {}, image: {} } }
      : {}),
    // 官方 SDK 把 experimental 限成 `Record<string, object>`，shared helper 返回 `Record<string, unknown>`；
    // 值实际全是能力对象，这里只做类型收窄，不改变运行时形状。
    experimental: buildMcpAppsExperimentalCapabilities({
      canSetWidgetState: input.canSetWidgetState,
      canSubscribeResources: input.canSubscribeResources,
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    }) as unknown as Record<string, object>,
  };
}
