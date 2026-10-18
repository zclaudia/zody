import type { AppUsageRequest, AppUsageSnapshot } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * fork（F4.5）：官方 Coding Plan / Start Plan 额度、用量 monitor 与额度重置链路已删除。
 * 保留 App Usage：经 ZCode Protocol 读取 agent 数据库的真实本地统计。
 */
export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
