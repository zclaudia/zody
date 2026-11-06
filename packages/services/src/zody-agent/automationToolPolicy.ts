export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;

export function mergeAutomationMutationToolDenylist(
  current: readonly string[] | undefined,
): string[] {
  const merged = new Set(current);
  for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
    merged.add(toolName);
  }
  return [...merged];
}

// fork（F4.3）：OFF_PEAK_MUTATION_TOOL_NAMES / mergeOffPeakMutationToolDenylist
// （闲时派发轮 deny OffPeakCreate）随闲时任务全链路删除。
