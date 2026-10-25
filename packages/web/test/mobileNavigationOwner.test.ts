import { describe, expect, it } from "vitest";
import { createMobileNavigationOwner } from "../src/mobile-remote/mobileNavigationOwner.js";

describe("bootstrap navigation owner", () => {
  it("only acknowledges the current navigation once across Root reconstruction", () => {
    const owner = createMobileNavigationOwner();
    const a = owner.begin({ workspaceKey: "a", intent: "chat" });
    const b = owner.begin({ workspaceKey: "b", intent: "files" });
    expect(owner.isCurrent(a.id)).toBe(false);
    expect(owner.acknowledge(a.id)).toBeUndefined();
    expect(owner.peek()).toEqual(b);
    expect(owner.acknowledge(b.id)).toEqual(b);
    expect(owner.acknowledge(b.id)).toBeUndefined();
  });
  it("invalidates pending targets when connection ends", () => {
    const owner = createMobileNavigationOwner();
    const a = owner.begin({ workspaceKey: "a", intent: "chat" });
    owner.clear();
    expect(owner.isCurrent(a.id)).toBe(false);
  });
});
