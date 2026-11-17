import { describe, expect, it } from "vitest";
import {
  inspectR2Effect,
  inspectR2Denial,
  readR2TrialReceipt,
  type R2BusinessSnapshot,
  type R2WriteReceipt,
} from "./e2e/helpers/cua-r2-receipt.js";
const snapshot = (): R2BusinessSnapshot => ({
  fixtureKind: "controlled-ax-write-v1",
  pid: 123,
  targetWindow: 4,
  siblingWindow: 5,
  target: { presses: 0, requests: 0, value: "initial", ignoreEffects: false },
  sibling: { presses: 0, requests: 0, value: "sibling", ignoreEffects: false },
});
const receipt = (): R2WriteReceipt => ({
  action_sent: true,
  dispatch_status: "sent",
  state_sync_status: "not_requested",
});
describe("R2 independent business effect", () => {
  it("proves each expected button effect and unchanged sibling", () => {
    const before = snapshot(),
      after = snapshot();
    after.target.requests = 20;
    after.target.presses = 20;
    expect(
      inspectR2Effect({
        before,
        after,
        method: "left_click",
        count: 20,
        receipts: Array.from({ length: 20 }, receipt),
      }).ok,
    ).toBe(true);
  });
  it("rejects AX success when the actual target ignores effects", () => {
    const before = snapshot(),
      after = snapshot();
    after.target.requests = 1;
    expect(
      inspectR2Effect({ before, after, method: "perform_action", count: 1, receipts: [receipt()] })
        .businessEffect,
    ).toBe(false);
  });
  it("rejects changed same PID sibling and stale exact window", () => {
    const before = snapshot(),
      after = snapshot();
    after.target.requests = 1;
    after.target.presses = 1;
    after.sibling.presses = 1;
    after.targetWindow = 6;
    const result = inspectR2Effect({
      before,
      after,
      method: "left_click",
      count: 1,
      receipts: [receipt()],
    });
    expect(result.ok).toBe(false);
    expect(result.siblingUnchanged).toBe(false);
    expect(result.sameIdentity).toBe(false);
  });
  it.each(["not_sent", "possibly_sent"] as const)(
    "does not count %s as effect-proven success",
    (dispatch_status) => {
      const before = snapshot(),
        after = snapshot();
      after.target.requests = 1;
      after.target.presses = 1;
      expect(
        inspectR2Effect({
          before,
          after,
          method: "left_click",
          count: 1,
          receipts: [{ ...receipt(), dispatch_status }],
        }).ok,
      ).toBe(false);
    },
  );
  it("preserves failed post-write sync as a failure despite target effect", () => {
    const before = snapshot(),
      after = snapshot();
    after.target.requests = 1;
    after.target.value = "changed";
    expect(
      inspectR2Effect({
        before,
        after,
        method: "set_value",
        value: "changed",
        count: 1,
        receipts: [{ ...receipt(), state_sync_status: "failed" }],
      }).ok,
    ).toBe(false);
  });
  it("requires every trial receipt and the actual model value", () => {
    const before = snapshot(),
      after = snapshot();
    after.target.requests = 20;
    after.target.value = "changed";
    expect(
      inspectR2Effect({
        before,
        after,
        method: "set_value",
        value: "changed",
        count: 20,
        receipts: [receipt()],
      }).ok,
    ).toBe(false);
  });
});

describe("R2 provider receipt envelope", () => {
  const denial = {
    code: "permission_denied",
    action_sent: false,
    dispatch_status: "not_sent",
    state_sync_status: "not_requested",
  };
  const result = (kind: string, receipt: unknown, isError = true, trial = 0) => ({
    isError,
    content:
      "MCP tool returned an error:\nR2_RECEIPTS:" +
      JSON.stringify({ kind, trial, receipts: [receipt] }),
  });
  it("accepts a strict expected zero-dispatch denial even when aggregate node tool isError is true", () => {
    expect(readR2TrialReceipt(result("deny", denial), "deny", 0)).toEqual(denial);
  });
  it("never counts a denied write as a successful action", () => {
    expect(() => readR2TrialReceipt(result("left_click", denial), "left_click", 0)).toThrow();
  });
  it("requires exact error and zero-dispatch facts for negative acceptance", () => {
    for (const bad of [
      { ...denial, code: "timeout" },
      { ...denial, action_sent: true },
      { ...denial, dispatch_status: "possibly_sent" },
    ])
      expect(() => readR2TrialReceipt(result("deny", bad), "deny", 0)).toThrow();
  });
  it("rejects another trial's real receipt", () => {
    expect(() => readR2TrialReceipt(result("deny", denial, true, 1), "deny", 0)).toThrow();
  });
});

describe("R2 actual user rejection", () => {
  const input = () => ({
    before: snapshot(),
    after: snapshot(),
    controlRejected: true,
    receipt: {
      code: "permission_denied",
      action_sent: false,
      dispatch_status: "not_sent",
      state_sync_status: "not_requested",
    } as R2WriteReceipt,
  });
  it("requires a real control reject decision", () => {
    expect(inspectR2Denial(input())).toBe(true);
    expect(inspectR2Denial({ ...input(), controlRejected: false })).toBe(false);
  });
  it("rejects rebuilt windows even when model values are equal", () => {
    const i = input();
    i.after.targetWindow++;
    expect(inspectR2Denial(i)).toBe(false);
    const j = input();
    j.after.pid++;
    expect(inspectR2Denial(j)).toBe(false);
  });
});
