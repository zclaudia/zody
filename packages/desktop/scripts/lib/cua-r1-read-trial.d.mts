export type ReadTrialScore = {
  trialId: string | null;
  kind: string | null;
  status: "successful" | "safe-refusal" | "not-proven" | "failed";
  reason: string;
  liveAcceptance: false;
};
export function evaluateReadTrial(input: unknown): ReadTrialScore;
export function summarizeReadTrials(rows: ReadTrialScore[]): {
  total: number;
  successful: number;
  failed: number;
  liveAcceptance: false;
  R1Complete: false;
  R2Unblocked: false;
  [key: string]: unknown;
};
