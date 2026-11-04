import { describe, expect, it } from "vitest";
import { checkRenameGeneration, ZODY_RENAME_GENERATION } from "../src/index.js";
import { helloMessageSchema, helloAckMessageSchema } from "../src/validation.js";

describe("rename generation handshake", () => {
  const hello = {
    type: "zody-hello",
    version: "1",
    platform: "darwin",
    arch: "arm64",
    pid: 1,
    generation: 2,
  };
  const ack = { type: "zody-hello-ack", version: "1", clientId: "client", generation: 2 };
  it("accepts only the numeric generation", () => {
    expect(ZODY_RENAME_GENERATION).toBe(2);
    expect(checkRenameGeneration(2)).toEqual({ ok: true });
    for (const value of [undefined, null, "2", 1, 3, 2.1, [2, 2]]) {
      expect(checkRenameGeneration(value)).toEqual({ ok: false, code: "incompatible-generation" });
    }
  });
  it("strictly validates hello and ack", () => {
    expect(helloMessageSchema.safeParse(hello).success).toBe(true);
    expect(helloAckMessageSchema.safeParse(ack).success).toBe(true);
    for (const input of [
      { ...hello, type: "zcode-hello" },
      { ...hello, generation: undefined },
      { ...hello, generation: "2" },
      { ...hello, generation: 1 },
      { ...hello, pid: 0 },
      { ...hello, pid: -1 },
      { ...hello, pid: 1.5 },
      { ...hello, extra: true },
    ])
      expect(helloMessageSchema.safeParse(input).success).toBe(false);
    for (const input of [
      { ...ack, type: "zcode-hello-ack" },
      { ...ack, generation: undefined },
      { ...ack, generation: 1 },
      { ...ack, clientId: "" },
      { ...ack, extra: true },
    ])
      expect(helloAckMessageSchema.safeParse(input).success).toBe(false);
  });
});

it("exposes the new internal wire identities without changing the plugin sandbox contract", async () => {
  const {
    PlatformChannels,
    InternalChannels,
    PluginSandboxChannels,
    EmbeddedBrowserWebviewChannels,
    CodingPlanWebviewChannels,
    ZCODE_RPC_HOST_CAPABILITY_HEADER,
    ZCODE_PROTOCOL_NAME,
  } = await import("../src/index.js");
  expect(Object.values(PlatformChannels).every((value) => value.startsWith("zody:"))).toBe(true);
  expect(Object.values(InternalChannels).every((value) => value.startsWith("zody:"))).toBe(true);
  expect(EmbeddedBrowserWebviewChannels.WheelBoundary).toBe("zody:embedded-browser-wheel-boundary");
  expect(CodingPlanWebviewChannels.PurchaseComplete).toBe("zcode:coding-plan-purchase-complete");
  expect(PluginSandboxChannels.Init).toBe("zcode:plugin-sandbox-init");
  expect(ZCODE_RPC_HOST_CAPABILITY_HEADER).toBe("x-zody-rpc-host-capability");
  expect(ZCODE_PROTOCOL_NAME).toBe("Zody Protocol");
});
