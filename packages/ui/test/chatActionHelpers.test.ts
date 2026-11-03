import { describe, expect, it } from "vitest";
import type { ZodyConfigOption } from "@zody/shared";
import { readCurrentZodyMode } from "../src/hooks/chatActionHelpers.js";

function createModeOption(currentValue: string | boolean): ZodyConfigOption {
  return {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue,
  };
}

describe("chatActionHelpers", () => {
  it("reads yolo from ZCode Agent mode config options", () => {
    expect(readCurrentZodyMode([createModeOption("yolo")])).toBe("yolo");
  });

  it("reads edit from ZCode Agent mode config options", () => {
    expect(readCurrentZodyMode([createModeOption("edit")])).toBe("edit");
  });

  it("keeps provider-native ZCode Agent modes", () => {
    expect(readCurrentZodyMode([createModeOption("bypassPermissions")])).toBe("bypassPermissions");
  });

  it("does not normalize retired provider-native agent mode ids", () => {
    const readMode = readCurrentZodyMode as (
      options: readonly ZodyConfigOption[],
      provider?: string,
    ) => unknown;
    expect(readCurrentZodyMode([createModeOption("agent")])).toBeUndefined();
    expect(readMode([createModeOption("agent-full-access")], "gemini")).toBeUndefined();
  });

  it("ignores invalid mode values", () => {
    expect(readCurrentZodyMode([createModeOption("unknown")])).toBeUndefined();
    expect(readCurrentZodyMode([createModeOption(true)])).toBeUndefined();
  });
});
