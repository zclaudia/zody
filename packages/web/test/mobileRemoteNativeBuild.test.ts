import { describe, expect, it } from "vitest";
import { nativeAllowsInsecureGatewayTransport } from "../src/mobile-remote/mobileRemoteNativeBuild.js";

describe("native debug Gateway transport", () => {
  it("requires an explicit native debug declaration", () => {
    expect(nativeAllowsInsecureGatewayTransport({})).toBe(false);
    expect(nativeAllowsInsecureGatewayTransport({ ZcodeMobileBridge: {} })).toBe(false);
    for (const value of [false, "true", 1, undefined]) {
      expect(
        nativeAllowsInsecureGatewayTransport({
          ZcodeMobileBridge: {
            allowsInsecureGatewayTransport: () => value,
          },
        }),
      ).toBe(false);
    }
    expect(
      nativeAllowsInsecureGatewayTransport({
        ZcodeMobileBridge: {
          allowsInsecureGatewayTransport: () => true,
        },
      }),
    ).toBe(true);
  });
  it("fails closed when the native declaration fails", () => {
    expect(
      nativeAllowsInsecureGatewayTransport({
        ZcodeMobileBridge: {
          allowsInsecureGatewayTransport: () => {
            throw new Error("unavailable");
          },
        },
      }),
    ).toBe(false);
  });
});
