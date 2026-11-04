import { describe, expect, it } from "vitest";
import { ZODY_AGENT_RUNTIME } from "@zody/shared";

describe("ZCode Agent runtime", () => {
  it("starts the private ZCode Protocol server instead of the retired ZCode Agent command", () => {
    const retiredProtocolName = `${"a"}${"cp"}`;

    expect(ZODY_AGENT_RUNTIME.spawnArgs).toEqual(["app-server", "--stdio"]);
    expect(ZODY_AGENT_RUNTIME.spawnArgs).not.toContain(retiredProtocolName);
  });

  it("uses the ZCode Agent binary name", () => {
    expect(ZODY_AGENT_RUNTIME.resolveEntrySegments("darwin")).toEqual(["zcode-agent"]);
    expect(ZODY_AGENT_RUNTIME.resolveEntrySegments("win32")).toEqual(["zcode-agent.exe"]);
  });
});
