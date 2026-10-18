import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// fork（F4.3）：offPeakTaskListSource / offPeakNewTaskEntrySource（已删文件）随闲时任务全链路移除。
const [
  automationsSectionSource,
  automationDesignPrimitivesSource,
] = await Promise.all([
  readFile(
    new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/settings/AutomationDesignPrimitives.tsx", import.meta.url),
    "utf8",
  ),
]);

describe("automation card border tokens", () => {
  it("aligns homepage and automation cards to the Card Border semantic token", () => {
    expect(automationsSectionSource).toContain(
      "rounded-xl border border-card-border bg-background",
    );
    expect(automationsSectionSource).toContain(
      "rounded-2xl border border-card-border bg-background",
    );
    expect(automationDesignPrimitivesSource).toContain(
      "rounded-xl border border-dashed border-card-border bg-background",
    );
  });

  it("does not use weaker surface borders or inset shadows for automation cards", () => {
    expect(automationsSectionSource).not.toContain(
      "rounded-xl border border-surface bg-background",
    );
    expect(automationsSectionSource).not.toContain(
      "rounded-2xl border border-surface bg-background",
    );
    expect(automationDesignPrimitivesSource).not.toContain(
      '"border border-surface bg-background"',
    );
  });
});
