import {
  collectVisibleZodyBackgroundTaskControlItems,
  getZodyBackgroundTaskControlItemElapsedMs,
  isActiveZodyBackgroundTaskControlItem,
  parseZodyBackgroundTaskControlItems,
  type ZodyBackgroundTaskControlItem,
  type ZodyBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type ZodyBackgroundBashJobStatus = ZodyBackgroundTaskControlStatus;
export type ZodyBackgroundBashJob = ZodyBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseZodyBackgroundBashJobs(value: unknown): ZodyBackgroundBashJob[] {
  return parseZodyBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveZodyBackgroundBashJob(job: ZodyBackgroundBashJob): boolean {
  return isActiveZodyBackgroundTaskControlItem(job);
}

export function getZodyBackgroundBashJobElapsedMs(
  job: ZodyBackgroundBashJob,
  now = Date.now(),
): number {
  return getZodyBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleZodyBackgroundBashJobs(
  jobs: readonly ZodyBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<ZodyBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleZodyBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    ZodyBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: ZodyBackgroundTaskControlItem): job is ZodyBackgroundBashJob {
  return job.taskKind === "bash";
}
