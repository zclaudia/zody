import { describe, expect, it } from "vitest";
import {
  zcodeCuaLaunchIdentitySchema,
  zcodeRuntimeIdentityInitializeParamsSchema,
  zcodeRuntimeIdentityInitializeResultSchema,
} from "../src/zody-protocol/index.js";

describe("zcode protocol runtime identity startup contract", () => {
  it("accepts only a strict complete Host/runtime identity", () => {
    expect(
      zcodeCuaLaunchIdentitySchema.parse({
        hostInstanceId: "host-real",
        runtimeInstanceId: "agent-real",
      }),
    ).toEqual({ hostInstanceId: "host-real", runtimeInstanceId: "agent-real" });
    expect(zcodeCuaLaunchIdentitySchema.safeParse({ hostInstanceId: "host-real" }).success).toBe(
      false,
    );
    expect(
      zcodeCuaLaunchIdentitySchema.safeParse({
        hostInstanceId: "host-real",
        runtimeInstanceId: "agent-real",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      zcodeCuaLaunchIdentitySchema.safeParse({
        hostInstanceId: " ",
        runtimeInstanceId: "agent-real",
      }).success,
    ).toBe(false);
  });

  it("parses initialize params/result and rejects client-shaped business fields", () => {
    const params = zcodeRuntimeIdentityInitializeParamsSchema.parse({
      identity: { hostInstanceId: "host-real", runtimeInstanceId: "agent-real" },
    });
    expect(params.identity.hostInstanceId).toBe("host-real");
    expect(
      zcodeRuntimeIdentityInitializeParamsSchema.safeParse({
        identity: { hostInstanceId: "host-real", runtimeInstanceId: "agent-real" },
        inputOrigin: "desktop",
      }).success,
    ).toBe(false);
    expect(
      zcodeRuntimeIdentityInitializeResultSchema.parse({ initialized: true, reused: false }),
    ).toEqual({ initialized: true, reused: false });
  });
});
