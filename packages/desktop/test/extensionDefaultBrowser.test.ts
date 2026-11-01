import { describe, expect, it } from "vitest";
import { resolveExtensionDefaultBrowserId } from "../src/host/extensionDefaultBrowser.js";

describe("resolveExtensionDefaultBrowserId", () => {
  it("applies a window default only to desktop-continuous sessions", () => {
    expect(resolveExtensionDefaultBrowserId("extension:profile-1", "desktop-continuous")).toBe(
      "extension:profile-1",
    );
  });

  it("never leaks a desktop extension default into mobile replay", () => {
    expect(
      resolveExtensionDefaultBrowserId("extension:profile-1", "web-remote-replayable"),
    ).toBeUndefined();
  });

  it("keeps the IAB default when the window has no explicit backend", () => {
    expect(resolveExtensionDefaultBrowserId(undefined, "desktop-continuous")).toBeUndefined();
  });
});
