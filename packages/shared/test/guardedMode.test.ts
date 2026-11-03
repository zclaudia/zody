import { describe, expect, it } from "vitest";
import {
  getZodyAgentAvailableModes,
  getZodyAgentModeSelectOptions,
  normalizeAvailableZodyMode,
} from "../src/zody-agent-model-state.js";
import { submissionModeSchema } from "../src/zody-protocol-v4/submission.js";
import { zodySessionModeSchema } from "../src/zody-protocol-legacy-types.js";
import { executionStateSchema, resolveExecutionState } from "../src/execution-state.js";

describe("guarded wire and mode catalog", () => {
  it("uses autonomous display copy without renaming the guarded value", () => {
    const copy = { name: "Autonomous mode", description: "Ask when there’s risk" };
    expect(getZodyAgentAvailableModes().find((mode) => mode.id === "guarded")).toEqual({
      id: "guarded",
      ...copy,
    });
    expect(getZodyAgentModeSelectOptions().find((option) => option.value === "guarded")).toEqual({
      value: "guarded",
      ...copy,
    });
  });
  it("preserves guarded across independent Plan transitions and serialization", () => {
    const current = resolveExecutionState({ mode: "guarded", planEnabled: true });
    expect(executionStateSchema.parse(current)).toEqual({ mode: "guarded", planEnabled: true });
    expect(resolveExecutionState({ planEnabled: false }, current)).toEqual({
      mode: "guarded",
      planEnabled: false,
    });
  });
  it("round trips the opt-in value without changing the default", () => {
    expect(submissionModeSchema.parse("guarded")).toBe("guarded");
    expect(zodySessionModeSchema.parse("guarded")).toBe("guarded");
    expect(normalizeAvailableZodyMode("guarded")).toBe("guarded");
    const ids = getZodyAgentAvailableModes().map((mode) => mode.id);
    expect(ids[0]).toBe("build");
    expect(ids).toContain("guarded");
    expect(ids).toEqual(["build", "guarded", "plan", "yolo"]);
    expect(getZodyAgentModeSelectOptions().map((option) => option.value)).toEqual(ids);
    expect(submissionModeSchema.safeParse("unknown").success).toBe(false);
  });
  it("keeps historical edit valid without advertising it as a new choice", () => {
    expect(submissionModeSchema.parse("edit")).toBe("edit");
    expect(zodySessionModeSchema.parse("edit")).toBe("edit");
    expect(normalizeAvailableZodyMode("edit")).toBe("edit");
    expect(getZodyAgentAvailableModes().some((mode) => mode.id === "edit")).toBe(false);
  });
});
