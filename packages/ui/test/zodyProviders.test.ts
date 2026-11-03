import { describe, expect, it } from "vitest";
import {
  shouldHideZodySessionForkAction,
  supportsZodySessionFork,
} from "../src/lib/zodyProviders.js";

describe("supportsZCodeSessionFork", () => {
  it("所有 provider 都开放 session fork 入口", () => {
    expect(supportsZodySessionFork("glm")).toBe(true);
    expect(supportsZodySessionFork("claude")).toBe(true);
    expect(supportsZodySessionFork("codex")).toBe(true);
    expect(supportsZodySessionFork("gemini")).toBe(true);
    expect(supportsZodySessionFork("opencode")).toBe(true);
  });
});

describe("shouldHideZCodeSessionForkAction", () => {
  it("所有 provider 都不再隐藏 fork UI 入口", () => {
    expect(shouldHideZodySessionForkAction("glm")).toBe(false);
    expect(shouldHideZodySessionForkAction("claude")).toBe(false);
    expect(shouldHideZodySessionForkAction("codex")).toBe(false);
    expect(shouldHideZodySessionForkAction("gemini")).toBe(false);
    expect(shouldHideZodySessionForkAction("opencode")).toBe(false);
  });
});
