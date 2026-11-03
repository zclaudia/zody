import type { ZodyBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeZodyBackgroundTaskControlItems(
  current: readonly ZodyBackgroundTaskControlItem[],
  updates: readonly ZodyBackgroundTaskControlItem[],
): ZodyBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
