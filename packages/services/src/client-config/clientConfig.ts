import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 窗口级公开配置读取。业务模块只消费自己的字段，不拥有第二份请求缓存。 */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
  /**
   * fork（F2.6b）：动态工作流 offer 由 Host 本地模块（localClientConfig）提供，
   * renderer 经本服务读取，不再依赖 ICodingPlanSubscriptionService。
   * `forceRefresh` 契约保留：本地值恒定，语义上等价于无缓存直读。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
);
