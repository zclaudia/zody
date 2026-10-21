import { describe, expect, it } from "vitest";
import { getRecommendedPromptPool } from "@/v4/featureSuggestedPrompts.js";

describe("feature suggested prompts", () => {
  it("omits unavailable system Computer Use while retaining embedded Browser Use", () => {
    const prompts = getRecommendedPromptPool(true);
    const serialized = JSON.stringify(prompts);

    expect(serialized).not.toContain("computer-use@zcode-plugins-official");
    expect(serialized).toContain("browser-use@zcode-plugins-official");
  });
});
