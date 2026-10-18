import { describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

// fork（F4.5）：官方 Coding Plan / Start Plan 额度与用量 monitor 链路已删除，
// 本文件只钉保留的 App Usage 路径（agent 数据库真实统计）。

function createAppUsageSnapshot(range: AppUsageSnapshot["range"] = "30d"): AppUsageSnapshot {
  return {
    range,
    generatedAt: 1_900_000_000_000,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 104,
      inputTokens: 14,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 5,
      cacheReadTokens: 80,
      cacheHitRate: 0.8,
      totalSessions: 1,
      totalTurns: 1,
      toolCallCount: 2,
      toolErrorRate: 0.5,
      modelErrorRate: 0.5,
      avgTimeToFirstTokenMs: 100,
      avgTurnDurationMs: 2000,
      activeDays: 2,
      currentStreakDays: 2,
      longestSessionMs: 2000,
      longestStreakDays: 2,
      peakDayTokens: 104,
      favoriteModel: { modelId: "model-a", totalTokens: 104, share: 1 },
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 100, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

describe("createUsageStatsService（App Usage）", () => {
  it("经 ZCode Protocol 读取 agent 数据库统计", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot());
    const service = createUsageStatsService({
      zcodeAgentService: { getAppUsageStats },
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "30d",
      timeZone: "UTC",
    });

    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "30d",
      timeZone: "UTC",
    });
    expect(snapshot.source).toBe("agent-db");
    expect(snapshot.summary.totalSessions).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(104);
  });

  it("7d range 原样透传", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot("7d"));
    const service = createUsageStatsService({
      zcodeAgentService: { getAppUsageStats },
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "7d",
      timeZone: "UTC",
    });

    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "7d",
      timeZone: "UTC",
    });
    expect(snapshot.source).toBe("agent-db");
  });

  it("全量概览用 all range 与调用端时区透传", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot("all"));
    const service = createUsageStatsService({
      zcodeAgentService: { getAppUsageStats },
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "all",
      timeZone: "Asia/Shanghai",
    });

    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "all",
      timeZone: "Asia/Shanghai",
    });
    expect(snapshot.range).toBe("all");
  });
});
