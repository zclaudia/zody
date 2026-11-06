import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppInstance } from "@zody/shared/mcp-apps";
import type { IServiceAccessor } from "@zody/services";
import type { IPlatformService } from "@zody/shared";
import type { PluginUiInteractionCallbacks } from "@/plugin-ui/app/pluginUiInteractionPorts.js";
import {
  getPluginUiWidgetState,
  setPluginUiWidgetState,
} from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import { createPluginUiResourceNotificationRegistrar } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import { buildPluginUiHostCapabilities } from "@/plugin-ui/domain/buildPluginUiHostCapabilities.js";
import { buildPluginUiHostContext } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import { createPluginUiDownloadInteraction } from "./pluginUiDownloads.js";
import { createPluginUiMessagePortTransport } from "./messagePortTransport.js";
import { getPluginUiSessionActions } from "./pluginUiSessionActions.js";
import { readPluginUiStyleVariables } from "./readPluginUiStyleVariables.js";
import type { UsePluginUiHostInput } from "./pluginUiHostTypes.js";

/**
 * F18：controller 静态 deps 构建（initialHostContext / 平台交互 / 能力声明 / 回调转发）。
 * 自 pluginUiManagedPage 拆出以满足架构文件行数上限；闭包型生命周期回调（onPhase 等）
 * 仍由 managedPage 提供。行为与拆出前逐行一致（上游 a60ba6a7 参考实现同构）。
 */
export function buildPluginUiControllerDeps(input: {
  bridge: NonNullable<IServiceAccessor["pluginUiBridgeService"]>;
  services: IServiceAccessor;
  platform: IPlatformService;
  sandboxPlatform: NonNullable<IPlatformService["pluginSandbox"]>;
  latest: { current: UsePluginUiHostInput };
  surfaceKey: string;
  getInstance(): McpAppInstance;
}) {
  const { bridge, services, latest, surfaceKey } = input;
  const initialHostContext: McpUiHostContext = buildPluginUiHostContext({
    theme: latest.current.theme,
    locale: latest.current.locale,
    displayMode: latest.current.displayMode,
    width: latest.current.width,
    ...(latest.current.titleBar ? { titleBar: latest.current.titleBar } : {}),
    ...(latest.current.availableDisplayModes
      ? { availableDisplayModes: latest.current.availableDisplayModes }
      : {}),
    // 主题 token 随初始 hostContext 下发，主题切换时经 updateHostContext 更新。
    styleVariables: readPluginUiStyleVariables(),
  });
  const scope = latest.current.scope;
  const presentation = latest.current.presentation;
  // 平台交互（downloadFile）与调用方注入的会话交互合成一份；能力声明按合成后的回调是否存在。
  const platformInteractions = createPluginUiDownloadInteraction({
    platform: input.platform,
    bridge,
    scope,
    presentation,
    getInstance: input.getInstance,
  });
  return {
    bridge,
    sampling: services?.pluginUiSamplingService,
    ...(services?.pluginUiAppToolsService ? { appTools: services.pluginUiAppToolsService } : {}),
    createTransport: createPluginUiMessagePortTransport,
    platform: input.sandboxPlatform,
    scope,
    presentation,
    // 按代际登记到路由表；该会话的投影 store 收到 pluginUi.* 增量后按 (scopeId, generation) 投递。
    resourceNotifications: createPluginUiResourceNotificationRegistrar(
      scope,
      presentation.serverName,
    ),
    initialHostContext,
    hostVersion: latest.current.hostVersion,
    getToolFeed: () => ({
      ...(latest.current.toolInput ? { toolInput: { arguments: latest.current.toolInput } } : {}),
      ...(latest.current.toolResult ? { toolResult: latest.current.toolResult } : {}),
      ...(latest.current.toolCancelled ? { toolCancelled: true } : {}),
    }),
    // widgetState 初值直接读宿主内存 store（唯一 owner），不经 props 再缓存一份；
    // 端口投递时才读，离屏回收后重建也拿到页面最近一次主动保存的值。
    getWidgetState: () => getPluginUiWidgetState(surfaceKey),
    getHostCapabilities: () =>
      buildPluginUiHostCapabilities({
        canSendFollowUpMessage: Boolean(latest.current.interactions?.onSendFollowUpMessage),
        canUpdateModelContext: Boolean(latest.current.interactions?.onUpdateModelContext),
        canSetWidgetState: true,
        canSample: Boolean(services?.pluginUiSamplingService && getPluginUiSessionActions(scope)),
        canSubscribeResources: true,
        canDownloadFile: Boolean(platformInteractions?.onDownloadFile),
        ...(scope.scope.kind === "surface" ? { surfaceId: scope.scope.surfaceId } : {}),
      }),
    ...platformInteractions,
    // 经 latest ref 转调，回调 identity 变化不触发 controller 重建；缺省回 -32601（端口层翻译成 ProtocolError）。
    ...({
      onSendFollowUpMessage: (payload, context) =>
        latest.current.interactions?.onSendFollowUpMessage
          ? latest.current.interactions.onSendFollowUpMessage(payload, context)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateModelContext: (payload) =>
        latest.current.interactions?.onUpdateModelContext
          ? latest.current.interactions.onUpdateModelContext(payload)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateWidgetState: async (widgetState: unknown) => {
        setPluginUiWidgetState(surfaceKey, widgetState);
      },
    } satisfies Pick<
      PluginUiInteractionCallbacks,
      "onSendFollowUpMessage" | "onUpdateModelContext" | "onUpdateWidgetState"
    >),
  };
}
