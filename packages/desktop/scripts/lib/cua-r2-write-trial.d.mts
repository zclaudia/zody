export type WriteTrialScore = {
  trialId: string | null;
  kind: string | null;
  status: "successful" | "safe-refusal" | "not-proven" | "failed";
  reason: string;
  liveAcceptance: false;
};
type SystemState = { present: boolean; type: string; value: boolean | null };
type Sample = {
  sequence: number;
  monotonic: number;
  active: boolean;
  key: boolean;
  firstResponder: boolean;
  pointer: [number, number];
  clipboard: number;
  space: number;
  windows: Array<{ id: number; pid: number; layer: number }>;
  console: SystemState;
  login: SystemState;
  rootLocked: SystemState;
  cgLocked: SystemState;
  displayExists: boolean;
  displayOnline: boolean;
  displayActive: boolean;
  displayAsleep: boolean;
  guard: string;
};
type ModelSnapshot = {
  requests: number;
  presses: number;
  value: string;
  ignoreEffects: boolean;
};
type FixtureSnapshot = {
  fixtureKind: "controlled-ax-write-v1";
  pid: number;
  targetWindow: number;
  siblingWindow: number;
  title: string;
  targetMarker: string;
  siblingMarker: string;
  barrierEnabled: boolean;
  barrierNonce: string;
  target: ModelSnapshot;
  sibling: ModelSnapshot;
};
type WindowMetadata = { id: number; pid: number; title: string };
type Audit = {
  event: "admitted" | "completed";
  attempt: number;
  scope: string;
  dispatch_status: string;
};
/** The controller must supply these observations from the actual monitor, fixture and native chain. */
export type WriteTrialEvidence = {
  trialId: string;
  kind: string;
  method: "left_click" | "perform_action" | "set_value";
  monitor: {
    trialId: string;
    pid: number;
    start: Sample;
    samples: Sample[];
    end: Sample;
    focus: unknown[];
    insertedText: string;
    keys: Array<{
      sequence: number;
      monotonic: number;
      text: string;
      repeat: boolean;
      sourcePID: number;
      sourceState: number;
      fixtureDropped: boolean;
    }>;
    fenceRequest: { sequence: number; trialId: string; kind: "fence" };
    baselineFence: { sequence: number; trialId: string; keySequence: number };
  };
  barrier: {
    fixtureNonce: string;
    previousSequence: number;
    pending: { nonce: string; sequence: number };
    release: { nonce: string; sequence: number };
  };
  witness: {
    trialId: string;
    beforeOrder: number;
    pendingOrder: number;
    fenceRequestOrder: number;
    fenceAckOrder: number;
    keyOrder: number;
    releaseOrder: number;
    effectOrder: number;
    fenceCommandSequence: number;
    baselineKeySequence: number;
    keySequence: number;
    keyObservation: {
      trialId: string;
      key: {
        sequence: number;
        monotonic: number;
        text: string;
        repeat: boolean;
        sourcePID: number;
        sourceState: number;
        fixtureDropped: boolean;
      };
    };
  };
  native: {
    received: boolean;
    isError: boolean;
    receipt: {
      action_sent: boolean;
      dispatch_status: string;
      state_sync_status: string;
      code?: string;
    };
    audit: Audit[];
  };
  effect: {
    before: FixtureSnapshot;
    after: FixtureSnapshot;
    windowsBefore: WindowMetadata[];
    windowsAfter: WindowMetadata[];
    expectedValue?: string;
  };
};
/** Evaluates collected controller evidence, not the authenticity of that evidence. */
export function evaluateWriteTrial(input: unknown): WriteTrialScore;
export function summarizeWriteTrials(rows: WriteTrialScore[]): {
  total: number;
  successful: number;
  "safe-refusal": number;
  "not-proven": number;
  failed: number;
  allAttemptsAccountedFor: boolean;
  measurement: "controller-evidence-evaluation";
  calibration: "requires-independent-live-review";
  liveAcceptance: false;
  R2Complete: false;
};
