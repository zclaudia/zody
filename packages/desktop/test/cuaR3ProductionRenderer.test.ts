import { describe, expect, it } from "vitest";
import {
  R3_PRODUCTION_RENDERER_SPEC,
  usesR3ProductionRendererPreflight,
} from "./e2e/helpers/cua-r3-production-renderer.js";
const base = {
  specs: [
    `/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/${R3_PRODUCTION_RENDERER_SPEC}`,
  ],
  packagedApp:
    "/repo/output/cua-r3-normal-host-20261115/run-slot/mac-arm64/Zody CUA Normal Host Candidate.app/Contents/MacOS/Zody CUA Normal Host Candidate",
  cwd: "/private/tmp/controlled-r3",
  repoRoot: "/repo",
  platform: "darwin",
};
describe("R3 production renderer readiness scope", () => {
  it("keeps normal cases on the existing store-bridge preflight", () =>
    expect(
      usesR3ProductionRendererPreflight({ ...base, specs: ["/repo/test/ordinary.test.ts"] }),
    ).toBe(false));
  it("admits only the isolated candidate outside the repository", () =>
    expect(usesR3ProductionRendererPreflight(base)).toBe(true));
  it("accepts WDIO file URLs only after canonical path normalization", () => {
    expect(usesR3ProductionRendererPreflight({ ...base, specs: [`file://${base.specs[0]}`] })).toBe(
      true,
    );
  });
  it("admits the exact formal-identity case only at its independent run slot", () => {
    expect(
      usesR3ProductionRendererPreflight({
        ...base,
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-cua-r3-formal-local.test.ts",
        ],
        packagedApp:
          "/repo/output/cua-r3-formal-local-20261116/run-slot/mac-arm64/Zody.app/Contents/MacOS/Zody",
      }),
    ).toBe(true);
  });
  it("never borrows the earlier candidate scope for the formal-identity case", () => {
    expect(() =>
      usesR3ProductionRendererPreflight({
        ...base,
        specs: [
          "/repo/packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-cua-r3-formal-local.test.ts",
        ],
      }),
    ).toThrow("single exact spec/candidate");
  });
  it.each([
    { packagedApp: "/Applications/Zody.app/Contents/MacOS/Zody" },
    { packagedApp: null },
    { specs: [`/other/${R3_PRODUCTION_RENDERER_SPEC}`] },
    { cwd: "/repo/packages/desktop" },
    { specs: [...base.specs, "/repo/test/ordinary.test.ts"] },
    { platform: "linux" },
  ])("rejects a wrong readiness scope: %j", (change) =>
    expect(() => usesR3ProductionRendererPreflight({ ...base, ...change })).toThrow(
      "single exact spec/candidate",
    ),
  );
});
