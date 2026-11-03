import { describe, expect, it } from "vitest";
import {
  formatZodyAgentProcessName,
  formatZodyHostProcessName,
  formatZodyMainProcessName,
  formatZodyRendererProcessName,
  formatZodyUtilityProcessName,
} from "../src/process-names.js";

describe("process names", () => {
  it("uses the zody prefix for every process kind", () => {
    expect(formatZodyMainProcessName()).toBe("zody-main");
    expect(formatZodyHostProcessName("local-1")).toBe("zody-host-local-1");
    expect(formatZodyAgentProcessName("glm", "/Users/alice/demo")).toBe("zody-agent-glm-demo");
    expect(formatZodyUtilityProcessName("network")).toBe("zody-utility-network");
  });

  it("recognizes the main window by the current product title", () => {
    expect(formatZodyRendererProcessName("Zody")).toBe("zody-renderer-main");
    expect(formatZodyRendererProcessName("Zody Preview")).toBe("zody-renderer-main");
    expect(formatZodyRendererProcessName(undefined)).toBe("zody-renderer-main");
    expect(formatZodyRendererProcessName("Resource Manager")).toBe(
      "zody-renderer-resource-manager",
    );
  });

  it("recognizes remote windows by the `Zody - ` title prefix", () => {
    expect(formatZodyRendererProcessName("Zody - devbox")).toBe("zody-renderer-remote-devbox");
    expect(formatZodyRendererProcessName("ZCode")).toBe("zody-renderer-zcode");
  });
});
