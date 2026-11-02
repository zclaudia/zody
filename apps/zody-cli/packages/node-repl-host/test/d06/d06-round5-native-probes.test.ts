import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  D06_FFI_OPEN_FLAGS,
  ffiControlWriteAllowed,
  fixedHashMatches,
} from "../../scripts/d06-round5-native-probes.js";

describe("D06 round 5 FFI evidence", () => {
  it("requires truncation, the expected byte count and exact disk contents", () => {
    expect(D06_FFI_OPEN_FLAGS).toBe(0x601);
    expect(
      ffiControlWriteAllowed(
        { ok: true, bytes: 13, expectedBytes: 13, flags: D06_FFI_OPEN_FLAGS },
        "D06_FFI_WRITED_CANARY",
        "D06_FFI_WRITE",
      ),
    ).toBe(false);
    expect(
      ffiControlWriteAllowed(
        { ok: true, bytes: 13, expectedBytes: 13, flags: D06_FFI_OPEN_FLAGS },
        "D06_FFI_WRITE",
        "D06_FFI_WRITE",
      ),
    ).toBe(true);
    expect(
      ffiControlWriteAllowed(
        { ok: true, bytes: 12, expectedBytes: 13, flags: D06_FFI_OPEN_FLAGS },
        "D06_FFI_WRITE",
        "D06_FFI_WRITE",
      ),
    ).toBe(false);
  });

  it("compares before and after bytes with the staged manifest hash", () => {
    const expected = createHash("sha256").update("staged-koffi").digest("hex");
    expect(fixedHashMatches(expected, expected, expected)).toBe(true);
    expect(fixedHashMatches("0".repeat(64), expected, expected)).toBe(false);
    expect(fixedHashMatches(expected, "f".repeat(64), expected)).toBe(false);
    expect(fixedHashMatches("short", "short", "short")).toBe(false);
  });
});
