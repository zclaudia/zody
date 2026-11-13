import { describe, expect, it } from "vitest";
import { mobileCuaGatewayOrigin } from "./e2e/helpers/mobile-cua-url.js";

describe("mobile CUA gateway origin", () => {
  it.each([
    ["https://localhost:1234/path", "https://localhost:1234"],
    ["wss://localhost:1234/path", "https://localhost:1234"],
    ["http://localhost:1234/path", "http://localhost:1234"],
    ["ws://localhost:1234/path", "http://localhost:1234"],
  ])("maps %s to %s", (input, expected) => {
    expect(mobileCuaGatewayOrigin(input)).toBe(expected);
  });
  it("rejects unsupported schemes", () => {
    expect(() => mobileCuaGatewayOrigin("ftp://localhost/")).toThrow();
  });
});
