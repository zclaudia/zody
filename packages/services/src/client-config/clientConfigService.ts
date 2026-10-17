import {
  clientConfigReadOptionsSchema,
  type ClientConfigSnapshot,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import type { IClientConfigService } from "./clientConfig.js";
import { resolveLocalDynamicWorkflowClientConfig } from "./localClientConfig.js";

interface LocalClientConfigServiceDependencies {
  /**
   * 动态工作流 offer 解析注入点：缺省用模块纯本地解析。
   * desktop-attached-remote 等没有本机设置权威的装配可覆盖为推送值。
   */
  resolveDynamicWorkflowClientConfig?: typeof resolveLocalDynamicWorkflowClientConfig;
}

/**
 * fork（F2.6b）纯本地实现：`/api/v1/client/configs` 不再被请求。
 * 公开快照恒取「远端缺省」回落值（pluginStoreOrder / zsrcUrl 均无本地来源，为 null），
 * 与改造前断网行为一致；动态工作流 offer 由 localClientConfig 提供。
 * 原 apiClient / resolveRequestContext 依赖整段移除——保留请求路径会让断网行为重新不确定。
 */
export function createClientConfigService(
  dependencies: LocalClientConfigServiceDependencies = {},
): IClientConfigService {
  const resolveOffer = dependencies.resolveDynamicWorkflowClientConfig;
  return {
    async getSnapshot(options = {}) {
      // 本地值恒定，forceRefresh 退化为 no-op；保留入参校验维持既有契约边界。
      clientConfigReadOptionsSchema.parse(options);
      const snapshot: ClientConfigSnapshot = { pluginStoreOrder: null, zsrcUrl: null };
      return structuredClone(snapshot);
    },
    async getDynamicWorkflowClientConfig(options = {}) {
      // forceRefresh 仅作入参校验后忽略：本地值恒定、无缓存可绕过。
      clientConfigReadOptionsSchema.parse(options);
      const resolve = resolveOffer ?? resolveLocalDynamicWorkflowClientConfig;
      return resolve({});
    },
  };
}
