import {
  collectVisibleZCodeBackgroundTaskControlItems,
  getZCodeBackgroundTaskControlItemElapsedMs,
  isActiveZCodeBackgroundTaskControlItem,
  parseZCodeBackgroundTaskControlItems,
  type ZodyBackgroundTaskControlItem,
  type ZodyBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type ZodyBackgroundBashJobStatus = ZodyBackgroundTaskControlStatus;
export type ZodyBackgroundBashJob = ZodyBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseZCodeBackgroundBashJobs(value: unknown): ZodyBackgroundBashJob[] {
  return parseZCodeBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveZCodeBackgroundBashJob(job: ZodyBackgroundBashJob): boolean {
  return isActiveZCodeBackgroundTaskControlItem(job);
}

export function getZCodeBackgroundBashJobElapsedMs(
  job: ZodyBackgroundBashJob,
  now = Date.now(),
): number {
  return getZCodeBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleZCodeBackgroundBashJobs(
  jobs: readonly ZodyBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ZodyBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleZCodeBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    ZodyBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: ZodyBackgroundTaskControlItem): job is ZodyBackgroundBashJob {
  return job.taskKind === "bash";
}
