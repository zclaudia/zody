export function cuaR1SystemChromeOptions<T extends Record<string, unknown>>(
  options: T,
  context: { platform: string; specs: readonly string[]; systemRun?: string },
): Omit<T, "detach"> & { detach?: boolean };
export function canPollR1SystemUI(
  sample: {
    guard?: unknown;
    sleepSequence?: unknown;
    wakeSequence?: unknown;
    event?: unknown;
  } | null,
  faultBoundary: number | null,
): boolean;
export function r1SystemWaitBudgets(operatorWaitSeconds?: number): {
  operatorMs: number;
  recoveryMs: number;
  testMs: number;
  monitorSeconds: number;
};
export function waitForR1SystemEligibility(input: {
  readSample: () => Promise<Parameters<typeof canPollR1SystemUI>[0]>;
  faultBoundary: number | null;
  operatorWaitSeconds?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}): Promise<boolean>;
