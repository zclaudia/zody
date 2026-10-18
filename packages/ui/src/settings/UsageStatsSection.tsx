import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";

/**
 * fork（F4.5）：官方 Coding Plan 用量页与来源 tab 已删除，使用统计只保留 App Usage
 * （agent 数据库本地统计）。
 */
export function UsageStatsSection() {
  return <AppUsagePanel />;
}
