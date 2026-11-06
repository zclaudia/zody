// 平台能力面收敛：设置页「插件管理」的薄服务接口。
//
// 背景：pluginManagementStore / usePluginUninstall 过去直接注入 IZCodeAgentService，
// UI 层因此散布 13 个 plugins/* 旧协议词的消费点。收敛为独立薄 service 后，UI 只依赖
// 本接口；plugins/* 词表的 host 侧消费点收拢到 pluginManagementService 一处（插件的
// 事实源在 zody-cli 进程，服务实现仍经 agent 协议往返——plugins 词表的收口归属
// 插件能力面自身的协议演进，不在会话 v4 词表范围内）。
// 注意与既有 IPluginsService（已 retired 的 marketplace pluginStore 通道）区分：
// 那套接口按 pluginName+marketplace 寻址且方法语义过时，不复用避免签名冲突。
import type { Event } from "@zody/rpc";
import type {
  ZodyPluginOperationProgressNotification,
  ZodyPluginsConfigureResult,
  ZodyPluginsCancelOperationResult,
  ZodyPluginsDescribeResult,
  ZodyPluginsInstallResult,
  ZodyPluginsListResult,
  ZodyPluginsMarketplaceMutationResult,
  ZodyPluginsOverviewResult,
  ZodyPluginsReferenceCatalogResult,
  ZodyPluginsRestoreBuiltinResult,
  ZodyPluginsSetEnabledResult,
  ZodyPluginsUninstallResult,
  ZodyPluginsValidateResult,
} from "@zody/shared";
import { ServiceChannels } from "@zody/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZodyAgentAddPluginMarketplaceParams,
  ZodyAgentConfigurePluginParams,
  ZodyAgentCancelPluginOperationParams,
  ZodyAgentDescribePluginParams,
  ZodyAgentInstallPluginParams,
  ZodyAgentPluginReferenceCatalogParams,
  ZodyAgentResolveSuggestedPluginReferenceParams,
  ZodyAgentResetPluginConfigParams,
  ZodyAgentPluginViewParams,
  ZodyAgentRemovePluginMarketplaceParams,
  ZodyAgentRestoreBuiltinPluginParams,
  ZodyAgentSetPluginEnabledParams,
  ZodyAgentUninstallPluginParams,
  ZodyAgentUpdatePluginMarketplaceParams,
  ZodyAgentUpdatePluginParams,
  ZodyAgentValidatePluginParams,
} from "../zody-agent/zodyAgentPluginParams.js";

export interface IPluginManagementService {
  listPlugins(params: ZodyAgentPluginViewParams): Promise<ZodyPluginsListResult>;
  /**
   * Plugin 对话引用 catalog：
   * 带 sessionId → session-owned 冻结 catalog；不带 → workspace 当前 catalog。
   * 实现路由到 workspace 级 agent client，不走插件管理独立进程。
   */
  getPluginReferenceCatalog(
    params: ZodyAgentPluginReferenceCatalogParams,
  ): Promise<ZodyPluginsReferenceCatalogResult>;
  resolveSuggestedPluginReference(
    params: ZodyAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zody/shared").ZodyPluginsResolveSuggestedReferenceResult>;
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZodyPluginOperationProgressNotification>;
  getPluginsOverview(params: ZodyAgentPluginViewParams): Promise<ZodyPluginsOverviewResult>;
  addPluginMarketplace(
    params: ZodyAgentAddPluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZodyAgentRemovePluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZodyAgentUpdatePluginMarketplaceParams,
  ): Promise<ZodyPluginsMarketplaceMutationResult>;
  installPlugin(params: ZodyAgentInstallPluginParams): Promise<ZodyPluginsInstallResult>;
  cancelPluginOperation(
    params: ZodyAgentCancelPluginOperationParams,
  ): Promise<ZodyPluginsCancelOperationResult>;
  uninstallPlugin(params: ZodyAgentUninstallPluginParams): Promise<ZodyPluginsUninstallResult>;
  updatePlugin(params: ZodyAgentUpdatePluginParams): Promise<ZodyPluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZodyAgentRestoreBuiltinPluginParams,
  ): Promise<ZodyPluginsRestoreBuiltinResult>;
  configurePlugin(params: ZodyAgentConfigurePluginParams): Promise<ZodyPluginsConfigureResult>;
  resetPluginConfig(
    params: ZodyAgentResetPluginConfigParams,
  ): Promise<ZodyPluginsConfigureResult>;
  validatePlugin(params: ZodyAgentValidatePluginParams): Promise<ZodyPluginsValidateResult>;
  describePlugin(params: ZodyAgentDescribePluginParams): Promise<ZodyPluginsDescribeResult>;
  setPluginEnabled(params: ZodyAgentSetPluginEnabledParams): Promise<ZodyPluginsSetEnabledResult>;
}

export const IPluginManagementService = createServiceDescriptor<IPluginManagementService>(
  ServiceChannels.PluginManagement,
);
