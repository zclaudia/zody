import { describe, expect, it } from "vitest";
import {
  formatZCodeAgentProcessName,
  formatZCodeHostProcessName,
  formatZCodeMainProcessName,
  formatZCodeRendererProcessName,
  formatZCodeUtilityProcessName,
} from "../src/process-names.js";

describe("process names", () => {
  it("uses the zody prefix for every process kind", () => {
    expect(formatZCodeMainProcessName()).toBe("zody-main");
    expect(formatZCodeHostProcessName("local-1")).toBe("zody-host-local-1");
    expect(formatZCodeAgentProcessName("glm", "/Users/alice/demo")).toBe("zody-agent-glm-demo");
    expect(formatZCodeUtilityProcessName("network")).toBe("zody-utility-network");
  });

  it("recognizes the main window by the current product title", () => {
    expect(formatZCodeRendererProcessName("Zody")).toBe("zody-renderer-main");
    expect(formatZCodeRendererProcessName("Zody Preview")).toBe("zody-renderer-main");
    expect(formatZCodeRendererProcessName(undefined)).toBe("zody-renderer-main");
    expect(formatZCodeRendererProcessName("Resource Manager")).toBe(
      "zody-renderer-resource-manager",
    );
  });

  it("recognizes remote windows by the `Zody - ` title prefix", () => {
    expect(formatZCodeRendererProcessName("Zody - devbox")).toBe("zody-renderer-remote-devbox");
    expect(formatZCodeRendererProcessName("ZCode")).toBe("zody-renderer-zcode");
  });
});
