import { describe, expect, it } from "vitest";
import { parseCuaNativeAuthorityRequest } from "../src/mcp/cua-native-authority-contract.js";

describe("observation authority wire", () => {
  it.each(["confirmRead", "observationResult"])("recognizes %s", (method) => {
    expect(
      parseCuaNativeAuthorityRequest(JSON.stringify({ requestId: "1", method, payload: {} })).ok,
    ).toBe(true);
  });
});
