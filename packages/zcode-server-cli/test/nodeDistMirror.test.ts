import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_DIST_BASE, resolveNodeDistBase } from "../src/packaging/nodeDistMirror.js";

describe("resolveNodeDistBase", () => {
  it("defaults to the official Node.js dist host", () => {
    expect(DEFAULT_NODE_DIST_BASE).toBe("https://nodejs.org/dist");
    expect(resolveNodeDistBase({})).toBe("https://nodejs.org/dist");
    expect(resolveNodeDistBase({ ZCODE_NODE_DIST_MIRROR: "   " })).toBe("https://nodejs.org/dist");
  });

  it("uses an explicit mirror override and trims trailing slashes", () => {
    expect(
      resolveNodeDistBase({ ZCODE_NODE_DIST_MIRROR: " https://cdn.npmmirror.com/binaries/node/ " }),
    ).toBe("https://cdn.npmmirror.com/binaries/node");
  });
});
